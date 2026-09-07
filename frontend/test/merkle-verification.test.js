import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { verifyMerkleReceipt } from '../src/utils/merkleVerification.js';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const full = 'a'.repeat(64);
const leaf = 'b'.repeat(64);
const root = sha256(leaf);

function requestFixture(paths) {
  return async (path) => {
    paths.push(path);
    let body;
    if (path.endsWith('/bulletin-board')) body = { encryptedBallots: [{ nullifierHash: full }], totalVotes: 1 };
    else if (path.endsWith('/merkle')) body = { rootHash: root };
    else if (path.includes('/proof/')) body = { leafHash: leaf, proof: [] };
    else return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

test('short receipt resolves through bulletin and verifies the committed root', async () => {
  const paths = [];
  const result = await verifyMerkleReceipt({ electionID: 'election-a', receipt: 'AAAAAA', request: requestFixture(paths) });
  assert.equal(result.full, full);
  assert.equal(result.index, 0);
  assert.equal(result.sealMatch, true);
  assert.equal(paths.filter((path) => path.endsWith('/bulletin-board')).length, 1);
});

test('full receipt verifies even when bulletin publication is unavailable', async () => {
  const paths = [];
  const base = requestFixture(paths);
  const request = async (path) => path.endsWith('/bulletin-board')
    ? new Response(JSON.stringify({ error: 'not published', code: 'BULLETIN_NOT_PUBLISHED' }), { status: 409 })
    : base(path);
  const result = await verifyMerkleReceipt({ electionID: 'election-a', receipt: full, request });
  assert.equal(result.sealMatch, true);
  assert.equal(result.index, -1);
});

test('one-character receipt mutation is rejected before proof lookup', async () => {
  const paths = [];
  await assert.rejects(
    verifyMerkleReceipt({ electionID: 'election-a', receipt: 'CAAAAA', request: requestFixture(paths) }),
    /찾을 수 없습니다/,
  );
  assert.equal(paths.some((path) => path.includes('/proof/')), false);
});
