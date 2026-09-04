'use strict';

const crypto = require('node:crypto');
const { ALGORITHM, P, canonicalize, merkleRoot, unsignedBundle } = require('./verify');
const {
  MAX_BALLOTS, MAX_CANDIDATES, MAX_ORGANIZATIONS, MAX_VECTOR_RECEIPTS, MAX_VECTOR_DISCLOSURES,
} = require('./limits');

function requireSourceBounds(source) {
  if (!Array.isArray(source?.ballots) || source.ballots.length === 0 || source.ballots.length > MAX_BALLOTS) {
    throw new Error(`bundle source ballots must contain 1..${MAX_BALLOTS} entries`);
  }
  const candidates = source.configuration?.candidates;
  if (!Array.isArray(candidates) || candidates.length < 2 || candidates.length > MAX_CANDIDATES) {
    throw new Error(`bundle source candidates must contain 2..${MAX_CANDIDATES} entries`);
  }
  if (!Array.isArray(source.configuration?.organizations) || source.configuration.organizations.length < 1 ||
      source.configuration.organizations.length > MAX_ORGANIZATIONS) {
    throw new Error(`bundle source organizations must contain 1..${MAX_ORGANIZATIONS} entries`);
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function splitCiphertext(value, label) {
  const parts = requireString(value, label).split(':');
  if (parts.length !== 2) throw new Error(`${label} must contain c1:c2`);
  return { c1: parts[0], c2: parts[1] };
}

function buildUnsignedBundle(source) {
  if (source?.schema !== 'mongbas-election-bundle-source/v1') throw new Error('unsupported bundle source schema');
  requireSourceBounds(source);
  if (source.encryptionMode === 'elgamal-vector-v3') return buildUnsignedVectorBundle(source);
  if (source.encryptionMode !== 'elgamal') throw new Error('bundle supports ElGamal elections only');
  if (!Array.isArray(source.ballots) || source.ballots.length === 0) throw new Error('bundle source contains no ballots');
  const ballots = source.ballots.map((ballot, index) => {
    if (!ballot.ballotValidityProof) throw new Error(`ballot ${index} has no validity proof`);
    return {
      nullifierHash: requireString(ballot.nullifierHash, `ballot ${index} nullifierHash`),
      candidateCommitment: requireString(ballot.candidateCommitment, `ballot ${index} candidateCommitment`),
      ciphertext: splitCiphertext(ballot.encryptedCandidateID, `ballot ${index} ciphertext`),
      validityProof: ballot.ballotValidityProof,
    };
  });
  let c1 = 1n;
  let c2 = 1n;
  for (const ballot of ballots) {
    c1 = (c1 * BigInt(`0x${ballot.ciphertext.c1}`)) % P;
    c2 = (c2 * BigInt(`0x${ballot.ciphertext.c2}`)) % P;
  }
  const aggregateCiphertext = { c1: c1.toString(16), c2: c2.toString(16) };
  if (source.aggregateCiphertext && (source.aggregateCiphertext.c1 !== aggregateCiphertext.c1 || source.aggregateCiphertext.c2 !== aggregateCiphertext.c2)) {
    throw new Error('source aggregate ciphertext does not match recomputed ballot aggregate');
  }
  if (Array.isArray(source.partialDecryptions) && source.partialDecryptions.length > 0) {
    if (!Array.isArray(source.thresholdPublicShares) || source.thresholdPublicShares.length < 2) {
      throw new Error('threshold public shares are required');
    }
    return {
      schema: 'mongbas-election-bundle/v2',
      algorithms: {
        canonicalization: 'mongbas-canonical-json-v1', hash: 'sha-256', signature: 'ed25519',
        tally: 'mongbas-exp-elgamal-threshold-v2',
      },
      configuration: source.configuration,
      provenance: source.provenance,
      publicKey: source.publicKey,
      trusteePublicShares: source.thresholdPublicShares,
      ballots,
      bulletinBoard: { root: merkleRoot(ballots), publishedAt: source.publishedAt },
      aggregateCiphertext,
      tally: { results: source.tallyResults, totalVotes: source.totalVotes },
      partialDecryptions: source.partialDecryptions,
      signatures: [],
    };
  }
  const aggregateProofs = (source.decryptionProofs || []).filter((proof) => proof.nullifierHash === 'HOMOMORPHIC_TALLY');
  if (aggregateProofs.length !== 1 || !aggregateProofs[0].zkProof) throw new Error('exactly one homomorphic tally proof is required');
  const sourceProof = aggregateProofs[0].zkProof;
  const decryptionProof = {
    nullifierHash: 'HOMOMORPHIC_TALLY',
    c1: sourceProof.c1,
    c2: sourceProof.c2,
    decryptedHash: sourceProof.decryptedHash,
    a1: sourceProof.a1,
    a2: sourceProof.a2,
    e: sourceProof.e,
    z: sourceProof.z,
  };
  if (decryptionProof.c1 !== aggregateCiphertext.c1 || decryptionProof.c2 !== aggregateCiphertext.c2) {
    throw new Error('source aggregate proof does not match recomputed ballot aggregate');
  }
  return {
    schema: 'mongbas-election-bundle/v1',
    algorithms: {
      canonicalization: 'mongbas-canonical-json-v1',
      hash: 'sha-256',
      signature: 'ed25519',
      tally: ALGORITHM,
    },
    configuration: source.configuration,
    provenance: source.provenance,
    publicKey: source.publicKey,
    ballots,
    bulletinBoard: { root: merkleRoot(ballots), publishedAt: source.publishedAt },
    aggregateCiphertext,
    tally: { results: source.tallyResults, totalVotes: source.totalVotes },
    decryptionProof,
    signatures: [],
  };
}

function buildUnsignedVectorBundle(source) {
  if (!Array.isArray(source.vectorBallotReceipts) || source.vectorBallotReceipts.length > MAX_VECTOR_RECEIPTS) {
    throw new Error(`vector receipts must contain at most ${MAX_VECTOR_RECEIPTS} entries`);
  }
  if (!Array.isArray(source.vectorAuditDisclosures) || source.vectorAuditDisclosures.length > MAX_VECTOR_DISCLOSURES) {
    throw new Error(`vector disclosures must contain at most ${MAX_VECTOR_DISCLOSURES} entries`);
  }
  const candidateCount = source.configuration?.candidates?.length;
  if (!Number.isInteger(candidateCount) || candidateCount < 2) throw new Error('invalid candidate configuration');
  const ballots = source.ballots.map((ballot, index) => {
    if (!Array.isArray(ballot.encryptedCandidateVector) || ballot.encryptedCandidateVector.length !== candidateCount || !ballot.vectorBallotValidityProof) {
      throw new Error(`ballot ${index} has invalid vector/proof`);
    }
    return {
      nullifierHash: requireString(ballot.nullifierHash, `ballot ${index} nullifierHash`),
      preparedBallotID: requireString(ballot.preparedBallotID, `ballot ${index} preparedBallotID`),
      candidateCommitment: requireString(ballot.candidateCommitment, `ballot ${index} candidateCommitment`),
      ciphertextVector: ballot.encryptedCandidateVector,
      validityProof: ballot.vectorBallotValidityProof,
    };
  });
  const aggregateCiphertextVector = Array.from({ length: candidateCount }, () => ({ c1: '1', c2: '1' }));
  for (const ballot of ballots) {
    ballot.ciphertextVector.forEach((ciphertext, index) => {
      aggregateCiphertextVector[index] = {
        c1: ((BigInt(`0x${aggregateCiphertextVector[index].c1}`) * BigInt(`0x${ciphertext.c1}`)) % P).toString(16),
        c2: ((BigInt(`0x${aggregateCiphertextVector[index].c2}`) * BigInt(`0x${ciphertext.c2}`)) % P).toString(16),
      };
    });
  }
  if (canonicalize(source.aggregateCiphertextVector) !== canonicalize(aggregateCiphertextVector)) {
    throw new Error('source vector aggregate does not match recomputed ballot aggregates');
  }
  if (!Array.isArray(source.vectorPartialDecryptions) || source.vectorPartialDecryptions.length < 2) {
    throw new Error('at least two vector partial decryptions are required');
  }
  if (!Array.isArray(source.vectorBallotReceipts) || !Array.isArray(source.vectorAuditDisclosures)) {
    throw new Error('vector audit-or-cast receipts/disclosures are required');
  }
  return {
	  schema: source.keyCeremony?.mode === 'dkg-v1' ? 'mongbas-election-bundle/v5' : 'mongbas-election-bundle/v4',
    algorithms: { canonicalization: 'mongbas-canonical-json-v1', hash: 'sha-256', signature: 'ed25519', tally: 'mongbas-exp-elgamal-vector-threshold-v3' },
    configuration: source.configuration,
    provenance: source.provenance,
    publicKey: source.publicKey,
    trusteePublicShares: source.thresholdPublicShares,
	...(source.keyCeremony?.mode === 'dkg-v1' ? { keyCeremony: source.keyCeremony } : {}),
    ballots,
    bulletinBoard: { root: merkleRoot(ballots), publishedAt: source.publishedAt },
    aggregateCiphertextVector,
    tally: { results: source.tallyResults, totalVotes: source.totalVotes },
    vectorPartialDecryptions: source.vectorPartialDecryptions,
    vectorBallotReceipts: source.vectorBallotReceipts,
    vectorAuditDisclosures: source.vectorAuditDisclosures,
    signatures: [],
  };
}

function signBundle(bundle, organizationID, privateKeyPem) {
  const organization = bundle?.configuration?.organizations?.find((entry) => entry.id === organizationID);
  if (!organization) throw new Error(`organization is not configured: ${organizationID}`);
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('signing key must be Ed25519');
  const derivedPublic = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  if (derivedPublic !== organization.ed25519PublicKeyDer) throw new Error(`private key does not match configured public key for ${organizationID}`);
  const payload = Buffer.from(canonicalize(unsignedBundle(bundle)));
  const signature = crypto.sign(null, payload, privateKey).toString('base64');
  const signatures = (bundle.signatures || []).filter((entry) => entry.organizationID !== organizationID);
  signatures.push({ organizationID, signature });
  signatures.sort((left, right) => left.organizationID.localeCompare(right.organizationID));
  return { ...bundle, signatures };
}

module.exports = { buildUnsignedBundle, signBundle, splitCiphertext };
