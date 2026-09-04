const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const scriptPath = path.join(__dirname, '../../deploy/linux/nonreset-chaincode-upgrade-evaluation.sh');

test('non-reset upgrade evidence wrapper requires explicit approval and preserves recovery facts', () => {
  assert.equal(fs.existsSync(scriptPath), true, 'missing non-reset upgrade evidence wrapper');
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.match(script, /MONGBAS_APPROVE_NONRESET_CHAINCODE_UPGRADE/);
  assert.match(script, /APPROVE_NONRESET_CHAINCODE_UPGRADE/);
  assert.match(script, /requires an existing committed definition/);
  assert.match(script, /git-status\.txt/);
  assert.match(script, /chaincode-before\.json/);
  assert.match(script, /chaincode-after\.json/);
  assert.match(script, /channel-before\.txt/);
  assert.match(script, /channel-after\.txt/);
  assert.match(script, /volumes-before\.txt/);
  assert.match(script, /volumes-after\.txt/);
  assert.match(script, /rollback-seq-/);
  assert.match(script, /sha256-inventory\.txt/);
});

test('non-reset upgrade wrapper rejects destructive network operations and validates exact handover', () => {
  const script = fs.readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(script, /network\.sh (?:down|clean|up)/);
  assert.doesNotMatch(script, /docker volume rm|docker compose down/);
  assert.match(script, /after_seq != before_seq \+ 1/);
  assert.match(script, /after\["version"\] != before\["version"\]/);
  assert.match(script, /before_volumes.*!=.*after_volumes/);
  assert.match(script, /rollback_image.*!=.*old_image/);
  assert.match(script, /current_image.*!=.*candidate_image/);
  assert.match(script, /candidate_running.*!=.*true/);
  assert.match(script, /normal-backend-final-health\.json/);
});
