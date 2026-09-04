'use strict';
console.error('[UNSUPPORTED] scenario-suite2.js mislabels limited response shape as receipt-freeness and mixes legacy AES/dealer-share paths. Use the property-specific evaluators and standalone verifier corpus.');
process.exit(2);
/**
 * scenario-suite2.js — 고급/경쟁 시나리오 (P7 비판적 검증 2차)
 * 동시투표 race / 대량집계 / 보편검증 ZKP / 조각 중복·위조 / receipt-free / AES 레거시
 */
const crypto = require('crypto');
const { elgamalEncryptWithZKP } = require('../src/lib/elgamalVote');
const { computeCredentialBoundNullifier } = require('../src/lib/credentialBinding');
const B = (process.env.E2E_BASE_URL || process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function J(p, o = {}) {
  const { headers, ...r } = o;
  const x = await fetch(B + p, { headers: { 'Content-Type': 'application/json', ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}), ...(headers || {}) }, ...r });
  const t = await x.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  return { ok: x.ok, status: x.status, j, t };
}
async function ok(p, o) { const r = await J(p, o); if (!r.ok) throw new Error(`${p} → ${r.status} ${r.t.slice(0, 140)}`); return r.j; }
let pass = 0, fail = 0;
const A = (c, l) => { if (c) { pass++; console.log('  ✓ ' + l); } else { fail++; console.log('  ✗ FAIL: ' + l); } };

async function mkElection(cands) {
  const EID = 'SC2_' + crypto.randomBytes(4).toString('hex'); const now = Math.floor(Date.now() / 1e3);
  await ok('/api/elections', { method: 'POST', body: JSON.stringify({ electionID: EID, title: 'sc2', candidates: cands, encryptionMode: 'elgamal', endTime: now + 86400 }) });
  await ok(`/api/elections/${EID}/activate`, { method: 'POST' });
  const pub = (await ok(`/api/elections/${EID}/elgamal-pubkey`)).pubKey;
  const bf = (await ok(`/api/elections/${EID}/blinding-factor`)).blindingFactor;
  return { EID, pub, bf, cands };
}
async function cred(v, EID) { return ok('/api/credential/idemix', { method: 'POST', body: JSON.stringify({ enrollmentID: v, enrollmentSecret: `${v}pw`, electionID: EID }) }); }
async function castVote(E, voter, vs, idx) {
  const issued = await cred(voter, E.EID); const nh = computeCredentialBoundNullifier(issued.nullifierMaterial, E.EID, E.bf); const v = elgamalEncryptWithZKP(E.pub, idx, E.cands.length);
  const response = await J('/api/vote', { method: 'POST', headers: { 'x-idemix-credential': issued.credential }, body: JSON.stringify({ electionID: E.EID, encryptedCandidateID: v.encrypted, nullifierHash: nh, ballotValidityProof: JSON.stringify(v.proof) }) });
  return { ...response, nullifierHash: nh };
}
async function closeDecrypt(EID) {
  await ok(`/api/elections/${EID}/close`, { method: 'POST' });
  for (const i of ['1', '2']) { const s = await ok(`/api/elections/${EID}/shares/${i}`); await ok(`/api/elections/${EID}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: i, shareHex: s.shareHex }) }); }
  return ok(`/api/elections/${EID}/tally`);
}

(async () => {
  console.log('=== 고급 시나리오 검증 ===');

  // S7: 대량 집계 (25표) — BSGS 상한 수정 확인
  console.log('[S7] 대량 집계 (25표, 3후보)');
  {
    const E = await mkElection(['A', 'B', 'C']);
    const dist = []; for (let i = 0; i < 25; i++) dist.push(i % 3);
    const r = await ok(`/api/elections/${E.EID}/seed-votes`, { method: 'POST', body: JSON.stringify({ count: 25, dist }) });
    const t = await closeDecrypt(E.EID);
    const sum = Object.values(t.results).reduce((a, b) => a + b, 0);
    A(t.decrypted && sum === 25, `25표 정확 복호화 (합계 ${sum}, ${JSON.stringify(t.results)})`);
  }

  // S8: 동시 투표 (race) — 10명 동시 제출
  console.log('[S8] 동시 투표 race (10 동시)');
  {
    const E = await mkElection(['A', 'B']);
    const jobs = [];
    for (let i = 0; i < 10; i++) jobs.push(castVote(E, `demo${String(i + 1).padStart(3, '0')}`, crypto.randomBytes(32).toString('hex'), i % 2));
    const rs = await Promise.all(jobs);
    const okN = rs.filter((r) => r.ok).length;
    A(okN === 10, `10건 동시 제출 모두 성공 (성공 ${okN}/10)`);
    const t = await closeDecrypt(E.EID);
    const sum = Object.values(t.results).reduce((a, b) => a + b, 0);
    A(sum === 10, `동시 투표 10표 모두 집계 (합계 ${sum})`);
  }

  // S9: 보편 검증 (verify-elgamal ZKP)
  console.log('[S9] 보편 검증 (ZKP)');
  {
    const E = await mkElection(['A', 'B', 'C']);
    await ok(`/api/elections/${E.EID}/seed-votes`, { method: 'POST', body: JSON.stringify({ count: 6 }) });
    await closeDecrypt(E.EID);
    await ok(`/api/elections/${E.EID}/publish-audit`, { method: 'POST' });
    const r = await J(`/api/elections/${E.EID}/verify-elgamal`, { method: 'POST' });
    A(r.ok && (r.j.isValid === true || r.j.verified === true || r.j.failed === 0), `ZKP 집계검증 통과 (${JSON.stringify(r.j).slice(0, 80)})`);
  }

  // S10: 조각 중복 제출 거부
  console.log('[S10] 조각 중복 제출 거부');
  {
    const E = await mkElection(['A', 'B']);
    await castVote(E, 'voter1', crypto.randomBytes(32).toString('hex'), 0);
    await ok(`/api/elections/${E.EID}/close`, { method: 'POST' });
    const s1 = await ok(`/api/elections/${E.EID}/shares/1`);
    await ok(`/api/elections/${E.EID}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: '1', shareHex: s1.shareHex }) });
    const dup = await J(`/api/elections/${E.EID}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: '1', shareHex: s1.shareHex }) });
    A(!dup.ok, `같은 조각 중복 제출 거부됨 (status ${dup.status})`);
  }

  // S11: 위조 조각 거부
  console.log('[S11] 위조 조각 거부');
  {
    const E = await mkElection(['A', 'B']);
    await castVote(E, 'voter1', crypto.randomBytes(32).toString('hex'), 0);
    await ok(`/api/elections/${E.EID}/close`, { method: 'POST' });
    const bad = await J(`/api/elections/${E.EID}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: '1', shareHex: 'deadbeef'.repeat(8) }) });
    A(!bad.ok, `위조 조각(임의 hex) 거부됨 (status ${bad.status})`);
  }

  // S12: receipt-free (vote-counted는 included만)
  console.log('[S12] receipt-free 확인');
  {
    const E = await mkElection(['A', 'B']);
    const vote = await castVote(E, 'voter1', '', 0); const nh = vote.nullifierHash;
    await closeDecrypt(E.EID);
    const r = await ok(`/api/elections/${E.EID}/vote-counted/${nh}`);
    const keys = Object.keys(r);
    A(r.included === true && !('candidateID' in r) && !('results' in r), `included만 노출, 후보/결과 없음 (keys: ${keys.join(',')})`);
  }

  // S13: AES 레거시 모드 종료 즉시 복호화
  console.log('[S13] AES 레거시 종료 즉시 복호화');
  {
    const EID = 'SC2AES_' + crypto.randomBytes(4).toString('hex'); const now = Math.floor(Date.now() / 1e3);
    await ok('/api/elections', { method: 'POST', body: JSON.stringify({ electionID: EID, title: 'aes', candidates: ['A', 'B'], encryptionMode: 'aes', endTime: now + 86400 }) });
    await ok(`/api/elections/${EID}/activate`, { method: 'POST' });
    const c = await cred('voter1', EID); const nh = sha('aesvs' + EID);
    await ok('/api/vote', { method: 'POST', headers: { 'x-idemix-credential': c }, body: JSON.stringify({ electionID: EID, candidateID: 'A', nullifierHash: nh }) });
    await ok(`/api/elections/${EID}/close`, { method: 'POST' });
    const t = await ok(`/api/elections/${EID}/tally`);
    A(t.decrypted === true, `AES 종료 즉시 decrypted=true (results ${JSON.stringify(t.results)})`);
  }

  console.log(`\n=== 결과: ${pass} PASS, ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n=== 스위트 오류 ===\n', e.message); process.exit(2); });
