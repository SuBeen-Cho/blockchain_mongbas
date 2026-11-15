'use strict';

// Booth convenience: a second listener bound to 127.0.0.1 only. Requests that
// arrive through it are marked in-process (a Symbol, never a header), so the
// presenter's dashboard on the same Mac needs no token, while the public port
// that the tunnel forwards to keeps requiring the administrator token.

const LOCAL_ADMIN = Symbol('mongbas.localAdminListener');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function parseAdminLocalPort(env = process.env, publicPort = env.PORT || 3000) {
  const raw = env.ADMIN_LOCAL_PORT;
  if (raw === undefined || raw === '') return null;
  if (env.NODE_ENV === 'production') throw new Error('ADMIN_LOCAL_PORT는 운영 환경에서 사용할 수 없습니다.');
  if (!/^[0-9]+$/.test(String(raw))) throw new Error('ADMIN_LOCAL_PORT must be an integer from 1024 to 65535');
  const port = Number(raw);
  if (port < 1024 || port > 65535) throw new Error('ADMIN_LOCAL_PORT must be an integer from 1024 to 65535');
  if (port === Number(publicPort)) throw new Error('ADMIN_LOCAL_PORT must differ from PORT');
  return port;
}

function parsePublicVoterOrigin(env = process.env) {
  const raw = String(env.PUBLIC_VOTER_ORIGIN || '').trim();
  if (!raw) return '';
  let parsed;
  try { parsed = new URL(raw); } catch { throw new Error('PUBLIC_VOTER_ORIGIN must be an exact https origin'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== raw || parsed.username || parsed.password) {
    throw new Error('PUBLIC_VOTER_ORIGIN must be an exact https origin');
  }
  return raw;
}

function localAdminHandler(app) {
  return (req, res) => {
    req[LOCAL_ADMIN] = true;
    return app(req, res);
  };
}

function isLocalAdminRequest(req) {
  return req?.[LOCAL_ADMIN] === true && LOOPBACK.has(req.socket?.remoteAddress);
}

function localAdminOrigins(port) {
  return port ? [`http://localhost:${port}`, `http://127.0.0.1:${port}`] : [];
}

module.exports = { parseAdminLocalPort, parsePublicVoterOrigin, localAdminHandler, isLocalAdminRequest, localAdminOrigins, LOCAL_ADMIN };
