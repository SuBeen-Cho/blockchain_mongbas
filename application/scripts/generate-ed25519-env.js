#!/usr/bin/env node

const { generateKeyPairSync } = require('crypto');

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: {
    type: 'spki',
    format: 'der',
  },
  privateKeyEncoding: {
    type: 'pkcs8',
    format: 'der',
  },
});

const publicKeyB64 = Buffer.from(publicKey).toString('base64');
const privateKeyB64 = Buffer.from(privateKey).toString('base64');

console.log('# Application server environment');
console.log('ASYM_CRED_ENABLED=true');
console.log('IDEMIX_ENABLED=true');
console.log(`ED25519_PRIVATE_KEY_DER_B64=${privateKeyB64}`);
console.log(`ED25519_PUBLIC_KEY_DER_B64=${publicKeyB64}`);
console.log('');
console.log('# Chaincode deployment environment');
console.log(`export ED25519_PUBLIC_KEY_DER_B64='${publicKeyB64}'`);
console.log('');
console.log('# Keep ED25519_PRIVATE_KEY_DER_B64 only on the credential issuer application server.');
