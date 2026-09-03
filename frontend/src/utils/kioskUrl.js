function exactOrigin(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== value) {
    throw new Error('투표자 URL은 정확한 HTTP(S) origin이어야 합니다.');
  }
  return parsed;
}

function isLoopback(hostname) {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

const ADMISSION_RE = /^[A-Za-z0-9_-]{43}$/;

export function buildSecureKioskUrl(electionID, currentOrigin, configuredOrigin = '', admissionToken = '') {
  if (typeof electionID !== 'string' || electionID.length === 0) throw new Error('선거 ID가 필요합니다.');
  const selected = exactOrigin(configuredOrigin.trim() || currentOrigin);
  if (selected.protocol !== 'https:' && !isLoopback(selected.hostname)) {
    throw new Error('휴대폰 암호 투표 QR은 HTTPS URL이 필요합니다.');
  }
  if (admissionToken && !ADMISSION_RE.test(admissionToken)) throw new Error('QR admission token 형식이 올바르지 않습니다.');
  return `${selected.origin}/?app=kiosk&e=${encodeURIComponent(electionID)}${admissionToken ? `#a=${admissionToken}` : ''}`;
}

export function consumeKioskAdmission(scope = window) {
  const fragment = scope.location.hash || '';
  const match = /^#a=([A-Za-z0-9_-]{43})$/.exec(fragment);
  if (fragment) scope.history.replaceState(null, '', `${scope.location.pathname}${scope.location.search}`);
  if (!match) return '';
  return match[1];
}

export function displayKioskUrl(value) {
  const parsed = new URL(value);
  return `${parsed.origin}${parsed.pathname}${parsed.search}${parsed.hash ? '#a=<one-time-token-hidden>' : ''}`;
}

export function browserCryptoReady(scope = globalThis) {
  return scope.isSecureContext === true && typeof scope.crypto?.getRandomValues === 'function' &&
    typeof scope.crypto?.subtle?.digest === 'function';
}
