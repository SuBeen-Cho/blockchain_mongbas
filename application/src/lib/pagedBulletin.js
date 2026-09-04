'use strict';

const crypto = require('node:crypto');

const INDEX_SCHEMA = 'mongbas-bulletin-board-index/v1';
const INDEX_PAGE_SCHEMA = 'mongbas-bulletin-board-index-page/v1';
const PAGE_SCHEMA = 'mongbas-bulletin-board-page/v1';
const PAGE_SIZE = 100;
const MAX_COUNTS = Object.freeze({ ballots: 10_000, receipts: 20_000, disclosures: 10_000 });
const HEX_256 = /^[0-9a-f]{64}$/;
const ELECTION_ID = /^[A-Za-z0-9_.-]{1,256}$/;

function hashWithLengthPrefix(...fields) {
  const hash = crypto.createHash('sha256');
  for (const value of fields) {
    if (typeof value !== 'string') throw new Error('paged bulletin hash fields must be strings');
    const bytes = Buffer.from(value, 'utf8');
    hash.update(bytes.length.toString(16).padStart(8, '0'));
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function sectionMetadata(index, section) {
  if (section === 'ballots') return { count: index.ballotCount, hashes: index.ballotPageHashes, property: 'ballots', id: 'nullifierHash' };
  if (section === 'receipts') return { count: index.receiptCount, hashes: index.receiptPageHashes, property: 'receipts', id: 'ballotID' };
  if (section === 'disclosures') return { count: index.disclosureCount, hashes: index.disclosurePageHashes, property: 'disclosures', id: 'ballotID' };
  throw new Error('unsupported paged bulletin section');
}

function computeIndexHash(index) {
  const fields = [
    'mongbas/bulletin-board-index/v1', index.schema, index.electionID, String(index.publishedAt), String(index.pageSize),
    'ballots', String(index.ballotCount), String(index.ballotPageHashes.length), ...index.ballotPageHashes,
    'receipts', String(index.receiptCount), String(index.receiptPageHashes.length), ...index.receiptPageHashes,
    'disclosures', String(index.disclosureCount), String(index.disclosurePageHashes.length), ...index.disclosurePageHashes,
  ];
  return hashWithLengthPrefix(...fields);
}

function computeIdentifierPageHash({ electionID, publishedAt, section, pageNumber, offset, nextOffset, total, identifiers }) {
  return hashWithLengthPrefix(
    'mongbas/bulletin-board-index-page/v1', INDEX_PAGE_SCHEMA, electionID, String(publishedAt), section,
    String(pageNumber), String(offset), String(nextOffset), String(total), String(identifiers.length), ...identifiers,
  );
}

// Chaincode hashes the fixed Go page struct with encoding/json after omitting
// pageHash and empty optional arrays. Rebuilding that exact outer field order
// avoids accepting a page whose content was changed after endorsement.
function computeArtifactPageHash(page) {
  const unsigned = {
    schema: page.schema,
    electionID: page.electionID,
    publishedAt: page.publishedAt,
    indexHash: page.indexHash,
    section: page.section,
    offset: page.offset,
    nextOffset: page.nextOffset,
    total: page.total,
  };
  if (Array.isArray(page.ballots) && page.ballots.length) unsigned.ballots = page.ballots;
  if (Array.isArray(page.receipts) && page.receipts.length) unsigned.receipts = page.receipts;
  if (Array.isArray(page.disclosures) && page.disclosures.length) unsigned.disclosures = page.disclosures;
  return crypto.createHash('sha256').update(JSON.stringify(unsigned)).digest('hex');
}

function parseFabricJSON(raw, label) {
  try {
    return JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

function validateIndex(index, manifest, electionID) {
  if (!index || index.schema !== INDEX_SCHEMA || index.electionID !== electionID || !ELECTION_ID.test(electionID) ||
      !Number.isSafeInteger(index.publishedAt) || index.publishedAt < 0 || index.pageSize !== PAGE_SIZE ||
      !manifest || manifest.docType !== 'bulletinBoard' || manifest.electionID !== electionID ||
      manifest.publishedAt !== index.publishedAt || manifest.totalVotes !== index.ballotCount) {
    throw new Error('paged bulletin index does not match the published manifest');
  }
  for (const section of ['ballots', 'receipts', 'disclosures']) {
    const { count, hashes } = sectionMetadata(index, section);
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_COUNTS[section] || !Array.isArray(hashes) ||
        hashes.length !== Math.ceil(count / PAGE_SIZE) || hashes.some(hash => !HEX_256.test(hash))) {
      throw new Error(`paged bulletin ${section} index is invalid`);
    }
  }
  if (manifest.encryptionMode === 'elgamal-vector-v3') {
    if (index.receiptCount !== index.ballotCount + index.disclosureCount) {
      throw new Error('paged vector receipt count is inconsistent');
    }
  } else if (index.receiptCount !== 0 || index.disclosureCount !== 0) {
    throw new Error('non-vector bulletin contains vector index entries');
  }
  if (!HEX_256.test(index.indexHash) || computeIndexHash(index) !== index.indexHash) {
    throw new Error('paged bulletin index hash mismatch');
  }
}

function validatePage(page, index, section, requestedOffset, requestedLimit) {
  const metadata = sectionMetadata(index, section);
  if (!page || page.schema !== PAGE_SCHEMA || page.electionID !== index.electionID ||
      page.publishedAt !== index.publishedAt || page.indexHash !== index.indexHash || page.section !== section ||
      page.offset !== requestedOffset || page.total !== metadata.count || !Number.isSafeInteger(page.nextOffset) ||
      page.nextOffset < requestedOffset || page.nextOffset > Math.min(metadata.count, requestedOffset + requestedLimit)) {
    throw new Error(`paged bulletin ${section} response binding is invalid`);
  }
  const items = page[metadata.property];
  if (!Array.isArray(items) || items.length !== page.nextOffset - page.offset ||
      items.some(item => !item || !HEX_256.test(item[metadata.id] || ''))) {
    throw new Error(`paged bulletin ${section} items are invalid`);
  }
  if (page.nextOffset === page.offset && page.offset !== page.total) {
    throw new Error(`paged bulletin ${section} made no progress`);
  }
  const identifiers = items.map(item => item[metadata.id]);
  if (new Set(identifiers).size !== identifiers.length) throw new Error(`paged bulletin ${section} contains duplicate IDs`);
  const pageNumber = Math.floor(requestedOffset / PAGE_SIZE);
	const expectedPageOffset = pageNumber * PAGE_SIZE;
	const expectedPageEnd = Math.min((pageNumber + 1) * PAGE_SIZE, metadata.count);
	if (requestedOffset !== expectedPageOffset || page.nextOffset !== expectedPageEnd) {
		throw new Error(`paged bulletin ${section} must authenticate one complete index page`);
	}
  const identifierHash = computeIdentifierPageHash({
    electionID: index.electionID, publishedAt: index.publishedAt, section, pageNumber,
    offset: expectedPageOffset, nextOffset: expectedPageEnd, total: metadata.count, identifiers,
  });
  // The normal collector always requests whole index pages. Reject partial
  // windows here so one top-level page hash authenticates every returned ID.
  if (identifierHash !== metadata.hashes[pageNumber]) {
    throw new Error(`paged bulletin ${section} identifier-page hash mismatch`);
  }
  if (!HEX_256.test(page.pageHash) || computeArtifactPageHash(page) !== page.pageHash) {
    throw new Error(`paged bulletin ${section} artifact-page hash mismatch`);
  }
  return items;
}

async function collectPagedBulletin(contract, electionID, { pageSize = PAGE_SIZE } = {}) {
  if (!contract || typeof contract.evaluateTransaction !== 'function') throw new Error('Fabric contract is required');
  if (!ELECTION_ID.test(electionID || '') || pageSize !== PAGE_SIZE) throw new Error('invalid paged bulletin request');
  const [manifestRaw, indexRaw] = await Promise.all([
    contract.evaluateTransaction('GetBulletinBoardManifest', electionID),
    contract.evaluateTransaction('GetBulletinBoardIndex', electionID),
  ]);
  const manifest = parseFabricJSON(manifestRaw, 'bulletin manifest');
  const index = parseFabricJSON(indexRaw, 'bulletin index');
  validateIndex(index, manifest, electionID);

  const collected = { ballots: [], receipts: [], disclosures: [] };
  for (const section of ['ballots', 'receipts', 'disclosures']) {
    const { count } = sectionMetadata(index, section);
    for (let offset = 0; offset < count; offset += PAGE_SIZE) {
      const raw = await contract.evaluateTransaction('GetBulletinBoardPage', electionID, section, String(offset), String(PAGE_SIZE));
      const page = parseFabricJSON(raw, `${section} page`);
      collected[section].push(...validatePage(page, index, section, offset, PAGE_SIZE));
    }
    if (collected[section].length !== count) throw new Error(`paged bulletin ${section} collection is incomplete`);
  }
  return {
    manifest: {
      ...manifest,
      encryptedBallots: collected.ballots,
      vectorBallotReceipts: collected.receipts,
      vectorAuditDisclosures: collected.disclosures,
    },
    index,
  };
}

module.exports = {
  PAGE_SIZE, MAX_COUNTS, hashWithLengthPrefix, computeIndexHash, computeIdentifierPageHash,
  computeArtifactPageHash, validateIndex, validatePage, collectPagedBulletin,
};
