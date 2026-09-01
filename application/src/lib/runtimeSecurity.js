'use strict';

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
  ].filter(key => env[key] === 'true');
  if (production && unsafeProductionFlags.length) {
    throw new Error(`production forbids unsafe flags: ${unsafeProductionFlags.join(', ')}`);
  }
  if (production && !env.CORS_ORIGIN) throw new Error('production requires explicit CORS_ORIGIN');
  if (production && env.ASYM_CRED_ENABLED !== 'true' && !['ps', 'bbs'].includes(env.IDEMIX_IMPL || '')) {
    throw new Error('production requires an asymmetric credential mode');
  }

  const trustProxyHops = parseTrustProxyHops(env.TRUST_PROXY_HOPS || '0');
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
    trustProxyHops,
    allowedOrigins,
    benchEndpoints: !production && env.ENABLE_BENCH_ENDPOINTS === 'true',
    hsts: production || env.ENABLE_HSTS === 'true',
  };
}

module.exports = { parseTrustProxyHops, validateRuntimeSecurity };
