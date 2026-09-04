'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('tailnet QR deployment wrapper preserves state and refuses unsafe overlap', () => {
  const script = fs.readFileSync(path.join(__dirname, '../../deploy/linux/tailnet-qr-deployment-evaluation.sh'), 'utf8');
  assert.match(script, /APPLY_TAILNET_QR_PROFILE_WITHOUT_RESET/);
  assert.match(script, /https:\/\/\*\.ts\.net/);
  assert.match(script, /pgrep -af '\[v\]erifier-evaluation\\\.sh'/);
  for (const command of ['docker', 'pgrep', 'ss']) {
    assert.match(script, new RegExp(`require_cmd ${command}`));
  }
  assert.match(script, /status --porcelain/);
  assert.match(script, /service-before\.txt/);
  assert.match(script, /listeners-before\.txt/);
  assert.match(script, /environment-before\.sha256/);
  assert.match(script, /application-before-tailnet-qr-/);
  assert.match(script, /docker-before\.tsv/);
  assert.match(script, /volumes-before\.txt/);
  assert.match(script, /install-systemd\.sh.*--install/s);
  assert.match(script, /systemctl restart mongbas-backend\.service/);
  assert.match(script, /qr-preflight\.sh/);
  assert.match(script, /volume-invariance\.txt/);
  assert.match(script, /sha256\.txt/);
  assert.doesNotMatch(script, /tailscale funnel|docker compose down|docker volume rm|peer channel create/);
});
