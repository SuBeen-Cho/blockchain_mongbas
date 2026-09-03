import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCryptoReady, buildSecureKioskUrl, consumeKioskAdmission, displayKioskUrl } from '../src/utils/kioskUrl.js';

test('QR URL encodes only election ID on an exact HTTPS origin', () => {
  assert.equal(
    buildSecureKioskUrl('election/a?b', 'https://vote.example'),
    'https://vote.example/?app=kiosk&e=election%2Fa%3Fb',
  );
  assert.equal(buildSecureKioskUrl('demo', 'https://admin.example', 'https://vote.example'),
    'https://vote.example/?app=kiosk&e=demo');
  assert.equal(buildSecureKioskUrl('demo', 'https://vote.example', '', 'a'.repeat(43)),
    `https://vote.example/?app=kiosk&e=demo#a=${'a'.repeat(43)}`);
});

test('QR admission is read only from an exact fragment and immediately cleared', () => {
  let replacement = '';
  const scope = {
    location: { hash: `#a=${'b'.repeat(43)}`, pathname: '/', search: '?app=kiosk&e=demo' },
    history: { replaceState(_state, _title, value) { replacement = value; } },
  };
  assert.equal(consumeKioskAdmission(scope), 'b'.repeat(43));
  assert.equal(replacement, '/?app=kiosk&e=demo');
  replacement = '';
  assert.equal(consumeKioskAdmission({ ...scope, location: { ...scope.location, hash: '#a=bad&x=1' } }), '');
  assert.equal(replacement, '/?app=kiosk&e=demo');
});

test('QR URL rejects insecure remote HTTP and ambiguous or credentialed origins', () => {
  for (const origin of [
    'http://192.0.2.10:3000',
    'http://vote.example',
    'https://vote.example/path',
    'https://user:password@vote.example',
    'javascript:alert(1)',
  ]) assert.throws(() => buildSecureKioskUrl('demo', origin), /HTTPS|origin/);
  assert.equal(buildSecureKioskUrl('demo', 'http://localhost:3000'), 'http://localhost:3000/?app=kiosk&e=demo');
});

test('browser crypto readiness requires secure context, CSPRNG and subtle digest', () => {
  const crypto = { getRandomValues() {}, subtle: { digest() {} } };
  assert.equal(browserCryptoReady({ isSecureContext: true, crypto }), true);
  assert.equal(browserCryptoReady({ isSecureContext: false, crypto }), false);
  assert.equal(browserCryptoReady({ isSecureContext: true, crypto: { getRandomValues() {} } }), false);
});

test('dashboard display masks the one-time admission fragment', () => {
  const token = 'A'.repeat(43);
  const actual = `https://vote.example.test/?app=kiosk&e=election-1#a=${token}`;
  const displayed = displayKioskUrl(actual);
  assert.equal(displayed, 'https://vote.example.test/?app=kiosk&e=election-1#a=<one-time-token-hidden>');
  assert.doesNotMatch(displayed, new RegExp(token));
});
