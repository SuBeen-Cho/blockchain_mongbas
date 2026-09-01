'use strict';

const crypto = require('crypto');
const { logAdminAuthorization } = require('../lib/audit-log');

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const ALLOW_INSECURE_ADMIN_API = process.env.ALLOW_INSECURE_ADMIN_API === 'true';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

function constantTimeTokenEqual(received, expected) {
  const left = crypto.createHash('sha256').update(String(received || '')).digest();
  const right = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(left, right) && received.length === expected.length;
}

function bearerToken(req) {
  const value = req.get('authorization') || '';
  const match = /^Bearer ([^\s]+)$/.exec(value);
  return match ? match[1] : '';
}

function requireAdmin(req, res, next) {
  if (!ADMIN_API_TOKEN) {
    if (!IS_PRODUCTION && ALLOW_INSECURE_ADMIN_API) return next();
    logAdminAuthorization({ success: false, method: req.method, route: req.path, reason: 'admin-not-configured', sourceAddress: req.ip });
    return res.status(503).json({ error: '관리자 API가 안전하게 설정되지 않았습니다.' });
  }
  if (!constantTimeTokenEqual(bearerToken(req), ADMIN_API_TOKEN)) {
    logAdminAuthorization({ success: false, method: req.method, route: req.path, reason: 'invalid-bearer', sourceAddress: req.ip });
    return res.status(401).json({ error: '관리자 인증이 필요합니다.' });
  }
  logAdminAuthorization({ success: true, method: req.method, route: req.path, reason: 'authorized', sourceAddress: req.ip });
  next();
}

// Paths are relative to /api/elections. POST is fail-closed: only the exact
// offline/public verification and voter-proof endpoints are unauthenticated.
// Any new POST route is therefore protected until explicitly reviewed.
const PUBLIC_POST_PATH = /^\/[^/]+\/(?:verify-elgamal|proof|verify-public)$/;
const ADMIN_GET_PATH = /^\/[^/]+\/shares\/[^/]+$/;

function guardElectionAdminRoutes(req, res, next) {
  if ((req.method === 'POST' && !PUBLIC_POST_PATH.test(req.path)) ||
      (req.method === 'GET' && ADMIN_GET_PATH.test(req.path))) {
    return requireAdmin(req, res, next);
  }
  next();
}

function validateAdminConfiguration() {
  if (IS_PRODUCTION && ADMIN_API_TOKEN.length < 32) {
    throw new Error('운영 환경의 ADMIN_API_TOKEN은 최소 32바이트여야 합니다.');
  }
}

module.exports = {
  requireAdmin,
  guardElectionAdminRoutes,
  validateAdminConfiguration,
  constantTimeTokenEqual,
  PUBLIC_POST_PATH,
  ADMIN_GET_PATH,
};
