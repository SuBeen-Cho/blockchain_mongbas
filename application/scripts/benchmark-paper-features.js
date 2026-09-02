#!/usr/bin/env node

'use strict';

/**
 * benchmark-paper-features.js — PAPER-1~8 기능별 성능 측정
 *
 * 논문 Section 7 (Performance Evaluation) 대응:
 *   - Latency breakdown: 각 보안 기능별 처리 시간
 *   - Crypto overhead: 암호화/검증 연산 비용
 *   - Helios/Belenios 비교를 위한 기준 데이터
 *
 * 사용법: node scripts/benchmark-paper-features.js
 * 전제: API 서버(port 3000)와 Fabric 네트워크 실행 중
 */

const crypto = require('crypto');
const { deriveLookupToken } = require('../src/lib/deniableProof');

const BASE_URL = (process.env.BENCH_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const ITERATIONS = parseInt(process.env.BENCH_ITERATIONS || '20', 10);
const ELECTION_ID = `bench-paper-${Date.now()}`;
const CANDIDATES = ['CANDIDATE_A', 'CANDIDATE_B', 'CANDIDATE_C'];

function sha256Hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function encryptAESGCM(keyHex, plaintext) {
  const key = Buffer.from(keyHex, 'hex');
  const plain = Buffer.from(plaintext, 'utf8');
  const nonceInput = Buffer.concat([key, plain]);
  const nonceHash = crypto.createHash('sha256').update(nonceInput).digest();
  const nonce = nonceHash.subarray(0, 12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, encrypted, tag]).toString('hex');
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
  return { status: res.status, ok: res.ok, body };
}

// 시간 측정 헬퍼 (ms 단위)
async function measure(label, fn) {
  const start = performance.now();
  const result = await fn();
  const elapsed = performance.now() - start;
  if (result && typeof result.ok === 'boolean' && !result.ok) {
    throw new Error(`${label} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`);
  }
  return { label, elapsed, result };
}

function requireLegacyBenchmarkOptIn() {
  if (process.env.ALLOW_LEGACY_INSECURE_BENCHMARK !== 'true') {
    throw new Error(
      'legacy PAPER-1~8 benchmark is disabled: it uses bypass/plaintext/AES-era paths; ' +
      'use deploy/linux/rate-evaluation.sh for publishable vector-v3 results',
    );
  }
}

// 통계 계산
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    count: n,
    min: sorted[0],
    max: sorted[n - 1],
    avg: values.reduce((a, b) => a + b, 0) / n,
    p50: sorted[Math.floor(n * 0.5)],
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.floor(n * 0.99)],
  };
}

async function main() {
  requireLegacyBenchmarkOptIn();
  console.log('═══════════════════════════════════════════════════');
  console.log(' PAPER Features Performance Benchmark');
  console.log(`   Election: ${ELECTION_ID}`);
  console.log(`   Iterations: ${ITERATIONS}`);
  console.log(`   API: ${BASE_URL}`);
  console.log('═══════════════════════════════════════════════════\n');

  const results = {};

  // ── Setup: 선거 생성 + 활성화 ──────────────────────────────
  console.log('── Setup ──');
  const health = await requestJson('/health');
  if (!health.ok) throw new Error('API server not running');

  const endTime = Math.floor(Date.now() / 1000) + 7200;
  const created = await requestJson('/api/elections', {
    method: 'POST',
    body: JSON.stringify({
      electionID: ELECTION_ID,
      title: 'Benchmark Election',
      description: 'PAPER feature benchmarking',
      candidates: CANDIDATES,
      startTime: Math.floor(Date.now() / 1000),
      endTime,
    }),
  });
  if (!created.ok) throw new Error(`create election failed: HTTP ${created.status} ${JSON.stringify(created.body)}`);
  const activated = await requestJson(`/api/elections/${ELECTION_ID}/activate`, { method: 'POST' });
  if (!activated.ok) throw new Error(`activate election failed: HTTP ${activated.status} ${JSON.stringify(activated.body)}`);
  console.log('[OK] Election created and activated\n');

  // ── Benchmark 1: GetEncryptionKey (PAPER-1) ───────────────
  console.log('── [1] GetEncryptionKey Latency ──');
  const keyTimes = [];
  let encKeyHex = '';
  for (let i = 0; i < ITERATIONS; i++) {
    const m = await measure('getKey', () =>
      requestJson(`/api/elections/${ELECTION_ID}/encryption-key`)
    );
    keyTimes.push(m.elapsed);
    if (i === 0) encKeyHex = m.result.body.encryptionKeyHex || m.result.body.encryptionKey;
  }
  results['GetEncryptionKey'] = stats(keyTimes);
  console.log(`   avg=${results['GetEncryptionKey'].avg.toFixed(1)}ms p95=${results['GetEncryptionKey'].p95.toFixed(1)}ms\n`);

  // ── Benchmark 2: CastVote Legacy Mode ─────────────────────
  console.log('── [2] CastVote Legacy Mode Latency ──');
  const legacyTimes = [];
  const nullifiers = [];
  const deniableLookups = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const voterSecret = `bench-legacy-${i}-${Date.now()}`;
    const blinding = (await requestJson(`/api/elections/${ELECTION_ID}/blinding-factor`)).body.blindingFactor;
    const nullifierHash = sha256Hex(voterSecret + ELECTION_ID + blinding);
    const candidateID = CANDIDATES[i % CANDIDATES.length];
    const receipt = crypto.randomBytes(32).toString('hex');
    const normalLookupToken = deriveLookupToken(`normal-password-${i}`, receipt, ELECTION_ID);
    const panicLookupToken = deriveLookupToken(`panic-password-${i}`, receipt, ELECTION_ID);

    const m = await measure('castLegacy', () =>
      requestJson('/api/vote', {
        method: 'POST',
        body: JSON.stringify({
          electionID: ELECTION_ID,
          candidateID,
          nullifierHash,
          normalLookupToken,
          panicLookupToken,
          panicCandidateID: CANDIDATES[(i + 1) % CANDIDATES.length],
        }),
      })
    );
    legacyTimes.push(m.elapsed);
    nullifiers.push(nullifierHash);
    deniableLookups.push({ normalLookupToken, panicLookupToken });
  }
  results['CastVote_Legacy'] = stats(legacyTimes);
  console.log(`   avg=${results['CastVote_Legacy'].avg.toFixed(1)}ms p95=${results['CastVote_Legacy'].p95.toFixed(1)}ms\n`);

  // ── Benchmark 3: CastVote Blind Mode (PAPER-1) ────────────
  console.log('── [3] CastVote Blind Mode Latency ──');
  const blindTimes = [];
  const blindNullifiers = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const voterSecret = `bench-blind-${i}-${Date.now()}`;
    const blinding = (await requestJson(`/api/elections/${ELECTION_ID}/blinding-factor`)).body.blindingFactor;
    const nullifierHash = sha256Hex(voterSecret + ELECTION_ID + blinding);
    const candidateID = CANDIDATES[i % CANDIDATES.length];
    const encryptedCandidateID = encryptAESGCM(encKeyHex, candidateID);

    const m = await measure('castBlind', () =>
      requestJson('/api/vote', {
        method: 'POST',
        body: JSON.stringify({
          electionID: ELECTION_ID,
          encryptedCandidateID,
          nullifierHash,
        }),
      })
    );
    blindTimes.push(m.elapsed);
    blindNullifiers.push(nullifierHash);
  }
  results['CastVote_Blind'] = stats(blindTimes);
  console.log(`   avg=${results['CastVote_Blind'].avg.toFixed(1)}ms p95=${results['CastVote_Blind'].p95.toFixed(1)}ms\n`);

  // ── Benchmark 4: Benaloh Challenge (PAPER-3) ──────────────
  console.log('── [4] Benaloh Challenge Latency ──');
  const benalohPrepareTimes = [];
  const benalohAuditTimes = [];
  for (let i = 0; i < Math.min(ITERATIONS, 10); i++) {
    const cand = CANDIDATES[i % CANDIDATES.length];

    const mp = await measure('prepare', () =>
      requestJson('/api/vote/prepare', {
        method: 'POST',
        body: JSON.stringify({ electionID: ELECTION_ID, candidateID: cand }),
      })
    );
    benalohPrepareTimes.push(mp.elapsed);

    if (mp.result.ok && mp.result.body.ballotID) {
      const ma = await measure('audit', () =>
        requestJson('/api/vote/audit', {
          method: 'POST',
          body: JSON.stringify({ electionID: ELECTION_ID, ballotID: mp.result.body.ballotID }),
        })
      );
      benalohAuditTimes.push(ma.elapsed);
    }
  }
  results['Benaloh_Prepare'] = stats(benalohPrepareTimes);
  if (benalohAuditTimes.length > 0) results['Benaloh_Audit'] = stats(benalohAuditTimes);
  console.log(`   prepare avg=${results['Benaloh_Prepare'].avg.toFixed(1)}ms`);
  if (results['Benaloh_Audit']) console.log(`   audit   avg=${results['Benaloh_Audit'].avg.toFixed(1)}ms`);
  console.log();

  // ── Benchmark 5: CloseElection + TallyVotes (PAPER-2) ─────
  console.log('── [5] CloseElection + TallyVotes Latency ──');
  const closeM = await measure('close', () =>
    requestJson(`/api/elections/${ELECTION_ID}/close`, { method: 'POST' })
  );
  results['CloseElection_TallyVotes'] = { single: closeM.elapsed };
  console.log(`   close+tally=${closeM.elapsed.toFixed(1)}ms (${ITERATIONS * 2} votes tallied)\n`);

  // ── Benchmark 6: Merkle Tree Build + Proof ─────────────────
  console.log('── [6] Merkle Tree Build + Proof Latency ──');
  const merkleM = await measure('buildMerkle', () =>
    requestJson(`/api/elections/${ELECTION_ID}/merkle`, { method: 'POST' })
  );
  results['BuildMerkleTree'] = { single: merkleM.elapsed };
  console.log(`   buildMerkle=${merkleM.elapsed.toFixed(1)}ms`);

  const proofTimes = [];
  for (let i = 0; i < Math.min(ITERATIONS, nullifiers.length); i++) {
    const pm = await measure('getProof', () =>
      requestJson(`/api/elections/${encodeURIComponent(ELECTION_ID)}/proof/${nullifiers[i]}`)
    );
    proofTimes.push(pm.elapsed);
  }
  results['GetMerkleProof'] = stats(proofTimes);
  console.log(`   getMerkleProof avg=${results['GetMerkleProof'].avg.toFixed(1)}ms p95=${results['GetMerkleProof'].p95.toFixed(1)}ms\n`);

  // ── Benchmark 7: Shamir Key Sharing ────────────────────────
  console.log('── [7] Shamir Key Sharing Latency ──');
  const initKS = await measure('initKeySharing', () =>
    requestJson(`/api/elections/${ELECTION_ID}/keysharing`, { method: 'POST' })
  );
  results['InitKeySharing'] = { single: initKS.elapsed };
  console.log(`   initKeySharing=${initKS.elapsed.toFixed(1)}ms`);

  // Share 조회 + 제출
  for (const idx of ['1', '2']) {
    const shareRes = await requestJson(`/api/elections/${ELECTION_ID}/shares/${idx}`);
    if (shareRes.ok) {
      await requestJson(`/api/elections/${ELECTION_ID}/shares`, {
        method: 'POST',
        body: JSON.stringify({ shareIndex: idx, shareHex: shareRes.body.shareHex }),
      });
    }
  }
  const decStatus = (await requestJson(`/api/elections/${ELECTION_ID}/decryption`)).body;
  console.log(`   shamir restored=${decStatus?.restored || decStatus?.isDecrypted}\n`);

  // ── Benchmark 8: Deniable Verification (Panic Password) ───
  console.log('── [8] Deniable Verification Latency ──');
  const normalTimes = [];
  const panicTimes = [];
  for (let i = 0; i < Math.min(ITERATIONS, 10); i++) {
    const { normalLookupToken, panicLookupToken } = deniableLookups[i];

    const nm = await measure('normalProof', () =>
      requestJson(`/api/elections/${ELECTION_ID}/proof`, {
        method: 'POST',
        body: JSON.stringify({ lookupToken: normalLookupToken }),
      })
    );
    normalTimes.push(nm.elapsed);

    const pm = await measure('panicProof', () =>
      requestJson(`/api/elections/${ELECTION_ID}/proof`, {
        method: 'POST',
        body: JSON.stringify({ lookupToken: panicLookupToken }),
      })
    );
    panicTimes.push(pm.elapsed);
  }
  results['DeniableProof_Normal'] = stats(normalTimes);
  results['DeniableProof_Panic'] = stats(panicTimes);
  console.log(`   normal avg=${results['DeniableProof_Normal'].avg.toFixed(1)}ms`);
  console.log(`   panic  avg=${results['DeniableProof_Panic'].avg.toFixed(1)}ms`);
  console.log(`   timing diff=${Math.abs(results['DeniableProof_Normal'].avg - results['DeniableProof_Panic'].avg).toFixed(1)}ms (low = good)\n`);

  // ── Benchmark 9: PublishAuditData + VerifyTallyPublic (PAPER-6) ──
  console.log('── [9] Universal Verifiability Latency ──');
  const pubM = await measure('publishAudit', () =>
    requestJson(`/api/elections/${ELECTION_ID}/publish-audit`, { method: 'POST' })
  );
  results['PublishAuditData'] = { single: pubM.elapsed };
  console.log(`   publishAudit=${pubM.elapsed.toFixed(1)}ms`);

  const bbTimes = [];
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const bm = await measure('getBulletinBoard', () =>
      requestJson(`/api/elections/${ELECTION_ID}/bulletin-board`)
    );
    bbTimes.push(bm.elapsed);
  }
  results['GetBulletinBoard'] = stats(bbTimes);
  console.log(`   getBulletinBoard avg=${results['GetBulletinBoard'].avg.toFixed(1)}ms`);

  const verifyTimes = [];
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const vm = await measure('verifyPublic', () =>
      requestJson(`/api/elections/${ELECTION_ID}/verify-public`, { method: 'POST' })
    );
    verifyTimes.push(vm.elapsed);
  }
  results['VerifyTallyPublic'] = stats(verifyTimes);
  console.log(`   verifyPublic avg=${results['VerifyTallyPublic'].avg.toFixed(1)}ms\n`);

  // ── Benchmark 10: VerifyVoteCounted (PAPER-8) ──────────────
  console.log('── [10] Receipt-Free Verification Latency ──');
  const receiptFreeTimes = [];
  for (let i = 0; i < Math.min(ITERATIONS, 10); i++) {
    const rfm = await measure('voteCounted', () =>
      requestJson(`/api/elections/${ELECTION_ID}/vote-counted/${nullifiers[i]}`)
    );
    receiptFreeTimes.push(rfm.elapsed);
  }
  results['VerifyVoteCounted'] = stats(receiptFreeTimes);
  console.log(`   avg=${results['VerifyVoteCounted'].avg.toFixed(1)}ms p95=${results['VerifyVoteCounted'].p95.toFixed(1)}ms\n`);

  // ── Benchmark 11: SecurityProperties (PAPER-5) ─────────────
  console.log('── [11] SecurityProperties Query Latency ──');
  const spTimes = [];
  for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
    const sm = await measure('secProps', () =>
      requestJson('/api/elections/security-properties')
    );
    spTimes.push(sm.elapsed);
  }
  results['SecurityProperties'] = stats(spTimes);
  console.log(`   avg=${results['SecurityProperties'].avg.toFixed(1)}ms\n`);

  // ── 최종 요약 ──────────────────────────────────────────────
  console.log('═══════════════════════════════════════════════════');
  console.log(' BENCHMARK RESULTS SUMMARY');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Total votes: ${ITERATIONS * 2} (${ITERATIONS} legacy + ${ITERATIONS} blind)`);
  console.log('');
  console.log('  Operation                    Avg(ms)  P95(ms)  P99(ms)');
  console.log('  ─────────────────────────── ──────── ──────── ────────');

  const formatRow = (name, s) => {
    if (s.avg !== undefined) {
      console.log(`  ${name.padEnd(28)} ${s.avg.toFixed(1).padStart(7)}  ${s.p95.toFixed(1).padStart(7)}  ${s.p99.toFixed(1).padStart(7)}`);
    } else if (s.single !== undefined) {
      console.log(`  ${name.padEnd(28)} ${s.single.toFixed(1).padStart(7)}      -        -`);
    }
  };

  formatRow('GetEncryptionKey', results['GetEncryptionKey']);
  formatRow('CastVote (Legacy)', results['CastVote_Legacy']);
  formatRow('CastVote (Blind)', results['CastVote_Blind']);
  formatRow('Benaloh Prepare', results['Benaloh_Prepare']);
  if (results['Benaloh_Audit']) formatRow('Benaloh Audit', results['Benaloh_Audit']);
  formatRow('CloseElection+Tally', results['CloseElection_TallyVotes']);
  formatRow('BuildMerkleTree', results['BuildMerkleTree']);
  formatRow('GetMerkleProof', results['GetMerkleProof']);
  formatRow('InitKeySharing', results['InitKeySharing']);
  formatRow('DeniableProof (Normal)', results['DeniableProof_Normal']);
  formatRow('DeniableProof (Panic)', results['DeniableProof_Panic']);
  formatRow('PublishAuditData', results['PublishAuditData']);
  formatRow('GetBulletinBoard', results['GetBulletinBoard']);
  formatRow('VerifyTallyPublic', results['VerifyTallyPublic']);
  formatRow('VerifyVoteCounted', results['VerifyVoteCounted']);
  formatRow('SecurityProperties', results['SecurityProperties']);

  console.log('');
  console.log('  Key Insights:');
  console.log(`    Blind mode overhead: ${(results['CastVote_Blind'].avg - results['CastVote_Legacy'].avg).toFixed(1)}ms vs legacy`);
  console.log(`    Panic timing leak:   ${Math.abs(results['DeniableProof_Normal'].avg - results['DeniableProof_Panic'].avg).toFixed(1)}ms (≤5ms = safe)`);
  console.log('═══════════════════════════════════════════════════');

  // JSON 출력 (파일 저장용)
  const reportPath = `benchmark-reports/paper-bench-${Date.now()}.json`;
  const reportData = {
    timestamp: new Date().toISOString(),
    electionID: ELECTION_ID,
    iterations: ITERATIONS,
    totalVotes: ITERATIONS * 2,
    results,
  };
  const fs = require('fs');
  const dir = require('path').join(__dirname, '..', 'benchmark-reports');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const fullPath = require('path').join(dir, `paper-bench-${Date.now()}.json`);
  fs.writeFileSync(fullPath, JSON.stringify(reportData, null, 2));
  console.log(`\n[SAVED] ${fullPath}`);
}

main().catch((err) => {
  console.error(`[FAIL] ${err.message}`);
  process.exit(1);
});
