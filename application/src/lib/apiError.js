'use strict';

const RULES = [
  { code: 'FABRIC_MVCC_CONFLICT', status: 409, retryable: true, re: /MVCC_READ_CONFLICT|read conflict/i,
    message: '동시 처리 충돌이 발생했습니다. 잠시 후 다시 시도해 주세요.' },
  { code: 'ALREADY_COMMITTED', status: 409, retryable: false, re: /already committed|already processed|이미 (?:처리|게시|종료|존재)/i,
    message: '이미 처리된 요청입니다. 최신 상태를 다시 불러와 주세요.' },
  { code: 'MERKLE_NOT_BUILT', status: 409, retryable: false, re: /MERKLE_ROOT_.*(?:없|not)|Merkle (?:root|tree).*(?:없|not|build)|Merkle.*구축/i,
    message: 'Merkle 봉인이 아직 구축되지 않았습니다.' },
  { code: 'BULLETIN_NOT_PUBLISHED', status: 409, retryable: false, re: /감사 데이터가 아직 게시|BulletinBoard.*(?:없|not)|bulletin.*(?:not published|missing)/i,
    message: '감사 게시판이 아직 공개되지 않았습니다.' },
  { code: 'AUDIT_EVIDENCE_MISMATCH', status: 422, retryable: false, re: /receipt.*(?:mismatch|missing|invalid)|proof.*(?:mismatch|invalid)|영수증.*(?:불일치|누락)|증명.*불일치|artifact.*(?:mismatch|불일치)/i,
    message: '원장 감사 증거가 서로 일치하지 않습니다.' },
  { code: 'INVALID_INPUT', status: 400, retryable: false, re: /invalid|형식|파싱|필요합니다|허용되지 않|잘못/i,
    message: '입력 형식이 올바르지 않습니다.' },
  { code: 'FORBIDDEN', status: 403, retryable: false, re: /권한|permission|forbidden|MSP/i,
    message: '권한이 없습니다.' },
  { code: 'NOT_FOUND', status: 404, retryable: false, re: /존재하지 않|찾을 수 없|not found/i,
    message: '해당 리소스를 찾을 수 없습니다.' },
  { code: 'INFRASTRUCTURE_UNAVAILABLE', status: 503, retryable: true, re: /UNAVAILABLE|ECONNREFUSED|connection.*(?:closed|failed)|deadline exceeded|endorse.*failed|gateway/i,
    message: '원장 연결이 일시적으로 불안정합니다. 잠시 후 다시 시도해 주세요.' },
];

function classifyApiError(error, fallbackStatus = 500) {
  const source = [error?.message, error?.details, error?.cause?.message].filter(Boolean).join(' ');
  const matched = RULES.find((rule) => rule.re.test(source));
  if (matched) return { error: matched.message, code: matched.code, retryable: matched.retryable, status: matched.status };
  return { error: '요청을 처리할 수 없습니다.', code: 'INTERNAL_ERROR', retryable: false, status: fallbackStatus };
}

function sendApiError(response, error, fallbackStatus = 500) {
  const classified = classifyApiError(error, fallbackStatus);
  return response.status(classified.status).json({
    error: classified.error,
    code: classified.code,
    retryable: classified.retryable,
  });
}

module.exports = { classifyApiError, sendApiError };
