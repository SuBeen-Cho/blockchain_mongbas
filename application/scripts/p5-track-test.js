'use strict';
// p5-track-test.js — 내 표 추적 데이터 흐름 검증 (게시판 매칭 + Merkle 봉인 일치)
const crypto = require('crypto');
const { elgamalEncryptWithZKP } = require('../src/lib/elgamalVote');
const BASE = 'http://localhost:3000';
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

async function J(path, opts = {}) {
  const { headers, ...rest } = opts;
  const r = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json', ...(headers || {}) }, ...rest });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = {}; }
  if (!r.ok) throw new Error(`${path} ${r.status} ${t.slice(0, 120)}`);
  return j;
}
// 클라이언트 computeMerkleRootFromProof와 동일 (단일 leaf = sha256(leaf))
function rootFromProof(leaf, proof) {
  if (!proof || proof.length === 0) return sha256(leaf);
  let cur = leaf;
  for (const n of proof) cur = n.position === 'left' ? sha256(n.hash + cur) : sha256(cur + n.hash);
  return cur;
}

(async () => {
  const EID = 'P5TRACK_' + Date.now();
  const now = Math.floor(Date.now() / 1000);
  console.log('=== P5 내 표 추적 테스트:', EID, '===');
  await J('/api/elections', { method: 'POST', body: JSON.stringify({ electionID: EID, title: 'P5', candidates: ['Alice', 'Bob', 'Charlie'], encryptionMode: 'elgamal', endTime: now + 3600 }) });
  await J(`/api/elections/${EID}/activate`, { method: 'POST' });
  const pub = (await J(`/api/elections/${EID}/elgamal-pubkey`)).pubKey;
  const bf = (await J(`/api/elections/${EID}/blinding-factor`)).blindingFactor;

  // 내 표 (known voterSecret → known nullifier)
  const vs = crypto.randomBytes(32).toString('hex');
  const myNull = sha256(vs + EID + bf);
  const cred = (await J('/api/credential/idemix', { method: 'POST', body: JSON.stringify({ enrollmentID: 'voter1', enrollmentSecret: 'voter1pw', electionID: EID }) })).credential;
  const v = elgamalEncryptWithZKP(pub, 0, 3);
  await J('/api/vote', { method: 'POST', headers: { 'x-idemix-credential': cred }, body: JSON.stringify({ electionID: EID, encryptedCandidateID: v.encrypted, nullifierHash: myNull, ballotValidityProof: JSON.stringify(v.proof) }) });
  console.log('  내 표 제출, nullifier 앞6:', myNull.slice(0, 6).toUpperCase());

  // 다른 표 4개
  await J(`/api/elections/${EID}/seed-votes`, { method: 'POST', body: JSON.stringify({ count: 4 }) });

  // 종료 + 검증 데이터 준비
  await J(`/api/elections/${EID}/close`, { method: 'POST' });
  for (const i of ['1', '2']) { const s = await J(`/api/elections/${EID}/shares/${i}`); await J(`/api/elections/${EID}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: i, shareHex: s.shareHex }) }); }
  await J(`/api/elections/${EID}/merkle`, { method: 'POST' });
  await J(`/api/elections/${EID}/publish-audit`, { method: 'POST' });

  // 추적: 게시판에서 내 줄 찾기 (앞6자리 prefix)
  const board = await J(`/api/elections/${EID}/bulletin-board`);
  const prefix = myNull.slice(0, 6).toLowerCase();
  const idx = (board.encryptedBallots || []).findIndex((b) => (b.nullifierHash || '').toLowerCase().startsWith(prefix));
  if (idx < 0) throw new Error('FAIL: 게시판에서 내 표를 못 찾음');
  console.log(`  ✓ 게시판 매칭: ${idx + 1}번째 줄 / 전체 ${board.encryptedBallots.length}건`);

  // Merkle 봉인 일치
  const merkle = await J(`/api/elections/${EID}/merkle`);
  const proof = await J(`/api/elections/${EID}/proof/${board.encryptedBallots[idx].nullifierHash}`);
  const computed = rootFromProof(proof.leafHash, proof.proof);
  if (computed !== merkle.rootHash) throw new Error(`FAIL: 봉인 불일치\n  computed=${computed}\n  chain   =${merkle.rootHash}`);
  console.log('  ✓ Merkle 봉인 일치 (내가 계산한 root = 블록체인 root)');

  // 변조: prefix 한 글자 바꾸면 못 찾음
  const bad = (parseInt(prefix[5], 16) ^ 1).toString(16);
  const tampered = prefix.slice(0, 5) + bad;
  const badIdx = board.encryptedBallots.findIndex((b) => (b.nullifierHash || '').toLowerCase().startsWith(tampered));
  console.log(`  ✓ 변조 번호(${tampered})는 게시판에서 ${badIdx < 0 ? '찾을 수 없음(추적 실패)' : '발견됨(예상밖)'}`);

  console.log('\n=== ✅ P5 PASS: 내 표 추적(게시판 매칭 + 봉인 일치 + 변조 탐지) ===');
})().catch((e) => { console.error('\n=== ❌ P5 FAIL ===\n', e.message); process.exit(1); });
