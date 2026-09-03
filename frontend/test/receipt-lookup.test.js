import assert from 'node:assert/strict';
import test from 'node:test';
import { displayReceiptCode, findUniqueReceiptMatch, normalizeReceiptPrefix } from '../src/utils/receiptLookup.js';

test('new receipt display uses a 48-bit prefix while accepting grouped input', () => {
  const hash = 'abcdef123456' + '00'.repeat(26);
  assert.equal(displayReceiptCode(hash), 'ABCD-EF12-3456');
  assert.equal(normalizeReceiptPrefix('ABCD-EF12-3456'), 'abcdef123456');
});

test('receipt lookup rejects short input and ambiguous legacy prefixes', () => {
  const ballots = [
    { nullifierHash: 'abcdef111111' + '00'.repeat(26) },
    { nullifierHash: 'abcdef222222' + '11'.repeat(26) },
  ];
  assert.throws(() => findUniqueReceiptMatch(ballots, 'abcd'), /6자리/);
  assert.throws(() => findUniqueReceiptMatch(ballots, 'ABCD-EF'), /여러 표/);
  assert.equal(findUniqueReceiptMatch(ballots, 'ABCD-EF11-1111').index, 0);
  assert.equal(findUniqueReceiptMatch(ballots, 'ffffff').index, -1);
});
