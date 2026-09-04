'use strict';

function parseListenHost(value = '127.0.0.1') {
  const host = String(value || '127.0.0.1').trim();
  if (!['0.0.0.0', '127.0.0.1', '::', '::1'].includes(host)) {
    throw new Error('LISTEN_HOST must be 0.0.0.0, 127.0.0.1, ::, or ::1');
  }
  return host;
}

function parseTrustProxyHops(value = '0') {
  if (!/^[0-9]+$/.test(String(value))) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 2');
  const hops = Number(value);
  if (!Number.isSafeInteger(hops) || hops < 0 || hops > 2) throw new Error('TRUST_PROXY_HOPS must be an integer from 0 to 2');
  return hops;
}

function validateRuntimeSecurity(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const unsafeProductionFlags = [
    'ALLOW_INSECURE_ADMIN_API',
    'ALLOW_BYPASS_CREDENTIAL',
    'DISABLE_RATE_LIMITS',
    'ENABLE_BENCH_ENDPOINTS',
    'ENABLE_DEMO_CREDENTIALS',
    'ENABLE_DEMO_ENDPOINTS',
    'REQUIRE_DEMO_ADMISSION',
  ].filter(key => env[key] === 'true');
  if (production && unsafeProductionFlags.length) {
    throw new Error(`production forbids unsafe flags: ${unsafeProductionFlags.join(', ')}`);
  }
  if (env.REQUIRE_DEMO_ADMISSION === 'true' && env.ENABLE_DEMO_ENDPOINTS !== 'true') {
    throw new Error('REQUIRE_DEMO_ADMISSION=true requires ENABLE_DEMO_ENDPOINTS=true');
  }
  if (production && !env.CORS_ORIGIN) throw new Error('production requires explicit CORS_ORIGIN');
  if (production && env.ASYM_CRED_ENABLED !== 'true' && !['ps', 'bbs'].includes(env.IDEMIX_IMPL || '')) {
    throw new Error('production requires an asymmetric credential mode');
  }

  const trustProxyHops = parseTrustProxyHops(env.TRUST_PROXY_HOPS || '0');
  const listenHost = parseListenHost(env.LISTEN_HOST);
  const allowedOrigins = String(env.CORS_ORIGIN || 'http://localhost:5173,http://localhost:3000')
    .split(',').map(value => value.trim()).filter(Boolean);
  if (allowedOrigins.length === 0 || allowedOrigins.includes('*')) throw new Error('CORS_ORIGIN must contain explicit origins and cannot contain *');
  for (const origin of allowedOrigins) {
    let parsed;
    try { parsed = new URL(origin); } catch { throw new Error(`invalid CORS origin: ${origin}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) {
      throw new Error(`CORS origin must be an exact http(s) origin: ${origin}`);
    }
  }
  return {
    production,
    listenHost,
    trustProxyHops,
    allowedOrigins,
    benchEndpoints: !production && env.ENABLE_BENCH_ENDPOINTS === 'true',
    hsts: production || env.ENABLE_HSTS === 'true',
    demoAdmissionRequired: !production && env.REQUIRE_DEMO_ADMISSION === 'true',
  };
}

function apiRequestShapeGuard(allowedOrigins) {
  const allowed = new Set(allowedOrigins);
  return function enforceApiRequestShape(req, res, next) {
    const origin = req.get('origin');
    if (origin && !allowed.has(origin)) return res.status(403).json({ error: '허용되지 않은 요청 출처입니다.' });
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite === 'cross-site' && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return res.status(403).json({ error: '교차 사이트 상태 변경 요청은 허용되지 않습니다.' });
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !req.is('application/json')) {
      return res.status(415).json({ error: '상태 변경 API는 application/json 형식만 허용합니다.' });
    }
    next();
  };
}

module.exports = { parseListenHost, parseTrustProxyHops, validateRuntimeSecurity, apiRequestShapeGuard };
