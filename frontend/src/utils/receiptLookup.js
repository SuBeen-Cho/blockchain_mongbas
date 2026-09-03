const HEX_RE = /^[0-9a-f]+$/;

export function normalizeReceiptPrefix(rawCode) {
  const prefix = String(rawCode || '').replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (prefix.length < 6 || prefix.length > 64 || !HEX_RE.test(prefix)) {
    throw new Error('추적번호는 6자리 이상의 16진수여야 합니다.');
  }
  return prefix;
}

export function findUniqueReceiptMatch(ballots, rawCode) {
  if (!Array.isArray(ballots)) throw new Error('게시판 표 목록이 잘못됐습니다.');
  const prefix = normalizeReceiptPrefix(rawCode);
  const matches = [];
  for (let index = 0; index < ballots.length; index += 1) {
    const nullifierHash = String(ballots[index]?.nullifierHash || '').toLowerCase();
    if (nullifierHash.startsWith(prefix)) matches.push(index);
  }
  if (matches.length === 0) return { prefix, index: -1, ballot: null };
  if (matches.length > 1) throw new Error('추적번호가 여러 표와 일치합니다. 더 긴 추적번호를 입력하세요.');
  return { prefix, index: matches[0], ballot: ballots[matches[0]] };
}

export function displayReceiptCode(nullifierHash) {
  const normalized = String(nullifierHash || '').toUpperCase();
  if (!/^[0-9A-F]{12,64}$/.test(normalized)) throw new Error('영수증 해시가 잘못됐습니다.');
  return normalized.slice(0, 12).match(/.{4}/g).join('-');
}
