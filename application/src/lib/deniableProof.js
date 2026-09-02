'use strict';

const crypto = require('node:crypto');

const RESPONSE_BYTES = 8192;

function isCanonicalToken(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function deriveLookupToken(password, verificationNonce, electionID) {
  if (typeof password !== 'string' || password.length < 8) throw new Error('password must contain at least 8 characters');
  if (!isCanonicalToken(verificationNonce)) throw new Error('verificationNonce must be 64 lowercase hex characters');
  if (typeof electionID !== 'string' || !electionID) throw new Error('electionID is required');
  const fields = ['mongbas-deniable-lookup-v1', electionID, verificationNonce, password];
  const hash = crypto.createHash('sha256');
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length);
    hash.update(length).update(bytes);
  }
  return hash.digest('hex');
}

function serializeFixedProof(electionID, chaincodeProof, targetBytes = RESPONSE_BYTES) {
  if (typeof electionID !== 'string' || !electionID) throw new Error('electionID is required');
  if (!chaincodeProof || !isCanonicalToken(chaincodeProof.leafHash) || !Array.isArray(chaincodeProof.proof)) {
    throw new Error('invalid chaincode proof');
  }
  const publicProof = {
    schema: 'mongbas-deniable-proof/v2',
    electionID,
    proof: {
      leafHash: chaincodeProof.leafHash,
      proof: chaincodeProof.proof.map(node => ({ hash: node.hash, position: node.position })),
    },
    padding: '',
  };
  const unpadded = JSON.stringify(publicProof);
  const missing = targetBytes - Buffer.byteLength(unpadded, 'utf8');
  if (missing < 0) throw new Error(`deniable proof exceeds fixed response size ${targetBytes}`);
  publicProof.padding = '0'.repeat(missing);
  const serialized = JSON.stringify(publicProof);
  if (Buffer.byteLength(serialized, 'utf8') !== targetBytes) throw new Error('fixed proof serialization length mismatch');
  return serialized;
}

module.exports = { RESPONSE_BYTES, deriveLookupToken, isCanonicalToken, serializeFixedProof };
