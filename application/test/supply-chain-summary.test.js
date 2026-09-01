'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildSummary } = require('../benchmark/validate-supply-chain');

const sbom = () => ({
  bomFormat: 'CycloneDX', specVersion: '1.5', metadata: { component: { name: 'app' } },
  components: [{ 'bom-ref': 'pkg:npm/example@1.0.0' }],
});
const audit = (high = 0, critical = 0) => ({ metadata: { vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical, total: high + critical } } });

test('supply-chain summary accepts unique CycloneDX inventory and zero high findings', () => {
  const result = buildSummary({ app: sbom() }, { app: audit() });
  assert.equal(result.components.app, 1);
  assert.equal(result.highOrCritical, 0);
});

test('supply-chain summary rejects duplicate bom-ref and high findings', () => {
  const duplicate = sbom();
  duplicate.components.push(duplicate.components[0]);
  assert.throws(() => buildSummary({ app: duplicate }, { app: audit() }), /duplicate bom-ref/);
  assert.throws(() => buildSummary({ app: sbom() }, { app: audit(1) }), /high\/critical/);
});
