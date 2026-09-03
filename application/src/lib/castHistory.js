'use strict';

const crypto = require('node:crypto');

function createCastHistoryTransient(randomBytes = crypto.randomBytes) {
  const commitmentNonce = randomBytes(32).toString('hex');
  const receiptNonce = randomBytes(32).toString('hex');
  if (commitmentNonce === receiptNonce) throw new Error('cast history nonce collision');
  return {
    castHistoryCommitmentNonce: Buffer.from(commitmentNonce, 'utf8'),
    castHistoryReceiptNonce: Buffer.from(receiptNonce, 'utf8'),
  };
}

module.exports = { createCastHistoryTransient };
