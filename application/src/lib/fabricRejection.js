'use strict';

function errorText(error) {
  const parts = [];
  if (typeof error?.message === 'string') parts.push(error.message);
  if (typeof error?.details === 'string') parts.push(error.details);
  if (Array.isArray(error?.details)) {
    for (const detail of error.details) {
      if (typeof detail === 'string') parts.push(detail);
      else if (typeof detail?.message === 'string') parts.push(detail.message);
    }
  }
  return parts.join('\n');
}

// Fabric Gateway represents deterministic chaincode rejections as endorsement
// errors. Only stable, explicit validation phrases are mapped to a client 4xx;
// transport, availability and unknown failures remain server errors.
function classifyFabricVoteRejection(error) {
  const text = errorText(error);
  if (/(자격증명 거부|nullifier 바인딩 거부|nullifierHash가 서명된 자격증명과 일치하지 않습니다|credential 선거ID 불일치|credential.*폐기)/i.test(text)) {
    return { status: 403, body: { error: '투표 자격증명과 요청이 일치하지 않습니다.' } };
  }
  if (/(잘못된.*(?:암호문|증명)|(?:암호문|증명).*(?:불일치|실패|오류)|candidate.*(?:invalid|mismatch))/i.test(text)) {
    return { status: 422, body: { error: '투표 암호 자료 또는 증명이 거부되었습니다.' } };
  }
  return null;
}

module.exports = { classifyFabricVoteRejection, errorText };
