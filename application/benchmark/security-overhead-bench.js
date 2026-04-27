#!/usr/bin/env node
/**
 * benchmark/security-overhead-bench.js
 * 보안 개선 항목별 암호 연산 오버헤드 측정 벤치마크
 *
 * Fabric 네트워크 없이 단독 실행 가능 (암호 연산만 측정)
 *
 * 측정 항목:
 *   CRIT-03: Nullifier 연산 (기존 SHA256×2 → 개선 SHA256×3)
 *   CRIT-01/02: Transient credentialVerification 직렬화 + SHA256 오버헤드
 *   MED-06: Cache _cacheGet 만료 체크 오버헤드
 *   HIGH-05: Shamir share commitment SHA256 (InitKeySharing, SubmitKeyShare 각 3회)
 *   AUTH: HMAC-SHA256 자격증명 검증 vs bypass
 *
 * 사용법: node benchmark/security-overhead-bench.js [--iter 50000]
 */

'use strict';

const crypto = require('crypto');

const args = {};
process.argv.slice(2).forEach((a, i, arr) => {
  if (a.startsWith('--')) args[a.slice(2)] = arr[i + 1];
});

const ITER = parseInt(args.iter || '100000', 10);
const WARMUP = Math.floor(ITER / 10);

// ── 유틸 ───────────────────────────────────────────────────────
function sha256hex(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

function sha256buf(buf) {
  return crypto.createHash('sha256').update(buf).digest();
}

function bench(label, fn, iter = ITER) {
  // Warmup
  for (let i = 0; i < WARMUP; i++) fn(i);

  const t0 = process.hrtime.bigint();
  for (let i = 0; i < iter; i++) fn(i);
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6; // ms

  return {
    label,
    iter,
    totalMs:  +elapsed.toFixed(3),
    avgUs:    +(elapsed / iter * 1000).toFixed(3),  // microseconds
    perSecK:  +(iter / elapsed * 1000 / 1000).toFixed(1), // K ops/sec
  };
}

// ── 결과 출력 ──────────────────────────────────────────────────
function printTable(title, rows) {
  console.log(`\n${'─'.repeat(80)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(80));
  const cols = ['항목', '반복수', '총시간(ms)', '평균(μs)', 'K ops/s', '오버헤드'];
  const w    = [32, 9, 12, 10, 10, 14];
  const row  = cells => '  ' + cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  console.log(row(cols));
  console.log('  ' + '─'.repeat(76));

  let baseAvg = null;
  rows.forEach((r, idx) => {
    const overhead = (baseAvg !== null && r.avgUs !== undefined)
      ? `+${(r.avgUs - baseAvg).toFixed(3)} μs`
      : idx === 0 ? '(기준선)' : '';
    if (idx === 0 && r.avgUs !== undefined) baseAvg = r.avgUs;
    console.log(row([
      r.label,
      r.iter?.toLocaleString() ?? '-',
      r.totalMs?.toFixed(3) ?? '-',
      r.avgUs?.toFixed(3) ?? '-',
      r.perSecK ?? '-',
      overhead,
    ]));
  });
}

// ═══════════════════════════════════════════════════════════════
// CRIT-03: Nullifier 연산 오버헤드
// 기존: SHA256(voterSecret + electionID)
// 개선: SHA256(voterSecret + electionID + blindingFactor)
// ═══════════════════════════════════════════════════════════════
function benchCrit03() {
  const voterSecret   = crypto.randomBytes(32).toString('hex');
  const electionID    = 'ELECTION_2026_PRESIDENT';
  const blindingFactor = crypto.randomBytes(32).toString('hex'); // 공개 원장에서 조회

  const before = bench('BEFORE: SHA256(secret+electionID)', () => {
    sha256hex(voterSecret + electionID);
  });

  const after = bench('AFTER:  SHA256(secret+electionID+blind)', () => {
    sha256hex(voterSecret + electionID + blindingFactor);
  });

  // 추가 오버헤드: API에서 blindingFactor를 fetch하는 비용은 제외 (네트워크 종속)
  // 순수 암호 연산 오버헤드만 측정
  printTable('CRIT-03: Nullifier 블라인딩 팩터 추가 오버헤드', [before, after]);
  return { before, after };
}

// ═══════════════════════════════════════════════════════════════
// CRIT-01/02: credentialVerification transient 직렬화 오버헤드
// CastVote 요청 시 추가되는 JSON 직렬화 + credHash 계산
// ═══════════════════════════════════════════════════════════════
function benchCrit0102() {
  const credHeader = crypto.randomBytes(128).toString('base64url'); // 실제 자격증명 토큰 크기
  const electionID = 'ELECTION_2026_PRESIDENT';

  const before = bench('BEFORE: 기본 votePrivate transient 직렬화', () => {
    const votePrivate = {
      docType: 'votePrivate',
      voterID: 'anonymous',
      electionID,
      candidateID: 'CANDIDATE_A',
      nullifierHash: sha256hex('voterSecret' + electionID),
      voteHash: sha256hex('vote|CANDIDATE_A|' + Date.now()),
    };
    Buffer.from(JSON.stringify(votePrivate));
  });

  const after = bench('AFTER:  +credentialVerification transient 추가', () => {
    const votePrivate = {
      docType: 'votePrivate',
      voterID: 'anonymous',
      electionID,
      candidateID: 'CANDIDATE_A',
      nullifierHash: sha256hex('voterSecret' + electionID),
      voteHash: sha256hex('vote|CANDIDATE_A|' + Date.now()),
    };
    // [CRIT-01/02 FIX] 추가 연산
    const credHash = sha256hex(credHeader); // SHA256(credential)
    const credVerification = {
      credType: 'hmac',
      electionID,
      expUnix: Math.floor(Date.now() / 1000) + 3600,
      credHash,
    };
    Buffer.from(JSON.stringify(votePrivate));
    Buffer.from(JSON.stringify(credVerification));
  });

  printTable('CRIT-01/02: Transient credentialVerification 직렬화 오버헤드', [before, after]);
  return { before, after };
}

// ═══════════════════════════════════════════════════════════════
// MED-06: Cache _cacheGet 만료 체크 오버헤드
// 기존: ts 비교만
// 개선: ts 비교 + expUnix 비교
// ═══════════════════════════════════════════════════════════════
function benchMed06() {
  const now = Date.now();
  const expUnix = Math.floor(now / 1000) + 3600; // 1시간 후 만료

  const entryBefore = { result: { eligible: true, mspId: 'ElectionCommissionMSP' }, ts: now };
  const entryAfter  = { result: { eligible: true, mspId: 'ElectionCommissionMSP', expUnix }, ts: now };
  const CACHE_TTL_MS_BEFORE = 30000;
  const CACHE_TTL_MS_AFTER  = 5000;

  const before = bench('BEFORE: TTL=30s, ts 비교만', () => {
    const entry = entryBefore;
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS_BEFORE) return null;
    return entry.result;
  });

  const after = bench('AFTER:  TTL=5s, ts+expUnix 이중 체크', () => {
    const entry = entryAfter;
    if (!entry) return null;
    if (Date.now() - entry.ts > CACHE_TTL_MS_AFTER) return null;
    // [MED-06 FIX] 추가 체크
    if (entry.result.expUnix && Math.floor(Date.now() / 1000) > entry.result.expUnix) return null;
    return entry.result;
  });

  printTable('MED-06: Cache _cacheGet 만료 이중 체크 오버헤드', [before, after]);
  return { before, after };
}

// ═══════════════════════════════════════════════════════════════
// HIGH-05: Feldman VSS commitment 연산 오버헤드
// InitKeySharing: SHA256(share_i) × 3
// SubmitKeyShare: hex.decode + SHA256 + hex.compare
// ═══════════════════════════════════════════════════════════════
function benchHigh05() {
  // 32바이트 share × 3 (Shamir 3개 조직)
  const shares = [
    crypto.randomBytes(32),
    crypto.randomBytes(32),
    crypto.randomBytes(32),
  ];
  const shareHexes = shares.map(s => s.toString('hex'));

  const before = bench('BEFORE: InitKeySharing (PDC 저장만)', () => {
    // PDC PutPrivateData는 네트워크 호출이므로 직렬화만 측정
    for (const s of shares) {
      s.toString('hex'); // hex 인코딩
    }
  });

  const after = bench('AFTER:  +SHA256 commitment × 3 (Feldman VSS)', () => {
    for (const s of shares) {
      s.toString('hex');
      // [HIGH-05 FIX] commitment 생성
      sha256buf(s).toString('hex');
    }
  });

  // SubmitKeyShare 검증 오버헤드
  const shareCommitments = shares.map(s => sha256buf(s).toString('hex'));
  const submitIdx = 0;
  const submitHex = shareHexes[submitIdx];

  const submitBefore = bench('BEFORE: SubmitKeyShare (중복 체크만)', () => {
    const submitted = ['1']; // 이미 제출된 목록
    submitted.includes('2'); // 중복 체크
  });

  const submitAfter = bench('AFTER:  +PDC 검증 + commitment SHA256 (SubmitKeyShare)', () => {
    const submitted = ['1'];
    submitted.includes('2');
    // [HIGH-05 FIX] 추가 연산 (PDC GetPrivateData는 네트워크 제외, 로컬 연산만)
    // 1) 값 비교
    submitHex === shareHexes[submitIdx]; // string compare
    // 2) SHA256 재계산 + commitment 비교
    const shareBytes = Buffer.from(submitHex, 'hex');
    const computed   = sha256buf(shareBytes).toString('hex');
    computed === shareCommitments[submitIdx];
  });

  printTable('HIGH-05: Feldman VSS commitment 오버헤드 (InitKeySharing)', [before, after]);
  printTable('HIGH-05: Feldman VSS commitment 오버헤드 (SubmitKeyShare)', [submitBefore, submitAfter]);
  return { initBefore: before, initAfter: after, submitBefore, submitAfter };
}

// ═══════════════════════════════════════════════════════════════
// 인증 방식별 검증 레이턴시 비교
// bypass / HMAC-SHA256 / Ed25519 검증
// ═══════════════════════════════════════════════════════════════
function benchAuth() {
  const secret = 'mongbas-idemix-secret-CHANGE-IN-PROD';

  // HMAC 토큰 생성 (1회)
  const payload = {
    voterEligible: '1',
    electionID: 'ELECTION_2026_PRESIDENT',
    exp: Date.now() + 3600000,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('base64url');
  const hmacToken = `${payloadB64}.${sig}`;

  // Ed25519 키쌍 생성
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const header = { alg: 'EdDSA' };
  const headerB64  = Buffer.from(JSON.stringify(header)).toString('base64url');
  const ed25519Sig = crypto.sign(null, Buffer.from(`${headerB64}.${payloadB64}`), privateKey);
  const ed25519Token = `${headerB64}.${payloadB64}.${ed25519Sig.toString('base64url')}`;

  const bypass = bench('A단계 bypass (인증 없음)', () => {
    // bypass: 단순 true 반환
    return { eligible: true };
  });

  const hmac = bench('B단계 HMAC-SHA256 검증', () => {
    const dotIdx = hmacToken.lastIndexOf('.');
    const pB64   = hmacToken.slice(0, dotIdx);
    const s      = hmacToken.slice(dotIdx + 1);
    const expected = crypto.createHmac('sha256', secret).update(pB64).digest('base64url');
    const sigBuf   = Buffer.from(s,        'base64url');
    const expBuf   = Buffer.from(expected, 'base64url');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return false;
    const p = JSON.parse(Buffer.from(pB64, 'base64url').toString());
    return Date.now() < p.exp && p.voterEligible === '1';
  });

  const ed25519 = bench('C단계 Ed25519 검증', () => {
    const parts = ed25519Token.split('.');
    const [hB64, pB64, sB64] = parts;
    const msg    = Buffer.from(`${hB64}.${pB64}`);
    const sigBuf = Buffer.from(sB64, 'base64url');
    const pubObj = crypto.createPublicKey({ key: publicKey.export({ type: 'spki', format: 'der' }), format: 'der', type: 'spki' });
    return crypto.verify(null, msg, pubObj, sigBuf);
  }, Math.min(ITER, 20000)); // Ed25519는 상대적으로 느리므로 제한

  printTable('인증 방식별 검증 레이턴시 (A/B/C단계)', [bypass, hmac, ed25519]);
  return { bypass, hmac, ed25519 };
}

// ═══════════════════════════════════════════════════════════════
// 종합 요약
// ═══════════════════════════════════════════════════════════════
function printSummary(results) {
  console.log(`\n${'═'.repeat(80)}`);
  console.log('  종합 보안 개선 오버헤드 요약');
  console.log('═'.repeat(80));

  const items = [
    {
      fix: 'CRIT-03',
      desc: 'Nullifier 블라인딩 팩터',
      before: results.crit03.before.avgUs,
      after:  results.crit03.after.avgUs,
    },
    {
      fix: 'CRIT-01/02',
      desc: 'Transient credHash 계산',
      before: results.crit0102.before.avgUs,
      after:  results.crit0102.after.avgUs,
    },
    {
      fix: 'MED-06',
      desc: 'Cache 만료 이중 체크',
      before: results.med06.before.avgUs,
      after:  results.med06.after.avgUs,
    },
    {
      fix: 'HIGH-05 Init',
      desc: 'Shamir commitment × 3',
      before: results.high05.initBefore.avgUs,
      after:  results.high05.initAfter.avgUs,
    },
    {
      fix: 'HIGH-05 Submit',
      desc: 'Share SHA256 + 비교',
      before: results.high05.submitBefore.avgUs,
      after:  results.high05.submitAfter.avgUs,
    },
  ];

  const w = [14, 28, 12, 12, 14, 10];
  const cols = ['개선항목', '설명', 'Before(μs)', 'After(μs)', '오버헤드(μs)', '증가율(%)'];
  const row = cells => '  ' + cells.map((c, i) => String(c).padEnd(w[i])).join('  ');

  console.log(row(cols));
  console.log('  ' + '─'.repeat(76));
  items.forEach(item => {
    const delta   = item.after - item.before;
    const deltaPct = (delta / item.before * 100);
    const sign    = delta >= 0 ? '+' : '';
    console.log(row([
      item.fix,
      item.desc,
      item.before.toFixed(3),
      item.after.toFixed(3),
      `${sign}${delta.toFixed(3)}`,
      `${sign}${deltaPct.toFixed(1)}%`,
    ]));
  });

  console.log('\n  ※ 참고:');
  console.log('    - MED-07 (Panic Password 서버 코드 제거): 코드 제거이므로 성능 향상 효과');
  console.log('    - MED-08 (PDC memberOnlyWrite): 설정 파라미터 변경, 런타임 오버헤드 없음');
  console.log(`    - 측정 환경: Node.js ${process.version}, CPU ${require('os').cpus()[0]?.model?.trim()}`);
  console.log(`    - 반복 횟수: ${ITER.toLocaleString()}회 (워밍업 ${WARMUP.toLocaleString()}회 제외)`);

  // Auth 방식 비교
  const { bypass, hmac, ed25519 } = results.auth;
  console.log('\n  [인증 방식별 오버헤드]');
  console.log(`    A단계 bypass   : ${bypass.avgUs.toFixed(3)} μs (기준선)`);
  console.log(`    B단계 HMAC     : ${hmac.avgUs.toFixed(3)} μs  (+${(hmac.avgUs - bypass.avgUs).toFixed(3)} μs, +${((hmac.avgUs - bypass.avgUs) / bypass.avgUs * 100).toFixed(0)}%)`);
  console.log(`    C단계 Ed25519  : ${ed25519.avgUs.toFixed(3)} μs  (+${(ed25519.avgUs - bypass.avgUs).toFixed(3)} μs, +${((ed25519.avgUs - bypass.avgUs) / bypass.avgUs * 100).toFixed(0)}%)`);
  console.log('═'.repeat(80));
}

// ── 메인 ───────────────────────────────────────────────────────
async function main() {
  console.log('\n' + '═'.repeat(80));
  console.log('  팀 몽바스 — 보안 개선 암호 연산 오버헤드 벤치마크');
  console.log(`  반복 횟수: ${ITER.toLocaleString()}회 / 워밍업: ${WARMUP.toLocaleString()}회`);
  console.log(`  Node.js: ${process.version} | 플랫폼: ${process.platform}`);
  console.log('═'.repeat(80));

  const results = {};
  results.crit03  = benchCrit03();
  results.crit0102 = benchCrit0102();
  results.med06   = benchMed06();
  results.high05  = benchHigh05();
  results.auth    = benchAuth();

  printSummary(results);

  // JSON 저장
  const fs   = require('fs');
  const path = require('path');
  const dir  = path.join(__dirname, '..', 'benchmark-reports');
  fs.mkdirSync(dir, { recursive: true });
  const fname = path.join(dir, `security-overhead-${Date.now()}.json`);
  fs.writeFileSync(fname, JSON.stringify({
    meta: {
      nodeVersion: process.version,
      platform: process.platform,
      cpu: require('os').cpus()[0]?.model?.trim(),
      iterations: ITER,
      timestamp: new Date().toISOString(),
    },
    results,
  }, null, 2));
  console.log(`\n  JSON 저장: ${fname}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
