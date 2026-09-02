'use strict';

function demoEndpointsEnabled(env = process.env) {
  return env.NODE_ENV !== 'production' && env.ENABLE_DEMO_ENDPOINTS === 'true';
}

function requireDemoEndpoint(req, res, next) {
  if (!demoEndpointsEnabled()) return res.status(404).json({ error: '사용할 수 없는 엔드포인트입니다.' });
  return next();
}

module.exports = { demoEndpointsEnabled, requireDemoEndpoint };
