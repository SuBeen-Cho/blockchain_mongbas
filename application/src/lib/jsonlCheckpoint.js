'use strict';

const fs = require('node:fs');
const path = require('node:path');

class JsonlCheckpoint {
  constructor(outputPath, syncEvery = 25) {
    if (typeof outputPath !== 'string' || !path.isAbsolute(outputPath)) {
      throw new Error('checkpoint path must be absolute');
    }
    if (!Number.isInteger(syncEvery) || syncEvery < 1 || syncEvery > 1000) {
      throw new Error('checkpoint sync interval must be an integer from 1 to 1000');
    }
    this.outputPath = outputPath;
    this.syncEvery = syncEvery;
    this.count = 0;
    this.descriptor = fs.openSync(outputPath, 'wx', 0o600);
    const directory = fs.openSync(path.dirname(outputPath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }

  append(record) {
    if (this.descriptor === null) throw new Error('checkpoint is closed');
    const line = `${JSON.stringify(record)}\n`;
    fs.writeSync(this.descriptor, line, null, 'utf8');
    this.count += 1;
    if (this.count % this.syncEvery === 0) fs.fsyncSync(this.descriptor);
  }

  close() {
    if (this.descriptor === null) return;
    try { fs.fsyncSync(this.descriptor); } finally {
      fs.closeSync(this.descriptor);
      this.descriptor = null;
    }
  }
}

module.exports = { JsonlCheckpoint };
