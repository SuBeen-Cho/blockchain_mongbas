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

test('isolated full E2E does not inherit the operator QR-admission requirement', () => {
  assert.match(source, /REQUIRE_DEMO_ADMISSION="false"/);
  assert.match(source, /admissionRequired[\s\S]*=== false/);
});

test('isolated audit-or-cast E2E does not inherit the operator QR-admission requirement', () => {
  assert.match(auditOrCastSource, /REQUIRE_DEMO_ADMISSION="false"/);
  assert.match(auditOrCastSource, /admissionRequired[\s\S]*=== false/);
});
