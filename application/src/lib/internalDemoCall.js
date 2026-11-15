'use strict';

// Booth seed-votes replays the public credential/vote API over loopback. Those
// calls must not consume the per-IP budget that real phones behind the same
// NAT or tunnel share. The key is regenerated per process and never leaves
// memory, so an external client cannot forge the exemption.
const crypto = require('node:crypto');

const HEADER = 'x-mongbas-internal-demo';
const KEY = crypto.randomBytes(32).toString('hex');
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function internalDemoHeaders() {
  return { [HEADER]: KEY };
}

function isInternalDemoCall(req) {
  const presented = req.get(HEADER);
  if (typeof presented !== 'string' || presented.length !== KEY.length) return false;
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return false;
  return crypto.timingSafeEqual(Buffer.from(presented), Buffer.from(KEY));
}

module.exports = { internalDemoHeaders, isInternalDemoCall, INTERNAL_DEMO_HEADER: HEADER };
