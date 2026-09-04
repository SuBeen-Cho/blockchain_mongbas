'use strict';
console.error('[UNSUPPORTED] p2-threshold-test.js uses the legacy dealer-share API and cannot produce current threshold-security evidence. Use dkg-election-e2e.js or deploy/linux/dkg-live-evaluation.sh.');
process.exit(2);
/**
 * p2-threshold-test.js — P2 검증: ElGamal threshold 복호화
 *
 * 검증 항목:
 *   1) 종료(close) 시 결과가 복호화되지 않음 (Decrypted=false, results 모두 0)
 *   2) 조각 1개 제출 후에도 여전히 pending
 *   3) 조각 2개 제출 후 자동 복원·복호화 → results 정확 (Alice=2, Bob=1)
 *
 * 실행: node scripts/p2-threshold-test.js   (백엔드 :3000 + 네트워크 기동 상태)
 */
const crypto = require('crypto');
const { computeCredentialBoundNullifier } = require('../src/lib/credentialBinding');
const BASE = (process.env.E2E_BASE_URL || process.env.BASE_URL || process.env.BASE || 'http://localhost:3000').replace(/\/$/, '');
const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';

function sha256Hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function bufToBigInt(buf) { return BigInt('0x' + Buffer.from(buf).toString('hex')); }
function modPow(b, e, m) { b %= m; let r = 1n; while (e > 0n) { if (e & 1n) r = (r * b) % m; e >>= 1n; b = (b * b) % m; } return r; }
function sha256ToBigInt(s) { return BigInt('0x' + crypto.createHash('sha256').update(s).digest('hex')); }
function modInverse(a, m) {
  a = ((a % m) + m) % m; let [or, r] = [a, m], [os, s] = [1n, 0n];
  while (r !== 0n) { const q = or / r; [or, r] = [r, or - q * r]; [os, s] = [s, os - q * s]; }
  return or !== 1n ? null : ((os % m) + m) % m;
}
async function req(path, opts = {}) {
  const { headers, ...rest } = opts;
  const res = await fetch(BASE + path, { headers: { 'Content-Type': 'application/json', ...(ADMIN_API_TOKEN ? { authorization: `Bearer ${ADMIN_API_TOKEN}` } : {}), ...(headers || {}) }, ...rest });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

function makeEG(pub) {
  const HOMO = 10000n, p = BigInt('0x' + pub.p), g = BigInt('0x' + pub.g), y = BigInt('0x' + pub.y), q = (p - 1n) / 2n;
  return function encrypt(idx, n) {
    const gm = modPow(g, HOMO ** BigInt(idx), p);
    let r = bufToBigInt(crypto.randomBytes(32)) % (p - 2n); if (r === 0n) r = 1n;
    const c1 = modPow(g, r, p), c2 = (gm * modPow(y, r, p)) % p;
    const c1h = c1.toString(16), c2h = c2.toString(16);
    const a1s = Array(n), a2s = Array(n), es = Array(n), zs = Array(n);
    let k = bufToBigInt(crypto.randomBytes(32)) % q; if (k === 0n) k = 1n;
    let eSum = 0n;
    for (let j = 0; j < n; j++) {
      if (j === idx) continue;
      const mj = modPow(g, HOMO ** BigInt(j), p), mjInv = modInverse(mj, p), c2dm = (c2 * mjInv) % p;
      const ej = bufToBigInt(crypto.randomBytes(32)) % q, zj = bufToBigInt(crypto.randomBytes(32)) % q;
      a1s[j] = ((modPow(g, zj, p) * modPow(modInverse(c1, p), ej, p)) % p).toString(16);
      a2s[j] = ((modPow(y, zj, p) * modPow(modInverse(c2dm, p), ej, p)) % p).toString(16);
      es[j] = ej.toString(16); zs[j] = zj.toString(16); eSum = (eSum + ej) % q;
    }
    a1s[idx] = modPow(g, k, p).toString(16); a2s[idx] = modPow(y, k, p).toString(16);
    let hi = c1h + '|' + c2h; for (let j = 0; j < n; j++) hi += '|' + a1s[j] + '|' + a2s[j];
    const eTot = sha256ToBigInt(hi) % q, eAct = ((eTot - eSum) % q + q) % q;
    es[idx] = eAct.toString(16); zs[idx] = ((k + eAct * r) % q).toString(16);
    return { encrypted: `${c1h}:${c2h}`, proof: { a1s, a2s, es, zs } };
  };
}

(async () => {
  const EID = 'P2TEST_' + Date.now();
  const CANDS = ['Alice', 'Bob', 'Charlie'];
  const now = Math.floor(Date.now() / 1000);
  console.log('=== P2 threshold test:', EID, '===');

  await req('/api/elections', { method: 'POST', body: JSON.stringify({ electionID: EID, title: 'P2', candidates: CANDS, encryptionMode: 'elgamal', endTime: now + 3600 }) });
  await req(`/api/elections/${EID}/activate`, { method: 'POST' });
  const pub = (await req(`/api/elections/${EID}/elgamal-pubkey`)).pubKey;
  const bf = (await req(`/api/elections/${EID}/blinding-factor`)).blindingFactor;
  const enc = makeEG(pub);

  // 3표: Alice, Alice, Bob → Alice=2, Bob=1
  const plan = [['voter1', 'voter1pw', 0], ['voter2', 'voter2pw', 0], ['voter3', 'voter3pw', 1]];
  for (const [id, sec, idx] of plan) {
    const issued = await req('/api/credential/idemix', { method: 'POST', body: JSON.stringify({ enrollmentID: id, enrollmentSecret: sec, electionID: EID }) });
    const nh = computeCredentialBoundNullifier(issued.nullifierMaterial, EID, bf);
    const v = enc(idx, CANDS.length);
    await req('/api/vote', { method: 'POST', headers: { 'x-idemix-credential': issued.credential }, body: JSON.stringify({ electionID: EID, encryptedCandidateID: v.encrypted, nullifierHash: nh, ballotValidityProof: JSON.stringify(v.proof) }) });
    console.log(`  vote cast: ${id} → ${CANDS[idx]}`);
  }

  // 종료
  await req(`/api/elections/${EID}/close`, { method: 'POST' });
  let tally = await req(`/api/elections/${EID}/tally`);
  console.log('  [close] decrypted=%s results=%j', tally.decrypted, tally.results);
  if (tally.decrypted !== false) throw new Error('FAIL: 종료 직후 decrypted=false 여야 함 (단일 기관 복호화 차단)');
  const sumPending = Object.values(tally.results).reduce((a, b) => a + b, 0);
  if (sumPending !== 0) throw new Error('FAIL: 종료 직후 results는 모두 0(복호화 보류) 여야 함');
  console.log('  ✓ 종료 직후 복호화 보류 (단일 기관 복호화 불가)');

  // 조각 1 제출 → 여전히 pending
  const s1 = await req(`/api/elections/${EID}/shares/1`);
  await req(`/api/elections/${EID}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: '1', shareHex: s1.shareHex }) });
  tally = await req(`/api/elections/${EID}/tally`);
  console.log('  [share 1/2] decrypted=%s', tally.decrypted);
  if (tally.decrypted !== false) throw new Error('FAIL: 조각 1개로는 복호화되면 안 됨');
  console.log('  ✓ 조각 1개로는 복호화 불가');

  // 조각 2 제출 → 복원 + 복호화
  const s2 = await req(`/api/elections/${EID}/shares/2`);
  await req(`/api/elections/${EID}/shares`, { method: 'POST', body: JSON.stringify({ shareIndex: '2', shareHex: s2.shareHex }) });
  tally = await req(`/api/elections/${EID}/tally`);
  console.log('  [share 2/2] decrypted=%s results=%j', tally.decrypted, tally.results);
  if (tally.decrypted !== true) throw new Error('FAIL: 조각 2개 후 복호화되어야 함');
  if (tally.results.Alice !== 2 || tally.results.Bob !== 1 || tally.results.Charlie !== 0) throw new Error('FAIL: 결과 불일치, got ' + JSON.stringify(tally.results));
  console.log('  ✓ 조각 2개 후 복원·복호화 + 결과 정확 (Alice=2, Bob=1, Charlie=0)');

  console.log('\n=== ✅ P2 PASS: threshold 복호화 정상 동작 ===');
})().catch(e => { console.error('\n=== ❌ P2 FAIL ===\n', e.message); process.exit(1); });
