'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

function publishFileNoReplace(target, contents, mode = 0o600) {
  if (typeof target !== 'string' || target.length === 0 ||
      !(typeof contents === 'string' || Buffer.isBuffer(contents)) ||
      !Number.isInteger(mode) || mode < 0 || mode > 0o777) {
    throw new Error('invalid atomic publication arguments');
  }
  const resolved = path.resolve(target);
  const parent = path.dirname(resolved);
  const temporary = path.join(parent, '.' + path.basename(resolved) + '.' +
    process.pid + '.' + crypto.randomUUID() + '.tmp');
  let descriptor;
  try {
    descriptor = fs.openSync(temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0),
      mode);
    fs.writeFileSync(descriptor, contents);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;

    // link(2) is an atomic no-clobber publication on the same filesystem.
    // rename(2) would silently replace an output won by another producer.
    fs.linkSync(temporary, resolved);
    const directory = fs.openSync(parent, fs.constants.O_RDONLY);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

module.exports = { publishFileNoReplace };
