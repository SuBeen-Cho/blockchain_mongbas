// Builds the data shown by the tally animation and the step list from the
// published bulletin board. Everything here is recomputed from public data so
// the screen shows real values, not illustrations.

const big = (hex) => BigInt(`0x${hex}`);

export const DENIABLE_POLICY = 'deniable-slot-v1';

export function shortHex(hex, head = 10, tail = 4) {
  const s = String(hex || '');
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}

/**
 * @param {object} board  GET /api/elections/:id/bulletin-board
 * @param {string[]} candidates
 * @param {Record<string, number>} results decrypted tally
 */
export function buildTallyStory(board, candidates, results) {
  if (!board?.elgamalPubKey || !Array.isArray(board.encryptedBallots)) return null;
  const p = big(board.elgamalPubKey.p);
  const deniable = board.panicPolicy === DENIABLE_POLICY;
  const ballots = board.encryptedBallots
    .filter((b) => Array.isArray(b.encryptedCandidateVector) && b.encryptedCandidateVector.length === candidates.length)
    .map((b) => ({
      nullifierHash: b.nullifierHash,
      visible: b.encryptedCandidateVector,
      counted: deniable ? b.countedVector : b.encryptedCandidateVector,
      casts: deniable ? (b.countedSlotChain || []).length : 1,
    }))
    .filter((b) => Array.isArray(b.counted) && b.counted.length === candidates.length);

  const aggregate = candidates.map(() => ({ c1: 1n, c2: 1n }));
  for (const b of ballots) {
    b.counted.forEach((ct, k) => {
      aggregate[k].c1 = (aggregate[k].c1 * big(ct.c1)) % p;
      aggregate[k].c2 = (aggregate[k].c2 * big(ct.c2)) % p;
    });
  }
  const aggregateHex = aggregate.map((a) => ({ c1: a.c1.toString(16), c2: a.c2.toString(16) }));
  const published = board.encAggVector || [];
  const aggregateMatches = published.length === candidates.length &&
    published.every((ct, k) => big(ct.c1) === aggregate[k].c1 && big(ct.c2) === aggregate[k].c2);

  const partials = (board.vectorPartialDecryptions || []).map((partial) => ({
    index: partial.index,
    mspID: partial.mspID,
    values: partial.values || [],
    proofs: (partial.proofs || []).length,
  }));
  const counts = candidates.map((c) => Number(results?.[c] ?? board.tallyResults?.[c] ?? 0));
  const countedSum = counts.reduce((a, b) => a + b, 0);
  return {
    deniable,
    candidates,
    ballots,
    aggregate: aggregateHex,
    aggregateMatches,
    partials,
    counts,
    countedSum,
    voters: ballots.length,
    totalCasts: ballots.reduce((sum, b) => sum + b.casts, 0),
    merkleRoot: board.merkleRoot || '',
  };
}
