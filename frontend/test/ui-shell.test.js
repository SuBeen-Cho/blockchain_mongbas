import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test('production shell uses the bundled Mongbas favicon', () => {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/logo\/mongbas-symbol-blue\.svg" \/>/);
  assert.equal(fs.existsSync(path.join(__dirname, '../public/logo/mongbas-symbol-blue.svg')), true);
});
