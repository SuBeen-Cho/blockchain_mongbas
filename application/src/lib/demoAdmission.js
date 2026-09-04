'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const STATE_SCHEMA = 'mongbas-demo-admission-state/v1';
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const ELECTION_RE = /^[A-Za-z0-9._-]{1,256}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_RECORDS = 10_000;
const MAX_TTL_MS = 15 * 60 * 1000;
const USED_RETENTION_MS = 24 * 60 * 60 * 1000;

function tokenHash(token) {
  return crypto.createHash('sha256').update('mongbas/demo-admission/v1\0').update(token).digest('hex');
}

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) throw new Error(`${label}: fields mismatch`);
}

function validateState(state) {
  exactKeys(state, ['schema', 'records'], 'demo admission state');
  if (state.schema !== STATE_SCHEMA || !state.records || typeof state.records !== 'object' || Array.isArray(state.records)) {
    throw new Error('demo admission state: invalid schema');
  }
  for (const [hash, record] of Object.entries(state.records)) {
    if (!HASH_RE.test(hash)) throw new Error('demo admission state: invalid record hash');
    exactKeys(record, ['electionID', 'expiresAt', 'usedAt'], `demo admission ${hash}`);
    if (!ELECTION_RE.test(record.electionID) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt < 0 ||
        (record.usedAt !== null && (!Number.isSafeInteger(record.usedAt) || record.usedAt < 0))) {
      throw new Error('demo admission state: invalid record');
    }
  }
  if (Object.keys(state.records).length > MAX_RECORDS) throw new Error('demo admission state: too many records');
  return state;
}

class DemoAdmissionStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath.length === 0) throw new Error('demo admission state path is required');
    this.filePath = path.resolve(filePath);
    this.directory = path.dirname(this.filePath);
    this.lockPath = `${this.filePath}.lock`;
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const directory = fs.lstatSync(this.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('demo admission directory must be a regular non-symlink directory');
    if (fs.existsSync(this.filePath)) this._load();
  }

  _load() {
    const stat = fs.lstatSync(this.filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('demo admission state must be a regular non-symlink file');
    if (stat.size > MAX_STATE_BYTES) throw new Error('demo admission state exceeds size limit');
    const descriptor = fs.openSync(this.filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('demo admission state changed before safe open');
      const raw = fs.readFileSync(descriptor, 'utf8');
      if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error('demo admission state exceeds size limit');
      return validateState(JSON.parse(raw));
    } finally {
      fs.closeSync(descriptor);
    }
  }

  _state() {
    return fs.existsSync(this.filePath) ? this._load() : { schema: STATE_SCHEMA, records: {} };
  }

  _recoverDeadLock() {
    let before;
    try { before = fs.lstatSync(this.lockPath); } catch (error) {
      if (error.code === 'ENOENT') return true;
      throw error;
    }
    if (!before.isFile() || before.isSymbolicLink() || before.size > 32) return false;
    const descriptor = fs.openSync(this.lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let owner;
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) return false;
      const raw = fs.readFileSync(descriptor, 'utf8');
      if (!/^[1-9][0-9]*\n$/.test(raw)) return false;
      owner = Number(raw.trim());
      if (!Number.isSafeInteger(owner)) return false;
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      process.kill(owner, 0);
      return false;
    } catch (error) {
      if (error.code !== 'ESRCH') return false;
    }
    const current = fs.lstatSync(this.lockPath);
    if (!current.isFile() || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) return false;
    fs.unlinkSync(this.lockPath);
    return true;
  }

  _withLock(operation) {
    let lock;
    let lockIdentity;
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          lock = fs.openSync(this.lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
          lockIdentity = fs.fstatSync(lock);
          fs.writeFileSync(lock, `${process.pid}\n`);
          fs.fsyncSync(lock);
          break;
        } catch (error) {
          if (error.code !== 'EEXIST' || attempt !== 0 || !this._recoverDeadLock()) throw error;
        }
      }
      return operation();
    } catch (error) {
      if (error.code === 'EEXIST') throw new Error('demo admission store is busy');
      throw error;
    } finally {
      if (lock !== undefined) {
        fs.closeSync(lock);
        try {
          const current = fs.lstatSync(this.lockPath);
          if (current.isFile() && !current.isSymbolicLink() && current.dev === lockIdentity.dev && current.ino === lockIdentity.ino) {
            fs.unlinkSync(this.lockPath);
          }
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    }
  }

  _write(state) {
    validateState(state);
    const raw = `${JSON.stringify(state)}\n`;
    if (Buffer.byteLength(raw) > MAX_STATE_BYTES) throw new Error('demo admission state exceeds size limit');
    const temporary = `${this.filePath}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
    let descriptor;
    try {
      descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      fs.writeFileSync(descriptor, raw);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, this.filePath);
      fs.chmodSync(this.filePath, 0o600);
      const directoryDescriptor = fs.openSync(this.directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  _purge(state, now) {
    for (const [hash, record] of Object.entries(state.records)) {
      const retentionPoint = record.usedAt === null ? record.expiresAt : record.usedAt + USED_RETENTION_MS;
      if (retentionPoint < now) delete state.records[hash];
    }
  }

  issue(electionID, { now = Date.now(), ttlMs = 2 * 60 * 1000 } = {}) {
    if (!ELECTION_RE.test(electionID || '')) throw new Error('invalid electionID');
    if (!Number.isSafeInteger(now) || now < 0) throw new Error('invalid current time');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) throw new Error('invalid ttlMs');
    return this._withLock(() => {
      const state = this._state();
      this._purge(state, now);
      if (Object.keys(state.records).length >= MAX_RECORDS) throw new Error('demo admission capacity exceeded');
      let token;
      let hash;
      do {
        token = crypto.randomBytes(32).toString('base64url');
        hash = tokenHash(token);
      } while (state.records[hash]);
      const expiresAt = now + ttlMs;
      state.records[hash] = { electionID, expiresAt, usedAt: null };
      this._write(state);
      return { token, expiresAt };
    });
  }

  redeem(electionID, token, { now = Date.now() } = {}) {
    const unavailable = () => new Error('demo admission is invalid or unavailable');
    if (!ELECTION_RE.test(electionID || '') || !TOKEN_RE.test(token || '') || !Number.isSafeInteger(now) || now < 0) throw unavailable();
    return this._withLock(() => {
      const state = this._state();
      const hash = tokenHash(token);
      const record = state.records[hash];
      if (!record || record.electionID !== electionID || record.usedAt !== null || now > record.expiresAt) throw unavailable();
      record.usedAt = now;
      this._write(state);
      return { admissionID: hash, electionID, expiresAt: record.expiresAt };
    });
  }
}

module.exports = { DemoAdmissionStore, MAX_TTL_MS, STATE_SCHEMA, tokenHash };
