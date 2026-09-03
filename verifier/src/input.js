'use strict';

const fs = require('node:fs');

const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;

function readBoundedRegularFile(filePath, label, maximumBytes, { encoding } = {}) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new Error('maximumBytes must be a non-negative safe integer');
  const before = fs.lstatSync(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} must be a regular non-symlink file`);
  if (before.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error(`${label} changed before it could be opened safely`);
    if (opened.size > maximumBytes) throw new Error(`${label} exceeds ${maximumBytes} bytes`);
    const data = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < data.length) {
      const count = fs.readSync(descriptor, data, offset, data.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const probe = Buffer.alloc(1);
    if (fs.readSync(descriptor, probe, 0, 1, offset) !== 0) throw new Error(`${label} grew while being read or exceeds ${maximumBytes} bytes`);
    const result = data.subarray(0, offset);
    return encoding ? result.toString(encoding) : result;
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { MAX_BUNDLE_BYTES, readBoundedRegularFile };
