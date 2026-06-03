'use strict';
/**
 * scenario-suite.js — 다중 시나리오 검증 (P7 비판적 검증)
 * 재투표/종료후투표/빈선거/패닉제외/다중세션/추적무결성 등을 한 번에 점검.
 */
const crypto = require('crypto');
const { elgamalEncryptWithZKP } = require('../src/lib/elgamalVote');
const B = 'http://localhost:3000';
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function J(p, o = {}) {
  const { headers, ...r } = o;
  const x = await fetch(B + p, { headers: { 'Content-Type': 'application/json', ...(headers || {}) }, ...r });
  const t = await x.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  return { ok: x.ok, status: x.status, j, t };
}
async function ok(p, o) { const r = await J(p, o); if (!r.ok) throw new Error(`${p} → ${r.status} ${r.t.slice(0, 120)}`); return r.j; }

let pass = 0, fail = 0;
const A = (cond, label) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.log('  ✗ FAIL: ' + label); } };

async function mkElection(cands) {
  const EID = 'SC_' + crypto.randomBytes(4).toString('hex');
  const now = Math.floor(Date.now() / 1e3);
  await ok('/api/elections', { method: 'POST', body: JSON.stringify({ electionID: EID, title: 'sc', candidates: cands, encryptionMode: 'elgamal', endTime: now + 86400 }) });
  await ok(`/api/elections/${EID}/activate`, { method: 'POST' });
  const pub = (await ok(`/api/elections/${EID}/elgamal-pubkey`)).pubKey;
  const bf = (await ok(`/api/elections/${EID}/blinding-factor`)).blindingFactor;
  return { EID, pub, bf, cands };
}
async function cred(voter, EID) { return (await ok('/api/credential/idemix', { method: 'POST', body: JSON.stringify({ enrollmentID: voter, enrollmentSecret: `${voter}pw`, electionID: EID }) })).credential; }
async function castVote(E, voter, voterSecret, idx, extra = {}) {
  const c = await cred(voter, E.EID);
  const nh = sha(voterSecret + E.EID + E.bf);
  const v = elgamalEncryptWithZKP(E.pub, idx, E.cands.length);
  return J('/api/vote', { method: 'POST', headers: { 'x-idemix-credential': c }, body: JSON.stringify({ electionID: E.EID, encryptedCandidateID: v.encrypted, nullifierHash: nh, ballotValidityProof: JSON.stringify(v.proof), ...extra }) });
}
async function closeDecrypt(EID) {
  await ok(`/api/elections/${EID}/close`, { method: 'POST' });
  for (const i of ['1', '2']) { const s = await ok(`/api/elections/${EID}/shares/${i}`); await ok(`/api/elections/${EID}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: i, shareHex: s.shareHex }) }); }
  return ok(`/api/elections/${EID}/tally`);
}

(async () => {
  console.log('=== 시나리오 검증 ===');

  // S1: 재투표(last-vote-wins) — 같은 voterSecret로 A→B 재투표 시 B 1표만
  console.log('[S1] 재투표 (last-vote-wins)');
  {
    const E = await mkElection(['A', 'B']);
    const vs = crypto.randomBytes(32).toString('hex');
    const r1 = await castVote(E, 'voter1', vs, 0); A(r1.ok, '첫 투표(A) 성공');
    const r2 = await castVote(E, 'voter1', vs, 1); A(r2.ok && r2.j.isRevote, '재투표(B) 성공 + isRevote=true');
    const t = await closeDecrypt(E.EID);
    A(t.results.A === 0 && t.results.B === 1, `최종 A=0,B=1 (실제 ${JSON.stringify(t.results)})`);
  }

  // S2: 종료 후 투표 거부
  console.log('[S2] 종료 후 투표 거부');
  {
    const E = await mkElection(['A', 'B']);
    await castVote(E, 'voter1', crypto.randomBytes(32).toString('hex'), 0);
    await ok(`/api/elections/${E.EID}/close`, { method: 'POST' });
    const r = await castVote(E, 'voter2', crypto.randomBytes(32).toString('hex'), 1);
    A(!r.ok, `종료된 선거 투표 거부됨 (status ${r.status})`);
  }

  // S3: 빈 선거 종료 (0표) — 크래시 없이 tally 0
  console.log('[S3] 빈 선거 종료 (0표)');
  {
    const E = await mkElection(['A', 'B']);
    const t = await closeDecrypt(E.EID);
    A(t && (t.totalVotes === 0), `0표 집계 정상 (total ${t.totalVotes})`);
  }

  // S4: 패닉 자격증명 → 집계 제외
  console.log('[S4] 패닉 투표 집계 제외');
  {
    const E = await mkElection(['A', 'B']);
    await castVote(E, 'voter1', crypto.randomBytes(32).toString('hex'), 0);                       // 정상 A
    const rp = await castVote(E, 'voter2', crypto.randomBytes(32).toString('hex'), 1, { credentialType: 'panic' }); // 패닉 B
    A(rp.ok, '패닉 투표 제출 성공');
    const t = await closeDecrypt(E.EID);
    A(t.results.A === 1 && t.results.B === 0, `패닉(B) 제외되어 A=1,B=0 (실제 ${JSON.stringify(t.results)})`);
  }

  // S5: 다중 세션 독립성 — 두 선거 표 안 섞임
  console.log('[S5] 다중 세션 독립성');
  {
    const E1 = await mkElection(['A', 'B']); const E2 = await mkElection(['A', 'B']);
    await castVote(E1, 'voter1', crypto.randomBytes(32).toString('hex'), 0);
    await castVote(E1, 'voter2', crypto.randomBytes(32).toString('hex'), 0);
    await castVote(E2, 'voter1', crypto.randomBytes(32).toString('hex'), 1);
    const t1 = await closeDecrypt(E1.EID); const t2 = await closeDecrypt(E2.EID);
    A(t1.results.A === 2 && t1.results.B === 0, `E1 A=2,B=0 (${JSON.stringify(t1.results)})`);
    A(t2.results.A === 0 && t2.results.B === 1, `E2 A=0,B=1 (${JSON.stringify(t2.results)})`);
  }

  // S6: 단일 표 선거 Merkle 검증 (P0 버그 수정 확인)
  console.log('[S6] 단일 표 Merkle 봉인');
  {
    const E = await mkElection(['A', 'B', 'C']);
    const vs = crypto.randomBytes(32).toString('hex'); const nh = sha(vs + E.EID + E.bf);
    await castVote(E, 'voter1', vs, 0);
    await closeDecrypt(E.EID);
    await ok(`/api/elections/${E.EID}/merkle`, { method: 'POST' });
    const merkle = await ok(`/api/elections/${E.EID}/merkle`);
    const proof = await ok(`/api/elections/${E.EID}/proof/${nh}`);
    // 단일 leaf: root = sha256(leaf)
    const computed = (!proof.proof || proof.proof.length === 0) ? sha(proof.leafHash)
      : proof.proof.reduce((cur, n) => n.position === 'left' ? sha(n.hash + cur) : sha(cur + n.hash), proof.leafHash);
    A(computed === merkle.rootHash, '단일 표 봉인 일치 (client root = chain root)');
  }

  console.log(`\n=== 결과: ${pass} PASS, ${fail} FAIL ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n=== 스위트 오류 ===\n', e.message); process.exit(2); });
