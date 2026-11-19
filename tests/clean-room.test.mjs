import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runComparator } from '../scripts/clean-room/check.mjs';

const parser = process.env.CLEAN_ROOM_TYPESCRIPT;
const subject = 'tests/clean-room.test.mjs';

test('isolated worker passes normalized-copy, exact-copy, unrelated, short and parse-failure controls', {
  skip: !parser && 'Set CLEAN_ROOM_TYPESCRIPT for the pinned parser',
}, () => {
  const result = runComparator({ authored: [], comparators: [], runtime: [] }, parser);
  assert.equal(result.controls, true);
  assert.deepEqual(result.hits, []);
});

test('worker reports exact copies and keeps missing inputs and runtime inequality visible', {
  skip: !parser && 'Set CLEAN_ROOM_TYPESCRIPT for the pinned parser',
}, () => {
  const result = runComparator({ authored: [subject], comparators: ['tests/nonexistent-clean-room-input.mjs', subject],
    runtime: [[subject, '0'.repeat(40)]] }, parser);
  assert.equal(result.runtimeEqual, false);
  assert.equal(result.authored[0].status, 'scanned');
  assert.equal(result.comparators[0].status, 'unreadable');
  assert.equal(result.comparators[0].tokens, null);
  assert.equal(result.authored[0].sha256, result.comparators[1].sha256);
  assert.deepEqual(result.hits, [{ a: 0, c: 1, kind: 'exact', start: 0, position: 0 }]);
  assert.doesNotMatch(JSON.stringify(result), /nonexistent-clean-room-input|import assert/);
});

test('bad parser identity fails closed', () => {
  assert.throws(() => runComparator({ authored: [], comparators: [], runtime: [] }, import.meta.filename));
});
