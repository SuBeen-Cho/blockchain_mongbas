const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const source = fs.readFileSync(
  path.join(__dirname, '../../deploy/linux/full-e2e-evaluation.sh'),
  'utf8',
);
const auditOrCastSource = fs.readFileSync(
  path.join(__dirname, '../../deploy/linux/vector-audit-or-cast-evaluation.sh'),
  'utf8',
);
const revotePublishSource = fs.readFileSync(
  path.join(__dirname, '../../deploy/linux/vector-revote-publish-evaluation.sh'),
  'utf8',
);

test('isolated full E2E does not inherit the operator QR-admission requirement', () => {
  assert.match(source, /REQUIRE_DEMO_ADMISSION="false"/);
  assert.match(source, /admissionRequired[\s\S]*=== false/);
});

test('isolated audit-or-cast E2E does not inherit the operator QR-admission requirement', () => {
  assert.match(auditOrCastSource, /REQUIRE_DEMO_ADMISSION="false"/);
  assert.match(auditOrCastSource, /admissionRequired[\s\S]*=== false/);
});

test('revote-publish regression is isolated and preserves commit accounting evidence', () => {
  assert.match(revotePublishSource, /REQUIRE_DEMO_ADMISSION=false/);
  assert.match(revotePublishSource, /sha256-inventory\.txt/);
  const scenario = fs.readFileSync(
    path.join(__dirname, '../scripts/vector-revote-publish-e2e.js'),
    'utf8',
  );
  assert.match(scenario, /attemptedCasts: 3/);
  assert.match(scenario, /snapshot\.activeBallots !== 1 \|\| snapshot\.castEventCount !== 3/);
  assert.match(scenario, /publishSucceeded: true/);
});
