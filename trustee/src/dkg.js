'use strict';

const crypto = require('node:crypto');

const P_HEX = [
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1',
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD',
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245',
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED',
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D',
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F',
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D',
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B',
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9',
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510',
  '15728E5A8AACAA68FFFFFFFFFFFFFFFF',
].join('').toLowerCase();
const P = BigInt(`0x${P_HEX}`);
const G = 2n;
const Q = (P - 1n) / 2n;
const THRESHOLD = 2;
const TOTAL = 3;

function canonicalize(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error('non-canonical value');
}

function modPow(base, exponent, modulus) {
  let result = 1n;
  let x = ((base % modulus) + modulus) % modulus;
  let e = exponent;
  if (e < 0n) throw new Error('negative exponent');
  while (e > 0n) {
    if (e & 1n) result = (result * x) % modulus;
    x = (x * x) % modulus;
    e >>= 1n;
  }
  return result;
}

function randomScalar() {
  while (true) {
    const candidate = BigInt(`0x${crypto.randomBytes(32).toString('hex')}`) % Q;
    if (candidate > 0n) return candidate;
  }
}

function parseScalar(value, label) {
  if (typeof value !== 'string' || !/^[1-9a-f][0-9a-f]*$/.test(value)) throw new Error(`${label}: non-canonical scalar`);
  const parsed = BigInt(`0x${value}`);
  if (parsed <= 0n || parsed >= Q) throw new Error(`${label}: scalar out of range`);
  return parsed;
}

function parseElement(value, label) {
  if (typeof value !== 'string' || !/^[1-9a-f][0-9a-f]*$/.test(value)) throw new Error(`${label}: non-canonical group element`);
  const parsed = BigInt(`0x${value}`);
  if (parsed <= 1n || parsed >= P || modPow(parsed, Q, P) !== 1n) throw new Error(`${label}: invalid subgroup element`);
  return parsed;
}

function validateCeremonyID(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) throw new Error('invalid ceremony ID');
}

function normalizeParticipants(participants) {
  if (!Array.isArray(participants) || participants.length !== TOTAL) throw new Error(`exactly ${TOTAL} participants required`);
  const seenIDs = new Set();
  const seenIndexes = new Set();
  const normalized = participants.map(participant => {
    if (!participant || typeof participant.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(participant.id) || seenIDs.has(participant.id)) {
      throw new Error('invalid or duplicate participant ID');
    }
    if (!Number.isSafeInteger(participant.index) || participant.index < 1 || participant.index > TOTAL || seenIndexes.has(participant.index)) {
      throw new Error('invalid or duplicate participant index');
    }
    let key;
    let signingKey;
    try {
      key = crypto.createPublicKey({ key: Buffer.from(participant.transportPublicKeyDer, 'base64'), format: 'der', type: 'spki' });
      signingKey = crypto.createPublicKey({ key: Buffer.from(participant.signingPublicKeyDer, 'base64'), format: 'der', type: 'spki' });
    } catch {
      throw new Error(`invalid transport key for ${participant.id}`);
    }
    if (key.asymmetricKeyType !== 'x25519' || key.export({ format: 'der', type: 'spki' }).toString('base64') !== participant.transportPublicKeyDer) {
      throw new Error(`non-canonical X25519 transport key for ${participant.id}`);
    }
    if (signingKey.asymmetricKeyType !== 'ed25519' || signingKey.export({ format: 'der', type: 'spki' }).toString('base64') !== participant.signingPublicKeyDer) {
      throw new Error(`non-canonical Ed25519 signing key for ${participant.id}`);
    }
    seenIDs.add(participant.id);
    seenIndexes.add(participant.index);
    return { id: participant.id, index: participant.index, transportPublicKeyDer: participant.transportPublicKeyDer,
      signingPublicKeyDer: participant.signingPublicKeyDer };
  });
  return normalized.sort((a, b) => a.index - b.index);
}

function generateTransportKeyPair(id, index) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) throw new Error('invalid trustee ID');
  if (!Number.isSafeInteger(index) || index < 1 || index > TOTAL) throw new Error('invalid trustee index');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
  const signing = crypto.generateKeyPairSync('ed25519');
  return {
    publicDescriptor: {
      schema: 'mongbas-dkg-transport-key/v1', id, index,
      transportPublicKeyDer: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      signingPublicKeyDer: signing.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    },
    privateRecord: {
      schema: 'mongbas-dkg-transport-private/v1', id, index,
      transportPrivateKeyDer: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
      signingPrivateKeyDer: signing.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
    },
  };
}

function envelopeAAD({ ceremonyID, dealerID, recipientID, recipientIndex, commitments }) {
  return Buffer.from(canonicalize({
    schema: 'mongbas-dkg-share-envelope/v1', ceremonyID, dealerID,
    recipientID, recipientIndex, commitments,
  }));
}

function deriveEnvelopeKey(sharedSecret, ceremonyID, dealerID, recipientID) {
  return Buffer.from(crypto.hkdfSync(
    'sha256', sharedSecret,
    crypto.createHash('sha256').update(`mongbas-dkg-salt/v1|${ceremonyID}`).digest(),
    Buffer.from(`mongbas-dkg-share/v1|${dealerID}|${recipientID}`), 32,
  ));
}

function createContribution({ ceremonyID, dealerID, privateRecord, participants }) {
  validateCeremonyID(ceremonyID);
  const roster = normalizeParticipants(participants);
  if (!roster.some(item => item.id === dealerID)) throw new Error('dealer is not in participant roster');
  if (privateRecord?.schema !== 'mongbas-dkg-transport-private/v1' || privateRecord.id !== dealerID) {
    throw new Error('dealer private record mismatch');
  }
  const constant = randomScalar();
  const linear = randomScalar();
  const commitments = {
    constant: modPow(G, constant, P).toString(16),
    linear: modPow(G, linear, P).toString(16),
  };
  const encryptedShares = roster.map(recipient => {
    const share = (constant + linear * BigInt(recipient.index)) % Q;
    if (share === 0n) throw new Error('zero DKG share; regenerate contribution');
    const recipientKey = crypto.createPublicKey({
      key: Buffer.from(recipient.transportPublicKeyDer, 'base64'), format: 'der', type: 'spki',
    });
    const ephemeral = crypto.generateKeyPairSync('x25519');
    const shared = crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey });
    const key = deriveEnvelopeKey(shared, ceremonyID, dealerID, recipient.id);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(envelopeAAD({ ceremonyID, dealerID, recipientID: recipient.id, recipientIndex: recipient.index, commitments }));
    const ciphertext = Buffer.concat([cipher.update(share.toString(16), 'utf8'), cipher.final()]);
    return {
      recipientID: recipient.id,
      recipientIndex: recipient.index,
      ephemeralPublicKeyDer: ephemeral.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
      iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64'),
    };
  });
  const core = {
    schema: 'mongbas-feldman-dkg-contribution/v1', ceremonyID, dealerID,
    threshold: THRESHOLD, totalTrustees: TOTAL, commitments, encryptedShares,
  };
  const signingKey = crypto.createPrivateKey({
    key: Buffer.from(privateRecord.signingPrivateKeyDer, 'base64'), format: 'der', type: 'pkcs8',
  });
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('dealer signing key is not Ed25519');
  return { ...core, signature: crypto.sign(null, Buffer.from(canonicalize(core)), signingKey).toString('base64') };
}

function validateContribution(contribution, ceremonyID, roster) {
  if (!contribution || contribution.schema !== 'mongbas-feldman-dkg-contribution/v1' || contribution.ceremonyID !== ceremonyID ||
      contribution.threshold !== THRESHOLD || contribution.totalTrustees !== TOTAL ||
      !roster.some(item => item.id === contribution.dealerID)) throw new Error('invalid DKG contribution envelope');
  const { signature, ...core } = contribution;
  const dealer = roster.find(item => item.id === contribution.dealerID);
  const signingKey = crypto.createPublicKey({ key: Buffer.from(dealer.signingPublicKeyDer, 'base64'), format: 'der', type: 'spki' });
  if (typeof signature !== 'string' || !crypto.verify(null, Buffer.from(canonicalize(core)), signingKey, Buffer.from(signature, 'base64'))) {
    throw new Error(`invalid DKG contribution signature for ${contribution.dealerID}`);
  }
  parseElement(contribution.commitments?.constant, 'constant commitment');
  parseElement(contribution.commitments?.linear, 'linear commitment');
  if (!Array.isArray(contribution.encryptedShares) || contribution.encryptedShares.length !== TOTAL) throw new Error('incomplete encrypted-share set');
  const recipients = new Set(contribution.encryptedShares.map(item => `${item.recipientID}:${item.recipientIndex}`));
  if (recipients.size !== TOTAL || roster.some(item => !recipients.has(`${item.id}:${item.index}`))) throw new Error('encrypted-share roster mismatch');
}

const COMPLAINT_REASONS = new Set([
  'missing-contribution', 'invalid-signature', 'incomplete-recipient-set',
  'envelope-authentication-failed', 'share-out-of-range', 'feldman-equation-failed',
]);

function createComplaint({ ceremonyID, complainerID, dealerID, reason, contributionHash, evidenceHash,
  privateRecord, participants }) {
  validateCeremonyID(ceremonyID);
  const roster = normalizeParticipants(participants);
  const complainer = roster.find(item => item.id === complainerID);
  if (!complainer || !roster.some(item => item.id === dealerID) || complainerID === dealerID ||
      privateRecord?.schema !== 'mongbas-dkg-transport-private/v1' || privateRecord.id !== complainerID ||
      !COMPLAINT_REASONS.has(reason) || !/^[0-9a-f]{64}$/.test(contributionHash) || !/^[0-9a-f]{64}$/.test(evidenceHash)) {
    throw new Error('invalid DKG complaint input');
  }
  const core = { schema: 'mongbas-dkg-complaint/v1', ceremonyID, complainerID, complainerIndex: complainer.index,
    dealerID, reason, contributionHash, evidenceHash };
  const complaintID = crypto.createHash('sha256').update(canonicalize(core)).digest('hex');
  const signed = { ...core, complaintID };
  const signingKey = crypto.createPrivateKey({
    key: Buffer.from(privateRecord.signingPrivateKeyDer, 'base64'), format: 'der', type: 'pkcs8',
  });
  if (signingKey.asymmetricKeyType !== 'ed25519') throw new Error('complainer signing key is not Ed25519');
  return { ...signed, signature: crypto.sign(null, Buffer.from(canonicalize(signed)), signingKey).toString('base64') };
}

function validateComplaint(complaint, ceremonyID, roster) {
  if (!complaint || complaint.schema !== 'mongbas-dkg-complaint/v1' || complaint.ceremonyID !== ceremonyID ||
      !COMPLAINT_REASONS.has(complaint.reason) || !/^[0-9a-f]{64}$/.test(complaint.contributionHash) ||
      !/^[0-9a-f]{64}$/.test(complaint.evidenceHash) || !/^[0-9a-f]{64}$/.test(complaint.complaintID)) {
    throw new Error('invalid DKG complaint artifact');
  }
  const complainer = roster.find(item => item.id === complaint.complainerID);
  if (!complainer || complainer.index !== complaint.complainerIndex || complaint.complainerID === complaint.dealerID ||
      !roster.some(item => item.id === complaint.dealerID)) throw new Error('DKG complaint roster binding invalid');
  const { signature, ...signed } = complaint;
  const { complaintID, ...core } = signed;
  if (crypto.createHash('sha256').update(canonicalize(core)).digest('hex') !== complaintID) throw new Error('DKG complaint ID mismatch');
  const signingKey = crypto.createPublicKey({
    key: Buffer.from(complainer.signingPublicKeyDer, 'base64'), format: 'der', type: 'spki',
  });
  if (typeof signature !== 'string' || !crypto.verify(null, Buffer.from(canonicalize(signed)), signingKey, Buffer.from(signature, 'base64'))) {
    throw new Error('DKG complaint signature invalid');
  }
  return complaintID;
}

function finalizeTrusteeShare({ ceremonyID, trusteeID, privateRecord, participants, contributions }) {
  validateCeremonyID(ceremonyID);
  const roster = normalizeParticipants(participants);
  const trustee = roster.find(item => item.id === trusteeID);
  if (!trustee || privateRecord?.schema !== 'mongbas-dkg-transport-private/v1' ||
      privateRecord.id !== trusteeID || privateRecord.index !== trustee.index) throw new Error('trustee private record mismatch');
  if (!Array.isArray(contributions) || contributions.length !== TOTAL || new Set(contributions.map(item => item.dealerID)).size !== TOTAL) {
    throw new Error('one contribution from every trustee is required');
  }
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateRecord.transportPrivateKeyDer, 'base64'), format: 'der', type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'x25519') throw new Error('trustee transport key is not X25519');
  let aggregateShare = 0n;
  for (const contribution of contributions) {
    validateContribution(contribution, ceremonyID, roster);
    const envelope = contribution.encryptedShares.find(item => item.recipientID === trustee.id && item.recipientIndex === trustee.index);
    const ephemeralPublicKey = crypto.createPublicKey({
      key: Buffer.from(envelope.ephemeralPublicKeyDer, 'base64'), format: 'der', type: 'spki',
    });
    if (ephemeralPublicKey.asymmetricKeyType !== 'x25519') throw new Error('envelope ephemeral key is not X25519');
    const shared = crypto.diffieHellman({ privateKey, publicKey: ephemeralPublicKey });
    const key = deriveEnvelopeKey(shared, ceremonyID, contribution.dealerID, trustee.id);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
    decipher.setAAD(envelopeAAD({ ceremonyID, dealerID: contribution.dealerID, recipientID: trustee.id,
      recipientIndex: trustee.index, commitments: contribution.commitments }));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    let plaintext;
    try {
      plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString('utf8');
    } catch {
      throw new Error(`encrypted share authentication failed for dealer ${contribution.dealerID}`);
    }
    const share = parseScalar(plaintext, `share from ${contribution.dealerID}`);
    const constantCommitment = parseElement(contribution.commitments.constant, 'constant commitment');
    const linearCommitment = parseElement(contribution.commitments.linear, 'linear commitment');
    const expected = constantCommitment * modPow(linearCommitment, BigInt(trustee.index), P) % P;
    if (modPow(G, share, P) !== expected) throw new Error(`Feldman share verification failed for dealer ${contribution.dealerID}`);
    aggregateShare = (aggregateShare + share) % Q;
  }
  if (aggregateShare === 0n) throw new Error('aggregate trustee share is zero');
  const publicKeyY = modPow(G, aggregateShare, P).toString(16);
  return {
    privateShare: {
      schema: 'mongbas-dkg-trustee-share/v1', ceremonyID, trusteeID,
      trusteeIndex: trustee.index, scalar: aggregateShare.toString(16),
    },
    publicShare: {
      schema: 'mongbas-dkg-public-share/v1', ceremonyID, trusteeID,
      trusteeIndex: trustee.index, publicKeyY,
    },
  };
}

function finalizeTranscript({ ceremonyID, participants, contributions, publicShares, complaints = [] }) {
  validateCeremonyID(ceremonyID);
  const roster = normalizeParticipants(participants);
	if (!Array.isArray(complaints)) throw new Error('complaints must be an array');
	const complaintIDs = complaints.map(item => validateComplaint(item, ceremonyID, roster));
	if (new Set(complaintIDs).size !== complaintIDs.length) throw new Error('duplicate DKG complaint');
	if (complaintIDs.length > 0) {
	  throw new Error(`DKG ceremony aborted by authenticated complaint(s): ${complaintIDs.sort().join(',')}`);
	}
  if (!Array.isArray(contributions) || contributions.length !== TOTAL || new Set(contributions.map(item => item.dealerID)).size !== TOTAL) {
    throw new Error('complete unique contribution set required');
  }
  contributions.forEach(item => validateContribution(item, ceremonyID, roster));
  if (!Array.isArray(publicShares) || publicShares.length !== TOTAL) throw new Error('complete public-share set required');
  const shareByID = new Map(publicShares.map(item => [item.trusteeID, item]));
  if (shareByID.size !== TOTAL) throw new Error('duplicate public trustee share');
  for (const trustee of roster) {
    const published = shareByID.get(trustee.id);
    if (!published || published.schema !== 'mongbas-dkg-public-share/v1' || published.ceremonyID !== ceremonyID ||
        published.trusteeIndex !== trustee.index) throw new Error(`invalid public share for ${trustee.id}`);
    const actual = parseElement(published.publicKeyY, `public share ${trustee.id}`);
    let expected = 1n;
    for (const contribution of contributions) {
      const constantCommitment = parseElement(contribution.commitments.constant, 'constant commitment');
      const linearCommitment = parseElement(contribution.commitments.linear, 'linear commitment');
      expected = expected * constantCommitment % P;
      expected = expected * modPow(linearCommitment, BigInt(trustee.index), P) % P;
    }
    if (actual !== expected) throw new Error(`aggregate public share mismatch for ${trustee.id}`);
  }
  let electionPublicKeyY = 1n;
  for (const contribution of contributions) {
    electionPublicKeyY = electionPublicKeyY * parseElement(contribution.commitments.constant, 'constant commitment') % P;
  }
  const transcriptCore = {
    schema: 'mongbas-feldman-dkg-transcript/v1', ceremonyID,
    threshold: THRESHOLD, totalTrustees: TOTAL,
    group: { p: P_HEX, g: G.toString(16), q: Q.toString(16) },
    participants: roster,
    contributions: contributions.map(item => ({ dealerID: item.dealerID, commitments: item.commitments,
      contributionHash: crypto.createHash('sha256').update(canonicalize(item)).digest('hex') }))
      .sort((a, b) => a.dealerID.localeCompare(b.dealerID)),
    publicShares: publicShares.slice().sort((a, b) => a.trusteeIndex - b.trusteeIndex),
    electionPublicKeyY: electionPublicKeyY.toString(16),
  };
  return { ...transcriptCore, transcriptHash: crypto.createHash('sha256').update(canonicalize(transcriptCore)).digest('hex') };
}

function scalarBytes(value) {
  let encoded = value.toString(16);
  if (encoded.length % 2) encoded = `0${encoded}`;
  return Buffer.from(encoded, 'hex');
}

function createVectorPartialDecryption({ privateShare, electionID, encryptedAggregateVector }) {
  if (!privateShare || privateShare.schema !== 'mongbas-dkg-trustee-share/v1' ||
      typeof privateShare.ceremonyID !== 'string' || privateShare.ceremonyID.length === 0 || typeof privateShare.trusteeID !== 'string' ||
      !Number.isSafeInteger(privateShare.trusteeIndex) || privateShare.trusteeIndex < 1 || privateShare.trusteeIndex > TOTAL ||
      typeof electionID !== 'string' || !/^[A-Za-z0-9._-]{1,256}$/.test(electionID) ||
      !Array.isArray(encryptedAggregateVector) || encryptedAggregateVector.length < 2) {
    throw new Error('invalid trustee share or vector aggregate');
  }
  const secret = parseScalar(privateShare.scalar, 'trustee scalar');
  const publicKeyY = modPow(G, secret, P).toString(16);
  const values = [];
  const proofs = [];
  encryptedAggregateVector.forEach((aggregate, candidateIndex) => {
    const c1 = parseElement(aggregate?.c1, `aggregate c1 ${candidateIndex}`);
    parseElement(aggregate?.c2, `aggregate c2 ${candidateIndex}`);
    const value = modPow(c1, secret, P);
    const c1Hex = c1.toString(16);
    const valueHex = value.toString(16);
    const domain = `vector-threshold-partial:${privateShare.trusteeIndex}:${candidateIndex}`;
    const nonceInput = Buffer.concat([
      scalarBytes(secret), Buffer.from(`${c1Hex}${valueHex}${electionID}${domain}`),
    ]);
    let nonce = BigInt(`0x${crypto.createHash('sha256').update(nonceInput).digest('hex')}`) % Q;
    if (nonce === 0n) nonce = 1n;
    const a1 = modPow(G, nonce, P);
    const a2 = modPow(c1, nonce, P);
    const transcript = `${G.toString(16)}|${publicKeyY}|${c1Hex}|${valueHex}|${a1.toString(16)}|${a2.toString(16)}`;
    const challenge = BigInt(`0x${crypto.createHash('sha256').update(transcript).digest('hex')}`) % Q;
    const response = (nonce + challenge * secret) % Q;
    values.push(valueHex);
    proofs.push({
      nullifierHash: domain,
      c1: c1Hex,
      c2: valueHex,
      decryptedHash: '',
      a1: a1.toString(16),
      a2: a2.toString(16),
      e: challenge.toString(16),
      z: response.toString(16),
    });
  });
  return {
    index: privateShare.trusteeIndex,
    mspID: privateShare.trusteeID,
    publicKeyY,
    values,
    proofs,
  };
}

module.exports = {
  P_HEX, P, G, Q, THRESHOLD, TOTAL, canonicalize, modPow,
  generateTransportKeyPair, createContribution, finalizeTrusteeShare, finalizeTranscript,
  createComplaint, validateComplaint, createVectorPartialDecryption,
};
