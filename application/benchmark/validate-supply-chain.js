#!/usr/bin/env node
'use strict';

const fs = require('fs');
const { writeJsonEvidenceExclusive } = require('./evidence-contract');

function validateCycloneDx(document, label) {
  if (document?.bomFormat !== 'CycloneDX' || document?.specVersion !== '1.5') throw new Error(`${label}: expected CycloneDX 1.5`);
  if (!document.metadata?.component || !Array.isArray(document.components)) throw new Error(`${label}: missing metadata/component inventory`);
  const refs = new Set();
  for (const [index, component] of document.components.entries()) {
    if (typeof component['bom-ref'] !== 'string' || !component['bom-ref']) throw new Error(`${label}: component ${index} missing bom-ref`);
    if (refs.has(component['bom-ref'])) throw new Error(`${label}: duplicate bom-ref ${component['bom-ref']}`);
    refs.add(component['bom-ref']);
  }
  return document.components.length;
}

function auditCounts(document, label) {
  const counts = document?.metadata?.vulnerabilities;
  if (!counts || !Number.isSafeInteger(counts.high) || !Number.isSafeInteger(counts.critical)) throw new Error(`${label}: invalid npm audit metadata`);
  return counts;
}

function buildSummary(sboms, audits) {
  const components = Object.fromEntries(Object.entries(sboms).map(([label, value]) => [label, validateCycloneDx(value, label)]));
  const vulnerabilityCounts = Object.fromEntries(Object.entries(audits).map(([label, value]) => [label, auditCounts(value, label)]));
  const highOrCritical = Object.values(vulnerabilityCounts).reduce((sum, counts) => sum + counts.high + counts.critical, 0);
  if (highOrCritical > 0) throw new Error(`deployed dependency audit contains ${highOrCritical} high/critical finding(s)`);
  return { schemaVersion: 1, createdAt: new Date().toISOString(), components, vulnerabilityCounts, highOrCritical };
}

if (require.main === module) {
  const [manifestPath, outputPath] = process.argv.slice(2);
  if (!manifestPath || !outputPath) {
    console.error('usage: validate-supply-chain.js MANIFEST.json OUTPUT.json');
    process.exit(2);
  }
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const readMap = entries => Object.fromEntries(Object.entries(entries || {}).map(([label, file]) => [label, JSON.parse(fs.readFileSync(file, 'utf8'))]));
    const result = buildSummary(readMap(manifest.sboms), readMap(manifest.audits));
    writeJsonEvidenceExclusive(outputPath, result);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { validateCycloneDx, auditCounts, buildSummary };
