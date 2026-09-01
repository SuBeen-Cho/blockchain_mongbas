/**
 * mock-server.js — UI 시연용 목 서버
 * 실행: node mock-server.js
 * Fabric 없이 프론트엔드 UI를 테스트할 수 있습니다.
 */

import http from 'http';

const PORT = 3000;
const elections = {};
const votes = {};
const preparedVectors = {};
let voteCounter = 0;

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' });
  res.end(JSON.stringify(data));
}

function parseBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { json(res, {}); return; }

  const url = req.url;
  const method = req.method;

  // Health
  if (url === '/health') return json(res, { status: 'ok', idemix: { mode: 'mock' } });

  // Idemix credential
  if (url === '/api/credential/idemix' && method === 'POST') {
    return json(res, { credential: 'mock-idemix-credential-' + Date.now() });
  }

  // Create election
  if (url === '/api/elections' && method === 'POST') {
    const body = await parseBody(req);
    const id = body.electionID || 'DEMO';
    elections[id] = { electionID: id, title: body.title || 'Demo Election', description: body.description || '', candidates: body.candidates || ['A', 'B', 'C'], status: 'CREATED', encryptionMode: body.encryptionMode || 'aes', totalVotes: 0 };
    return json(res, elections[id]);
  }

  // Activate
  const activateMatch = url.match(/^\/api\/elections\/(.+?)\/activate$/);
  if (activateMatch && method === 'POST') {
    const id = decodeURIComponent(activateMatch[1]);
    if (elections[id]) { elections[id].status = 'ACTIVE'; return json(res, elections[id]); }
    return json(res, { error: 'not found' }, 404);
  }

  // Close
  const closeMatch = url.match(/^\/api\/elections\/(.+?)\/close$/);
  if (closeMatch && method === 'POST') {
    const id = decodeURIComponent(closeMatch[1]);
    if (elections[id]) {
      elections[id].status = 'CLOSED';
      const results = {};
      (elections[id].candidates || []).forEach(c => results[c] = 0);
      (votes[id] || []).forEach(v => { if (v.candidateID && results[v.candidateID] !== undefined) results[v.candidateID]++; });
      elections[id].tallyResults = results;
      elections[id].totalVotes = (votes[id] || []).length;
      return json(res, { message: 'Election closed', ...elections[id] });
    }
    return json(res, { error: 'not found' }, 404);
  }

  // Security properties (must be before getElMatch to avoid matching as election ID)
  if (url === '/api/elections/security-properties') {
    return json(res, {
      ballotSecrecy: { status: 'UNVERIFIED', mechanism: 'Mock server stores request data in memory', assumption: 'not a security evaluation' },
      castAsIntended: { status: 'PROTOTYPE_ONLY', mechanism: 'Mock state transition only', assumption: 'no cryptographic verification' },
      recordedAsCast: { status: 'PROTOTYPE_ONLY', mechanism: 'Mock receipt only', assumption: 'no Fabric ledger' },
      talliedAsRecorded: { status: 'UNVERIFIED', mechanism: 'Mock plaintext counter', assumption: 'no threshold proof' },
      universalVerifiability: { status: 'PROTOTYPE_ONLY', mechanism: 'Mock response; no independent evidence', assumption: 'not a security evaluation' },
      eligibilityVerifiability: { status: 'PROTOTYPE_ONLY', mechanism: 'Mock response; no credential validation', assumption: 'not a security evaluation' },
      coercionResistance: { status: 'UNVERIFIED', mechanism: 'UI demonstration only', assumption: 'mock server provides no coercion guarantee' },
    });
  }

  // Get election
  const getElMatch = url.match(/^\/api\/elections\/([^/]+)$/);
  if (getElMatch && method === 'GET') {
    const id = decodeURIComponent(getElMatch[1]);
    if (elections[id]) return json(res, elections[id]);
    return json(res, { error: 'Election not found' }, 404);
  }

  // Encryption key
  const encKeyMatch = url.match(/^\/api\/elections\/(.+?)\/encryption-key$/);
  if (encKeyMatch) return json(res, { encryptionKeyHex: 'a'.repeat(64) });

  // ElGamal pubkey
  const egMatch = url.match(/^\/api\/elections\/(.+?)\/elgamal-pubkey$/);
  if (egMatch) return json(res, { pubKey: { p: '17', g: '2', y: '8' } });

  // Blinding factor
  const bfMatch = url.match(/^\/api\/elections\/(.+?)\/blinding-factor$/);
  if (bfMatch) return json(res, { blindingFactor: 'mock-bf-' + Date.now() });

  // Vote
  if (url === '/api/vote' && method === 'POST') {
    const body = await parseBody(req);
    const id = body.electionID;
    if (!votes[id]) votes[id] = [];
    votes[id].push({ ...body, voteIndex: ++voteCounter });
    return json(res, { message: '투표가 성공적으로 제출되었습니다', txID: 'mock-tx-' + voteCounter });
  }

  if (url === '/api/vote/prepare-vector' && method === 'POST') {
    const body = await parseBody(req);
    const ballotID = `mock-vector-${Date.now()}-${++voteCounter}`;
    const artifactHash = 'ab'.repeat(32);
    preparedVectors[ballotID] = { ...body, artifactHash, status: 'prepared' };
    return json(res, { schema: 'mock-vector-receipt/v1', ballotID, electionID: body.electionID, artifactHash, status: 'prepared' });
  }

  if (url === '/api/vote/audit-vector' && method === 'POST') {
    const body = await parseBody(req);
    const prepared = preparedVectors[body.ballotID];
    if (!prepared || prepared.status !== 'prepared') return json(res, { error: 'prepared vector ballot not found' }, 409);
    prepared.status = 'audited';
    return json(res, { schema: 'mock-vector-audit/v1', ballotID: body.ballotID, electionID: body.electionID,
      artifactHash: prepared.artifactHash, selectedIndex: body.selectedIndex, clientNonce: body.clientNonce,
      randomness: body.randomness, encryptedCandidateVector: prepared.encryptedCandidateVector,
      vectorBallotValidityProof: prepared.vectorBallotValidityProof, status: 'audited' });
  }

  if (url === '/api/vote/cast-vector' && method === 'POST') {
    const body = await parseBody(req);
    const prepared = preparedVectors[body.ballotID];
    if (!prepared || prepared.status !== 'prepared') return json(res, { error: 'prepared vector ballot not found' }, 409);
    prepared.status = 'cast';
    const id = body.electionID;
    if (!votes[id]) votes[id] = [];
    votes[id].push({ ...body, voteIndex: ++voteCounter });
    return json(res, { message: '투표가 성공적으로 제출되었습니다', ballotID: body.ballotID, txID: `mock-tx-${voteCounter}` });
  }

  // Vote prepare (Benaloh)
  if (url === '/api/vote/prepare' && method === 'POST') {
    return json(res, { ballotID: 'ballot-' + Date.now(), commitment: 'mock-commitment-hash' });
  }

  // Vote audit (Benaloh)
  if (url === '/api/vote/audit' && method === 'POST') {
    const body = await parseBody(req);
    const key = 'a'.repeat(64);
    return json(res, { candidateID: body.candidateID || 'A', encryptionKeyHex: key, encryptedCandidateID: 'mock-cipher', nonce: 'mock-nonce' });
  }

  // Tally
  const tallyMatch = url.match(/^\/api\/elections\/(.+?)\/tally$/);
  if (tallyMatch && method === 'GET') {
    const id = decodeURIComponent(tallyMatch[1]);
    if (elections[id]) {
      const results = {};
      (elections[id].candidates || []).forEach(c => results[c] = 0);
      (votes[id] || []).forEach(v => { if (v.candidateID && results[v.candidateID] !== undefined) results[v.candidateID]++; });
      return json(res, { results, totalVotes: (votes[id] || []).length });
    }
    return json(res, { error: 'not found' }, 404);
  }

  // Merkle
  const merkleMatch = url.match(/^\/api\/elections\/(.+?)\/merkle$/);
  if (merkleMatch) return json(res, { rootHash: 'abcdef1234567890'.repeat(4), message: 'Merkle tree built' });

  // Merkle proof
  const proofMatch = url.match(/^\/api\/elections\/(.+?)\/proof\/(.+)$/);
  if (proofMatch && method === 'GET') {
    return json(res, { electionID: decodeURIComponent(proofMatch[1]), nullifierHash: decodeURIComponent(proofMatch[2]), leafHash: '1234abcd'.repeat(8), proof: [{ hash: 'aaaa'.repeat(16), position: 'left' }, { hash: 'bbbb'.repeat(16), position: 'right' }] });
  }

  // Deniable proof
  const deniableMatch = url.match(/^\/api\/elections\/(.+?)\/proof$/);
  if (deniableMatch && method === 'POST') {
    return json(res, { electionID: decodeURIComponent(deniableMatch[1]), leafHash: 'deniable-leaf-hash'.repeat(4), proof: { leafHash: 'deniable-leaf'.repeat(5), proof: [{ hash: 'cccc'.repeat(16), position: 'left' }] } });
  }

  // Keysharing
  const ksMatch = url.match(/^\/api\/elections\/(.+?)\/keysharing$/);
  if (ksMatch && method === 'POST') return json(res, { message: 'Key sharing initialized', shares: 3, threshold: 2 });

  // Get share
  const gsMatch = url.match(/^\/api\/elections\/(.+?)\/shares\/(\d+)$/);
  if (gsMatch && method === 'GET') return json(res, { shareIndex: gsMatch[2], shareHex: 'deadbeef'.repeat(8) });

  // Submit share
  const ssMatch = url.match(/^\/api\/elections\/(.+?)\/shares$/);
  if (ssMatch && method === 'POST') return json(res, { message: 'Share submitted', submittedCount: 2 });

  // Decryption status
  const dsMatch = url.match(/^\/api\/elections\/(.+?)\/decryption$/);
  if (dsMatch) return json(res, { restored: true, submittedCount: 2, totalShares: 3, threshold: 2 });

  // Publish audit
  const paMatch = url.match(/^\/api\/elections\/(.+?)\/publish-audit$/);
  if (paMatch && method === 'POST') return json(res, { message: 'Audit data published' });

  // Bulletin board
  const bbMatch = url.match(/^\/api\/elections\/(.+?)\/bulletin-board$/);
  if (bbMatch && method === 'GET') {
    const id = decodeURIComponent(bbMatch[1]);
    const el = elections[id] || { candidates: ['A', 'B', 'C'] };
    const results = {};
    (el.candidates || []).forEach(c => results[c] = Math.floor(Math.random() * 20));
    return json(res, { encryptedBallots: Array(10).fill({ encrypted: true }), tallyResults: results, publishedAt: new Date().toISOString(), encryptionKey: 'a'.repeat(64) });
  }

  // Verify public
  const vpMatch = url.match(/^\/api\/elections\/(.+?)\/verify-public$/);
  if (vpMatch && method === 'POST') return json(res, { resultsMatch: true, proofHashMatch: true, shuffleVerified: true });

  // ElGamal verify
  const evMatch = url.match(/^\/api\/elections\/(.+?)\/verify-elgamal$/);
  if (evMatch && method === 'POST') {
    const id = decodeURIComponent(evMatch[1]);
    const el = elections[id] || { candidates: ['A', 'B', 'C'] };
    const recount = {};
    (el.candidates || []).forEach(c => recount[c] = Math.floor(Math.random() * 20));
    return json(res, { isValid: true, verified: 10, failed: 0, totalProofs: 10, resultsMatch: true, recount, encryptionMode: 'elgamal' });
  }

  // Vote counted (receipt-free)
  const vcMatch = url.match(/^\/api\/elections\/(.+?)\/vote-counted\/(.+)$/);
  if (vcMatch) return json(res, { included: true, totalVotes: 47 });

  // Fallback
  json(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`\n  Mock server running at http://localhost:${PORT}`);
  console.log(`  Frontend at http://localhost:5173\n`);
});
