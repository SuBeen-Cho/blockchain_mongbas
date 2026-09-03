import assert from 'node:assert/strict';
import test from 'node:test';
import { browserCryptoReady, buildSecureKioskUrl } from '../src/utils/kioskUrl.js';

test('QR URL encodes only election ID on an exact HTTPS origin', () => {
  assert.equal(
    buildSecureKioskUrl('election/a?b', 'https://vote.example'),
    'https://vote.example/?app=kiosk&e=election%2Fa%3Fb',
  );
  assert.equal(buildSecureKioskUrl('demo', 'https://admin.example', 'https://vote.example'),
    'https://vote.example/?app=kiosk&e=demo');
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
