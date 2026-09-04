'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { publishFileNoReplace } = require('./atomicFile');
const { PAGE_SIZE, validateIndex, validatePage } = require('./pagedBulletin');

const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 256 * 1024;
const SECTIONS = Object.freeze([
  { name: 'ballots', count: 'ballotCount', property: 'ballots' },
  { name: 'receipts', count: 'receiptCount', property: 'receipts' },
  { name: 'disclosures', count: 'disclosureCount', property: 'disclosures' },
]);

function boundedJSONFile(file, maximum, label) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > maximum) {
    throw new Error(`${label} is not a bounded regular file`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function ensureProtectedDirectory(directory) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('paged bulletin spool directory must be a private non-symlink directory (0700)');
  }
  return resolved;
}

function stableSnapshot(file, value, maximum, label) {
  const encoded = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(encoded) > maximum) throw new Error(`${label} exceeds its size limit`);
  try {
    publishFileNoReplace(file, encoded, 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(file, 'utf8');
    if (existing !== encoded) throw new Error(`${label} changed during paged export`);
  }
}

async function evaluateJSON(contract, name, args, maximum, label) {
  const raw = await contract.evaluateTransaction(name, ...args);
  const buffer = Buffer.from(raw);
  if (buffer.length < 2 || buffer.length > maximum) throw new Error(`${label} response exceeds its size limit`);
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    throw new Error(`${label} response is not valid JSON`);
  }
}

async function exportPagedBulletinToDirectory(contract, electionID, directory) {
  if (!contract || typeof contract.evaluateTransaction !== 'function') throw new Error('Fabric contract is required');
  const output = ensureProtectedDirectory(directory);
  const manifest = await evaluateJSON(contract, 'GetBulletinBoardManifest', [electionID], MAX_HEADER_BYTES, 'bulletin manifest');
  const index = await evaluateJSON(contract, 'GetBulletinBoardIndex', [electionID], MAX_HEADER_BYTES, 'bulletin index');
  validateIndex(index, manifest, electionID);
  stableSnapshot(path.join(output, 'manifest.json'), manifest, MAX_HEADER_BYTES, 'bulletin manifest snapshot');
  stableSnapshot(path.join(output, 'index.json'), index, MAX_HEADER_BYTES, 'bulletin index snapshot');

  const collected = { ballots: [], receipts: [], disclosures: [] };
  let reusedPages = 0;
  let fetchedPages = 0;
  for (const section of SECTIONS) {
    const total = index[section.count];
    const sectionDirectory = path.join(output, section.name);
    fs.mkdirSync(sectionDirectory, { recursive: true, mode: 0o700 });
    const sectionStat = fs.lstatSync(sectionDirectory);
    if (!sectionStat.isDirectory() || sectionStat.isSymbolicLink() || (sectionStat.mode & 0o077) !== 0) {
      throw new Error(`paged bulletin ${section.name} spool must remain private`);
    }
    for (let offset = 0; offset < total; offset += PAGE_SIZE) {
      const pageNumber = offset / PAGE_SIZE;
      const pageFile = path.join(sectionDirectory, `${String(pageNumber).padStart(6, '0')}.json`);
      let page;
      if (fs.existsSync(pageFile)) {
        page = boundedJSONFile(pageFile, MAX_PAGE_BYTES, `${section.name} page ${pageNumber}`);
        reusedPages++;
      } else {
        page = await evaluateJSON(contract, 'GetBulletinBoardPage',
          [electionID, section.name, String(offset), String(PAGE_SIZE)], MAX_PAGE_BYTES,
          `${section.name} page ${pageNumber}`);
        // Validate before persisting; a partial or unauthenticated response is
        // never treated as a resumable checkpoint.
        validatePage(page, index, section.name, offset, PAGE_SIZE);
        stableSnapshot(pageFile, page, MAX_PAGE_BYTES, `${section.name} page ${pageNumber}`);
        fetchedPages++;
      }
      collected[section.property].push(...validatePage(page, index, section.name, offset, PAGE_SIZE));
    }
    if (collected[section.property].length !== total) throw new Error(`${section.name} spool is incomplete`);
  }

  const board = {
    ...manifest,
    encryptedBallots: collected.ballots,
    vectorBallotReceipts: collected.receipts,
    vectorAuditDisclosures: collected.disclosures,
  };
  stableSnapshot(path.join(output, 'bulletin-board.json'), board,
    MAX_PAGE_BYTES * Math.max(1, Math.ceil(index.ballotCount / PAGE_SIZE)), 'assembled bulletin board');
  return { output, manifest, index, board, fetchedPages, reusedPages };
}

module.exports = { MAX_PAGE_BYTES, MAX_HEADER_BYTES, ensureProtectedDirectory, exportPagedBulletinToDirectory };
