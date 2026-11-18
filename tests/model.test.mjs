import test from 'node:test';
import assert from 'node:assert/strict';
import { documentState, edit, history, rotatePoint, selectPages } from '../src/model.js';

const ids = state => state.pages.map(page => page.id);

test('merge, reorder and delete maintain stable page IDs and never remove the last page', () => {
  const original = documentState('base', 2);
  let state = edit(original, { type: 'merge', source: 'append', count: 2 });
  assert.equal(edit(state, { type: 'merge', source: 'append', count: 2 }), state);
  state = edit(state, { type: 'move', id: 'append:0', delta: -1 });
  assert.deepEqual(ids(state), ['base:0', 'append:0', 'base:1', 'append:1']);
  assert.equal(edit(state, { type: 'move', id: 'base:0', delta: -1 }), state);
  for (const id of ['base:0', 'append:0', 'append:1']) state = edit(state, { type: 'delete', id });
  assert.deepEqual(ids(state), ['base:1']);
  assert.equal(edit(state, { type: 'delete', id: 'base:1' }), state);
  assert.deepEqual(ids(original), ['base:0', 'base:1']);
});

test('marks stay attached to their page across rotation, reorder and deletion', () => {
  const original = documentState('base', 2);
  const mark = { kind: 'text', x: 51, y: 90, text: 'Hello' };
  let state = edit(original, { type: 'mark', id: 'base:0', mark });
  state = edit(state, { type: 'move', id: 'base:0', delta: 1 });
  for (let i = 0; i < 5; i++) state = edit(state, { type: 'rotate', id: 'base:0' });
  state = edit(state, { type: 'delete', id: 'base:1' });
  assert.deepEqual(state.pages[0], { id: 'base:0', source: 'base', index: 0, rotation: 90, marks: [mark] });
  assert.deepEqual(original.pages[0].marks, []);
});

test('undo/redo checkpoints, branching and source reachability', () => {
  const h = history(documentState('base', 1));
  assert.equal(h.dirty, false);
  assert.equal(h.apply({ type: 'delete', id: 'base:0' }), false);
  h.apply({ type: 'merge', source: 'extra', count: 1 });
  h.checkpoint();
  assert.equal(h.dirty, false);
  h.undo();
  assert.equal(h.dirty, true);
  assert.equal(h.referencesSource('extra'), true);
  h.redo();
  assert.equal(h.dirty, false);
  h.undo();
  h.apply({ type: 'rotate', id: 'base:0' });
  assert.equal(h.referencesSource('extra'), false);
  assert.equal(h.canRedo, false);
});

test('plain fields are updated atomically and unsafe keys are ordinary field names', () => {
  const original = documentState('base', 1), h = history(original);
  const update = { type: 'fields', source: 'base', changes: [
    { name: '__proto__', original: '', value: 'New' }, { name: 'check', original: false, value: true },
  ] };
  assert.equal(h.apply(update), true);
  assert.equal(h.apply(update), false);
  assert.equal(h.current.fields.base.__proto__, 'New');
  assert.equal(Object.getPrototypeOf(h.current.fields.base), Object.prototype);
  h.undo();
  assert.equal(h.current, original);
  h.redo();
  assert.equal(h.current.fields.base.check, true);
  h.apply({ ...update, changes: [{ name: 'check', original: false, value: false }] });
  assert.equal(Object.hasOwn(h.current.fields.base, 'check'), false);
});

test('extract uses displayed order, deduplicates and rejects invalid ranges', () => {
  const { pages } = documentState('base', 6);
  assert.deepEqual(selectPages(pages, ' 5, 1 - 3, 2 '), [pages[0], pages[1], pages[2], pages[4]]);
  for (const invalid of ['', '0', '2-1', '1,', '1.5', '-1', '7', '1-999999999999999999999']) {
    assert.throws(() => selectPages(pages, invalid), /page numbers/);
  }
});

test('image placement offsets rotate through each quadrant', () => {
  assert.deepEqual(rotatePoint(3, -8, 0), [3, -8]);
  assert.deepEqual(rotatePoint(3, -8, 90), [8, 3]);
  assert.deepEqual(rotatePoint(3, -8, 180), [-3, 8]);
  assert.deepEqual(rotatePoint(3, -8, -90), [-8, -3]);
});
