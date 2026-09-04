'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  PAGE_SIZE, computeIndexHash, computeIdentifierPageHash, computeArtifactPageHash,
  validateIndex, collectPagedBulletin,
} = require('../src/lib/pagedBulletin');
const { exportPagedBulletinToDirectory } = require('../src/lib/pagedBulletinSpool');

function id(number) {
  return crypto.createHash('sha256').update(`paged-fixture-${number}`).digest('hex');
}

function fixture(ballotCount = PAGE_SIZE + 1) {
  const electionID = 'paged-election';
  const publishedAt = 123;
  const ballotIDs = Array.from({ length: ballotCount }, (_, index) => id(index));
  const receiptIDs = Array.from({ length: ballotCount }, (_, index) => id(index + 10_000));
  const sections = { ballots: ballotIDs, receipts: receiptIDs, disclosures: [] };
  const pageHashes = {};
  for (const [section, identifiers] of Object.entries(sections)) {
    pageHashes[section] = [];
    for (let offset = 0; offset < identifiers.length; offset += PAGE_SIZE) {
      const pageNumber = offset / PAGE_SIZE;
      const nextOffset = Math.min(offset + PAGE_SIZE, identifiers.length);
      pageHashes[section].push(computeIdentifierPageHash({
        electionID, publishedAt, section, pageNumber, offset, nextOffset,
        total: identifiers.length, identifiers: identifiers.slice(offset, nextOffset),
      }));
    }
  }
  const index = {
    schema: 'mongbas-bulletin-board-index/v1', electionID, publishedAt, pageSize: PAGE_SIZE,
    ballotCount, receiptCount: ballotCount, disclosureCount: 0,
    ballotPageHashes: pageHashes.ballots, receiptPageHashes: pageHashes.receipts,
    disclosurePageHashes: pageHashes.disclosures,
  };
  index.indexHash = computeIndexHash(index);
  const manifest = {
    docType: 'bulletinBoard', electionID, publishedAt, totalVotes: ballotCount,
    encryptionMode: 'elgamal-vector-v3', encryptedBallots: [], decryptionProofs: [],
    vectorBallotReceipts: [], vectorAuditDisclosures: [],
  };
  return { electionID, publishedAt, sections, index, manifest };
}

function artifactPage(data, section, offset) {
  const identifiers = data.sections[section];
  const nextOffset = Math.min(offset + PAGE_SIZE, identifiers.length);
  const property = section;
  const idProperty = section === 'ballots' ? 'nullifierHash' : 'ballotID';
  const page = {
    schema: 'mongbas-bulletin-board-page/v1', electionID: data.electionID,
    publishedAt: data.publishedAt, indexHash: data.index.indexHash, section,
    offset, nextOffset, total: identifiers.length,
    [property]: identifiers.slice(offset, nextOffset).map(identifier => ({ [idProperty]: identifier })),
  };
  page.pageHash = computeArtifactPageHash(page);
  return page;
}

function fakeContract(data, mutatePage = page => page) {
  return {
    async evaluateTransaction(name, ...args) {
      if (name === 'GetBulletinBoardManifest') return Buffer.from(JSON.stringify(data.manifest));
      if (name === 'GetBulletinBoardIndex') return Buffer.from(JSON.stringify(data.index));
      if (name === 'GetBulletinBoardPage') {
        const page = artifactPage(data, args[1], Number(args[2]));
        return Buffer.from(JSON.stringify(mutatePage(page, args[1], Number(args[2]))));
      }
      throw new Error(`unexpected transaction ${name}`);
    },
  };
}

test('paged collector authenticates complete bounded pages and preserves order', async () => {
  const data = fixture();
  const result = await collectPagedBulletin(fakeContract(data), data.electionID);
  assert.equal(result.manifest.encryptedBallots.length, PAGE_SIZE + 1);
  assert.equal(result.manifest.vectorBallotReceipts.length, PAGE_SIZE + 1);
  assert.deepEqual(result.manifest.encryptedBallots.map(ballot => ballot.nullifierHash), data.sections.ballots);
  assert.equal(result.index.indexHash, data.index.indexHash);
});

test('paged hash transcript matches the frozen Go vectors', () => {
  const index = {
    schema: 'mongbas-bulletin-board-index/v1', electionID: 'cross-language', publishedAt: 1700000000,
    pageSize: 100, ballotCount: 2, receiptCount: 0, disclosureCount: 0,
    ballotPageHashes: ['a'.repeat(64)], receiptPageHashes: [], disclosurePageHashes: [],
  };
  assert.equal(computeIndexHash(index), '20d6df9c3e9f7a8f310b47ccb953699114be845d21d63834f569880419a40531');
  assert.equal(computeIdentifierPageHash({
    electionID: 'cross-language', publishedAt: 1700000000, section: 'ballots', pageNumber: 0,
    offset: 0, nextOffset: 2, total: 2, identifiers: ['b'.repeat(64), 'c'.repeat(64)],
  }), '0f9185fd036beea2f3bac69bfa39279ca607efa1c62fc89b32d7fb203523a862');
  const page = {
    schema: 'mongbas-bulletin-board-page/v1', electionID: 'cross-language', publishedAt: 1700000000,
    indexHash: 'a'.repeat(64), section: 'ballots', offset: 0, nextOffset: 1, total: 1,
    ballots: [{ nullifierHash: 'b'.repeat(64), encryptedCandidateID: '', candidateCommitment: 'c'.repeat(64), preparedBallotID: 'd'.repeat(64) }],
  };
  assert.equal(computeArtifactPageHash(page), '926fbbff1f03403399624f568722b2ab20d349c968beb8ede749d1c130b2b6b6');
});

test('paged index is bound to its publication manifest', () => {
  const data = fixture(1);
  assert.doesNotThrow(() => validateIndex(data.index, data.manifest, data.electionID));
  assert.throws(() => validateIndex(data.index, { ...data.manifest, publishedAt: 124 }, data.electionID), /manifest/);
  assert.throws(() => validateIndex({ ...data.index, ballotCount: 2 }, data.manifest, data.electionID));
});

test('paged collector rejects reordered content even with a recomputed artifact hash', async () => {
  const data = fixture();
  const contract = fakeContract(data, (page, section, offset) => {
    if (section === 'ballots' && offset === 0) {
      page.ballots.reverse();
      page.pageHash = computeArtifactPageHash(page);
    }
    return page;
  });
  await assert.rejects(collectPagedBulletin(contract, data.electionID), /identifier-page hash mismatch/);
});

test('paged collector rejects content mutation without an artifact page hash', async () => {
  const data = fixture(1);
  const contract = fakeContract(data, (page, section) => {
    if (section === 'ballots') page.ballots[0].candidateCommitment = id(99_999);
    return page;
  });
  await assert.rejects(collectPagedBulletin(contract, data.electionID), /artifact-page hash mismatch/);
});

test('protected paged spool resumes only from authenticated complete pages', async () => {
  const data = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mongbas-paged-spool-'));
  fs.chmodSync(directory, 0o700);
  try {
    const first = await exportPagedBulletinToDirectory(fakeContract(data), data.electionID, directory);
    assert.equal(first.fetchedPages, 4);
    assert.equal(first.reusedPages, 0);
    const second = await exportPagedBulletinToDirectory(fakeContract(data), data.electionID, directory);
    assert.equal(second.fetchedPages, 0);
    assert.equal(second.reusedPages, 4);
    assert.deepEqual(second.board.encryptedBallots.map(ballot => ballot.nullifierHash), data.sections.ballots);

    const pageFile = path.join(directory, 'ballots', '000000.json');
    const page = JSON.parse(fs.readFileSync(pageFile, 'utf8'));
    page.ballots.reverse();
    fs.writeFileSync(pageFile, `${JSON.stringify(page)}\n`, { mode: 0o600 });
    await assert.rejects(
      exportPagedBulletinToDirectory(fakeContract(data), data.electionID, directory),
      /identifier-page hash mismatch/,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('same-election benchmark rejects unsafe scale and output before network access', () => {
  const script = path.join(__dirname, '../benchmark/same-election-paged-bench.js');
  const run = spawnSync(process.execPath, [script, '--ballots', '10001', '--rate', '5',
    '--out', path.join(os.tmpdir(), 'should-not-exist.json'), '--spool', path.join(os.tmpdir(), 'should-not-exist-spool')], {
    encoding: 'utf8', env: { ...process.env, ADMIN_API_TOKEN: 'a'.repeat(48),
      ED25519_PRIVATE_KEY_DER_B64: 'not-used', ED25519_PUBLIC_KEY_DER_B64: 'not-used' },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /ballots must be 100\.\.10000/);
  assert.doesNotMatch(run.stderr, /ECONNREFUSED|fetch failed/);
});

test('Linux same-election wrapper has bounded scale, disk abort and isolated loopback backend', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../deploy/linux/same-election-paged-evaluation.sh'), 'utf8');
  assert.match(source, /ballots must be 100\.\.10000/);
  assert.match(source, /required_bytes=\$\(\(estimated_growth_bytes \* 2 \+ 20000000000\)\)/);
  assert.match(source, /LISTEN_HOST=127\.0\.0\.1/);
  assert.match(source, /DISABLE_RATE_LIMITS=true/);
  assert.match(source, /timeout --signal=TERM --kill-after=30/);
  assert.match(source, /minimum_free_bytes=20000000000/);
  assert.doesNotMatch(source, /docker compose down|docker volume rm|network\.sh (?:down|clean)/);
});
