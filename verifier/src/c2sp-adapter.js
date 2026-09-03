'use strict';

const crypto = require('node:crypto');

const MAX_NOTE_BYTES = 64 * 1024;
const MAX_SIGNATURES = 16;
const MAX_CONSISTENCY_NODES = 63;
const MAX_WITNESS_REQUEST_BYTES = 128 * 1024;
const MAX_WITNESS_RESPONSE_BYTES = 64 * 1024;
const HASH_RE = /^[0-9a-f]{64}$/;
const ORIGIN_RE = /^[^\s+\u0000-\u001f\u007f]{1,255}$/u;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const EMPTY_ROOT = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex');

function exactBase64(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error(`${label}: invalid base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error(`${label}: non-canonical base64`);
  return bytes;
}

function requireOrigin(origin) {
  if (typeof origin !== 'string' || !ORIGIN_RE.test(origin)) throw new Error('C2SP origin is invalid');
  return origin;
}

function requireTreeSize(value, label = 'tree size') {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return value;
}

function requireRoot(rootHash, treeSize) {
  if (typeof rootHash !== 'string' || !HASH_RE.test(rootHash)) throw new Error('root hash must be lowercase SHA-256 hex');
  if (treeSize === 0 && rootHash !== EMPTY_ROOT) throw new Error('empty tree must use SHA-256 of the empty string');
  return rootHash;
}

function rawEd25519PublicKey(key) {
  const publicKey = key.type === 'private' ? crypto.createPublicKey(key) : key;
  if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('C2SP checkpoint key must be Ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  if (der.length !== ED25519_SPKI_PREFIX.length + 32 || !der.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)) {
    throw new Error('unexpected Ed25519 SPKI encoding');
  }
  return der.subarray(ED25519_SPKI_PREFIX.length);
}

function keyID(origin, key) {
  return crypto.createHash('sha256').update(origin).update('\n').update(Buffer.from([0x01]))
    .update(rawEd25519PublicKey(key)).digest().subarray(0, 4);
}

function cosignatureKeyID(name, key) {
  return crypto.createHash('sha256').update(name).update('\n').update(Buffer.from([0x04]))
    .update(rawEd25519PublicKey(key)).digest().subarray(0, 4);
}

function checkpointBody({ origin, treeSize, rootHash }) {
  requireOrigin(origin);
  requireTreeSize(treeSize);
  requireRoot(rootHash, treeSize);
  return `${origin}\n${treeSize}\n${Buffer.from(rootHash, 'hex').toString('base64')}\n`;
}

function createSignedCheckpoint({ origin, treeSize, rootHash, privateKeyPem }) {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('C2SP checkpoint key must be Ed25519');
  const body = checkpointBody({ origin, treeSize, rootHash });
  const payload = Buffer.concat([keyID(origin, privateKey), crypto.sign(null, Buffer.from(body, 'utf8'), privateKey)]);
  const note = `${body}\n— ${origin} ${payload.toString('base64')}\n`;
  if (Buffer.byteLength(note) > MAX_NOTE_BYTES) throw new Error('C2SP checkpoint note exceeds size limit');
  return note;
}

function parseNote(note) {
  if (typeof note !== 'string' || Buffer.byteLength(note) > MAX_NOTE_BYTES || !note.endsWith('\n')) {
    throw new Error('C2SP checkpoint note is malformed or too large');
  }
  if (/\r|[\u0000-\u0009\u000b-\u001f\u007f]/u.test(note)) throw new Error('C2SP checkpoint note contains forbidden controls');
  const separator = note.lastIndexOf('\n\n');
  if (separator < 0) throw new Error('C2SP checkpoint note is missing signature separator');
  const body = note.slice(0, separator + 1);
  const bodyLines = body.slice(0, -1).split('\n');
  if (bodyLines.length !== 3 || bodyLines.some(line => line.length === 0)) throw new Error('C2SP adapter accepts exactly three body lines');
  const origin = requireOrigin(bodyLines[0]);
  if (!/^(?:0|[1-9][0-9]*)$/.test(bodyLines[1])) throw new Error('C2SP tree size is not canonical');
  const treeSize = requireTreeSize(Number(bodyLines[1]));
  const root = exactBase64(bodyLines[2], 'C2SP root hash');
  if (root.length !== 32) throw new Error('C2SP root hash must be 32 bytes');
  const rootHash = requireRoot(root.toString('hex'), treeSize);
  const signatureLines = note.slice(separator + 2, -1).split('\n');
  if (signatureLines.length === 0 || signatureLines.length > MAX_SIGNATURES || signatureLines.some(line => !line)) {
    throw new Error('C2SP checkpoint has invalid or too many signatures');
  }
  return { body, origin, treeSize, rootHash, signatureLines };
}

function trustedPublicKey(publicKeyDer) {
  const der = exactBase64(publicKeyDer, 'trusted public key');
  const key = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
  rawEd25519PublicKey(key);
  return key;
}

function parseAndVerifySignedCheckpoint(note, trust) {
  if (!trust || typeof trust !== 'object' || Array.isArray(trust) || Object.keys(trust).sort().join('\0') !== 'origin\0publicKeyDer') {
    throw new Error('C2SP checkpoint trust must pin exact origin and public key');
  }
  const parsed = parseNote(note);
  if (parsed.origin !== trust.origin) throw new Error('C2SP checkpoint origin mismatch');
  const key = trustedPublicKey(trust.publicKeyDer);
  const expectedID = keyID(trust.origin, key);
  let validSignatures = 0;
  let trustedSeen = false;
  for (const line of parsed.signatureLines) {
    const match = /^— ([^\s+]+) ([A-Za-z0-9+/]+=*)$/u.exec(line);
    if (!match) throw new Error('C2SP signature line is malformed');
    const payload = exactBase64(match[2], 'C2SP signature');
    if (match[1] !== trust.origin || payload.length < 4 || !payload.subarray(0, 4).equals(expectedID)) continue;
    if (trustedSeen) throw new Error('C2SP checkpoint has duplicate trusted signatures');
    trustedSeen = true;
    if (payload.length !== 68 || !crypto.verify(null, Buffer.from(parsed.body, 'utf8'), key, payload.subarray(4))) {
      throw new Error('C2SP trusted signature is invalid');
    }
    validSignatures += 1;
  }
  if (validSignatures === 0) throw new Error('C2SP checkpoint has no trusted signature');
  return { origin: parsed.origin, treeSize: parsed.treeSize, rootHash: parsed.rootHash, validSignatures };
}

function requireWitnessPolicy(witnesses, quorum) {
  if (!Array.isArray(witnesses) || witnesses.length === 0 || witnesses.length > 32 ||
      !Number.isSafeInteger(quorum) || quorum < 1 || quorum > witnesses.length) {
    throw new Error('C2SP witness policy requires a valid k-of-n quorum of at most 32 witnesses');
  }
  const ids = new Set();
  const names = new Set();
  const keys = new Set();
  return witnesses.map((witness, index) => {
    if (!witness || typeof witness !== 'object' || Array.isArray(witness) ||
        Object.keys(witness).sort().join('\0') !== 'id\0name\0publicKeyDer' ||
        !/^[A-Za-z0-9_.-]{1,128}$/.test(witness.id || '')) throw new Error(`C2SP witness policy entry ${index} is invalid`);
    requireOrigin(witness.name);
    const key = trustedPublicKey(witness.publicKeyDer);
    const raw = rawEd25519PublicKey(key).toString('hex');
    if (ids.has(witness.id) || names.has(witness.name) || keys.has(raw)) throw new Error('C2SP witness policy has duplicate identity, name or key');
    ids.add(witness.id); names.add(witness.name); keys.add(raw);
    return { ...witness, key, keyID: cosignatureKeyID(witness.name, key) };
  });
}

function verifyWitnessCosignatures(note, { witnesses, quorum, nowSeconds = Math.floor(Date.now() / 1000), maxFutureSkewSeconds = 300 }) {
  requireTreeSize(nowSeconds, 'current time');
  requireTreeSize(maxFutureSkewSeconds, 'future timestamp skew');
  if (maxFutureSkewSeconds > 3600) throw new Error('future timestamp skew exceeds one hour');
  const policy = requireWitnessPolicy(witnesses, quorum);
  const parsed = parseNote(note);
  const accepted = new Map();
  for (const line of parsed.signatureLines) {
    const match = /^— ([^\s+]+) ([A-Za-z0-9+/]+=*)$/u.exec(line);
    if (!match) throw new Error('C2SP signature line is malformed');
    const payload = exactBase64(match[2], 'C2SP signature');
    const configured = policy.find(witness => witness.name === match[1] && payload.length >= 4 && payload.subarray(0, 4).equals(witness.keyID));
    if (!configured) continue;
    if (accepted.has(configured.id)) throw new Error(`duplicate C2SP witness cosignature: ${configured.id}`);
    if (payload.length !== 76) throw new Error(`invalid C2SP witness cosignature length: ${configured.id}`);
    const timestamp = Number(payload.readBigUInt64BE(4));
    if (!Number.isSafeInteger(timestamp) || timestamp === 0 || timestamp > nowSeconds + maxFutureSkewSeconds) {
      throw new Error(`invalid or future C2SP witness timestamp: ${configured.id}`);
    }
    const message = Buffer.from(`cosignature/v1\ntime ${timestamp}\n${parsed.body}`, 'utf8');
    if (!crypto.verify(null, message, configured.key, payload.subarray(12))) {
      throw new Error(`invalid C2SP witness cosignature: ${configured.id}`);
    }
    accepted.set(configured.id, timestamp);
  }
  if (accepted.size < quorum) throw new Error(`C2SP witness quorum not met: ${accepted.size}/${quorum}`);
  return { valid: true, quorum, acceptedWitnesses: [...accepted.keys()].sort(),
    timestamps: Object.fromEntries([...accepted.entries()].sort(([left], [right]) => left.localeCompare(right))) };
}

function createWitnessRequest({ oldSize, consistencyPath, signedCheckpoint }) {
  requireTreeSize(oldSize, 'old size');
  const checkpoint = parseNote(signedCheckpoint);
  if (oldSize > checkpoint.treeSize) throw new Error('old size cannot exceed checkpoint tree size');
  if (!Array.isArray(consistencyPath) || consistencyPath.length > MAX_CONSISTENCY_NODES) {
    throw new Error('consistency proof must contain at most 63 nodes');
  }
  if ((oldSize === 0 || oldSize === checkpoint.treeSize) && consistencyPath.length !== 0) {
    throw new Error('consistency proof must be empty for this old size');
  }
  if (oldSize > 0 && oldSize < checkpoint.treeSize && consistencyPath.length === 0) {
    throw new Error('consistency proof is empty for a growing tree');
  }
  const lines = consistencyPath.map((node, index) => {
    if (typeof node !== 'string' || !HASH_RE.test(node)) throw new Error(`consistency node ${index} is invalid`);
    return Buffer.from(node, 'hex').toString('base64');
  });
  const request = `old ${oldSize}\n${lines.length ? `${lines.join('\n')}\n` : ''}\n${signedCheckpoint}`;
  if (Buffer.byteLength(request) > MAX_WITNESS_REQUEST_BYTES) throw new Error('C2SP witness request exceeds size limit');
  return request;
}

function requireWitnessEndpoint(value) {
  let endpoint;
  try { endpoint = new URL(value); } catch { throw new Error('C2SP witness endpoint is invalid'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !endpoint.pathname.endsWith('/add-checkpoint')) throw new Error('C2SP witness endpoint must be an exact HTTPS add-checkpoint URL');
  return endpoint.href;
}

async function readBoundedResponse(response, maximumBytes = MAX_WITNESS_RESPONSE_BYTES) {
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^(?:0|[1-9][0-9]*)$/.test(declared) || Number(declared) > maximumBytes)) {
    throw new Error('C2SP witness response exceeds size limit');
  }
  if (!response.body || typeof response.body.getReader !== 'function') throw new Error('C2SP witness response has no readable body');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error('C2SP witness response exceeds size limit');
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total));
}

async function submitWitnessRequest({ endpoint, request, signedCheckpoint, logTrust, witnessPolicy,
  timeoutMs = 10_000, fetchImpl = globalThis.fetch }) {
  const url = requireWitnessEndpoint(endpoint);
  if (typeof request !== 'string' || Buffer.byteLength(request) > MAX_WITNESS_REQUEST_BYTES ||
      !request.endsWith(signedCheckpoint) || typeof fetchImpl !== 'function') throw new Error('invalid C2SP witness submission input');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 60_000) throw new Error('C2SP witness timeout is invalid');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let responseBody;
  try {
    response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/octet-stream' },
      body: request, redirect: 'error', signal: controller.signal });
    responseBody = await readBoundedResponse(response);
  } finally {
    clearTimeout(timer);
  }
  if (response.status === 409) {
    const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'text/x.tlog.size' || !/^(?:0|[1-9][0-9]*)\n$/.test(responseBody)) {
      throw new Error('C2SP witness returned a malformed conflict');
    }
    throw new Error(`C2SP witness state conflict at tree size ${responseBody.trim()}`);
  }
  if (response.status !== 200) throw new Error(`C2SP witness rejected checkpoint with HTTP ${response.status}`);
  if (!responseBody.endsWith('\n') || responseBody.includes('\n\n')) throw new Error('C2SP witness returned malformed cosignature lines');
  const lines = responseBody.slice(0, -1).split('\n');
  if (lines.length === 0 || lines.length > MAX_SIGNATURES || lines.some(line => !/^— [^\s+]+ [A-Za-z0-9+/]+=*$/u.test(line))) {
    throw new Error('C2SP witness returned malformed or excessive cosignatures');
  }
  const cosignedCheckpoint = `${signedCheckpoint.trimEnd()}\n${responseBody}`;
  parseAndVerifySignedCheckpoint(cosignedCheckpoint, logTrust);
  const quorumResult = verifyWitnessCosignatures(cosignedCheckpoint, { witnesses: witnessPolicy.witnesses,
    quorum: witnessPolicy.quorum });
  return { cosignedCheckpoint, quorumResult };
}

function createC2spSubmissionFromV3Log({ origin, checkpointLog, trust, logPrivateKeyPem, previousSignedCheckpoint = null }) {
  const { CHECKPOINT_V3_SCHEMA, verifyCheckpointLog } = require('./witness');
  if (!Array.isArray(checkpointLog) || checkpointLog.length === 0) throw new Error('checkpoint-v3 log is required');
  verifyCheckpointLog(checkpointLog, trust);
  if (checkpointLog.some(checkpoint => checkpoint.schema !== CHECKPOINT_V3_SCHEMA)) {
    throw new Error('C2SP adapter requires a checkpoint-v3 log');
  }
  const checkpoint = checkpointLog.at(-1);
  const logPrivateKey = crypto.createPrivateKey(logPrivateKeyPem);
  const logPublicDer = crypto.createPublicKey(logPrivateKey).export({ format: 'der', type: 'spki' }).toString('base64');
  if (logPublicDer === checkpoint.witnessPublicKeyDer) throw new Error('C2SP log operator and Mongbas witness keys must be distinct');
  if (checkpoint.history.treeSize === 0) {
    if (previousSignedCheckpoint !== null) throw new Error('C2SP opening must not replace an existing operator checkpoint');
  } else {
    if (typeof previousSignedCheckpoint !== 'string') throw new Error('C2SP growing tree requires the previous operator checkpoint');
    const previous = parseAndVerifySignedCheckpoint(previousSignedCheckpoint, { origin, publicKeyDer: logPublicDer });
    if (previous.treeSize !== checkpoint.history.previousTreeSize || previous.rootHash !== checkpoint.history.previousRootHash) {
      throw new Error('C2SP previous operator checkpoint does not match the verified history prefix');
    }
  }
  const signedCheckpoint = createSignedCheckpoint({ origin, treeSize: checkpoint.history.treeSize,
    rootHash: checkpoint.history.rootHash, privateKeyPem: logPrivateKeyPem });
  const witnessRequest = createWitnessRequest({ oldSize: checkpoint.history.previousTreeSize,
    consistencyPath: checkpoint.history.consistencyPath, signedCheckpoint });
  return { signedCheckpoint, witnessRequest, treeSize: checkpoint.history.treeSize,
    rootHash: checkpoint.history.rootHash, sourceSequence: checkpoint.sequence };
}

module.exports = {
  MAX_CONSISTENCY_NODES,
  MAX_NOTE_BYTES,
  MAX_WITNESS_REQUEST_BYTES,
  MAX_WITNESS_RESPONSE_BYTES,
  createC2spSubmissionFromV3Log,
  createSignedCheckpoint,
  createWitnessRequest,
  parseAndVerifySignedCheckpoint,
  submitWitnessRequest,
  verifyWitnessCosignatures,
};
