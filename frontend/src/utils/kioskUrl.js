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

export function buildSecureKioskUrl(electionID, currentOrigin, configuredOrigin = '') {
  if (typeof electionID !== 'string' || electionID.length === 0) throw new Error('선거 ID가 필요합니다.');
  const selected = exactOrigin(configuredOrigin.trim() || currentOrigin);
  if (selected.protocol !== 'https:' && !isLoopback(selected.hostname)) {
    throw new Error('휴대폰 암호 투표 QR은 HTTPS URL이 필요합니다.');
  }
  return `${selected.origin}/?app=kiosk&e=${encodeURIComponent(electionID)}`;
}

export function browserCryptoReady(scope = globalThis) {
  return scope.isSecureContext === true && typeof scope.crypto?.getRandomValues === 'function' &&
    typeof scope.crypto?.subtle?.digest === 'function';
}
