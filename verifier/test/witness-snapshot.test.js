'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('witness SQLite snapshot is consistent, non-overwriting and rejects corruption', t => {
  if (spawnSync('python3', ['--version']).status !== 0) return t.skip('python3 is unavailable');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-witness-snapshot-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = path.join(directory, 'source.db');
  const snapshot = path.join(directory, 'snapshot.db');
  const script = path.join(__dirname, '../../deploy/linux/witness-db-snapshot.py');
  const create = 'import sqlite3,sys\ncon=sqlite3.connect(sys.argv[1])\n' +
    'con.execute("PRAGMA journal_mode=WAL")\ncon.execute("CREATE TABLE evidence(k TEXT PRIMARY KEY,v TEXT)")\n' +
    'con.execute("INSERT INTO evidence VALUES(?,?)",("checkpoint","size-2"))\ncon.commit()\n';
  assert.equal(spawnSync('python3', ['-c', create, source], { encoding: 'utf8' }).status, 0);

  const first = spawnSync(script, [source, snapshot], { encoding: 'utf8' });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /SNAPSHOT CREATED/);
  const query = spawnSync('python3', ['-c',
    'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT v FROM evidence").fetchone()[0])', snapshot],
  { encoding: 'utf8' });
  assert.equal(query.status, 0); assert.equal(query.stdout.trim(), 'size-2');

  const duplicate = spawnSync(script, [source, snapshot], { encoding: 'utf8' });
  assert.equal(duplicate.status, 1); assert.match(duplicate.stderr, /already exists/);
  assert.equal(spawnSync('python3', ['-c',
    'import sqlite3,sys; print(sqlite3.connect(sys.argv[1]).execute("SELECT v FROM evidence").fetchone()[0])', snapshot],
  { encoding: 'utf8' }).stdout.trim(), 'size-2');

  const corrupt = path.join(directory, 'corrupt.db');
  const rejected = path.join(directory, 'rejected.db');
  fs.writeFileSync(corrupt, Buffer.alloc(4096, 0x41));
  const invalid = spawnSync(script, [corrupt, rejected], { encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(fs.existsSync(rejected), false);
  assert.deepEqual(fs.readdirSync(directory).filter(name => name.includes('.tmp')), []);
});
