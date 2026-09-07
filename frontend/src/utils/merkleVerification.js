import { computeMerkleRootFromProof } from './crypto.js';
import { findUniqueReceiptMatch, normalizeReceiptPrefix } from './receiptLookup.js';

const FULL_HASH_RE = /^[0-9a-f]{64}$/;

export class MongbasApiError extends Error {
  constructor(message, { code = 'API_ERROR', status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'MongbasApiError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export async function fetchMongbasJSON(path, request = fetch) {
  const response = await request(path);
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { /* handled as a stable API error below */ }
  if (!response.ok) {
    throw new MongbasApiError(body.error || `요청을 처리할 수 없습니다. (HTTP ${response.status})`, {
      code: body.code || 'API_ERROR', status: response.status, retryable: body.retryable === true,
    });
  }
  return body;
}

export async function verifyMerkleNullifier({ electionID, nullifierHash, request = fetch }) {
  const election = String(electionID || '').trim();
  const full = String(nullifierHash || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (!election) throw new Error('선거 ID를 입력하세요.');
  if (!FULL_HASH_RE.test(full)) throw new Error('전체 추적 해시는 64자리 16진수여야 합니다.');

  const encodedElection = encodeURIComponent(election);
  const [merkle, proofResponse] = await Promise.all([
    fetchMongbasJSON(`/api/elections/${encodedElection}/merkle`, request),
    fetchMongbasJSON(`/api/elections/${encodedElection}/proof/${full}`, request),
  ]);
  const proof = Array.isArray(proofResponse.proof) ? proofResponse.proof : [];
  const computedRoot = await computeMerkleRootFromProof(proofResponse.leafHash, proof);
  const chainRoot = String(merkle.rootHash || '').toLowerCase();
  return {
    full,
    leafHash: proofResponse.leafHash,
    proof,
    chainRoot,
    computedRoot,
    sealMatch: computedRoot === chainRoot,
  };
}

export async function verifyMerkleReceipt({ electionID, receipt, request = fetch }) {
  const election = String(electionID || '').trim();
  if (!election) throw new Error('선거 ID를 입력하세요.');
  const prefix = normalizeReceiptPrefix(receipt);
  let board = null;
  let ballots = [];
  let index = -1;
  let full = prefix;

  if (FULL_HASH_RE.test(prefix)) {
    // A trusted mobile event carries the complete nullifier. Bulletin
    // publication is optional for the Merkle inclusion check itself.
    try {
      board = await fetchMongbasJSON(`/api/elections/${encodeURIComponent(election)}/bulletin-board`, request);
      ballots = board.encryptedBallots || [];
      index = ballots.findIndex((ballot) => String(ballot?.nullifierHash || '').toLowerCase() === full);
    } catch { /* exact Merkle lookup remains independently verifiable */ }
  } else {
    board = await fetchMongbasJSON(`/api/elections/${encodeURIComponent(election)}/bulletin-board`, request);
    ballots = board.encryptedBallots || [];
    const match = findUniqueReceiptMatch(ballots, prefix);
    if (match.index < 0) throw new Error(`추적번호 "${receipt}"에 해당하는 표를 게시판에서 찾을 수 없습니다.`);
    index = match.index;
    full = match.ballot.nullifierHash;
  }

  const merkle = await verifyMerkleNullifier({ electionID: election, nullifierHash: full, request });
  return {
    ...merkle,
    index,
    ballots,
    bulletin: board,
    tallyTotal: board?.totalVotes,
    cipher: index >= 0 ? ballots[index]?.encryptedCandidateID : undefined,
  };
}
