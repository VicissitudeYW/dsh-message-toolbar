
// Pure version-tree logic tests.

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  attachParentId, ringFor, rootOf, ancestorChainFromLog, collectFamily, buildTurnTree,
} = await import('../lib/toolbar-logic.js');

const family = [
  { sessionId: 'A', createdAt: 1, turns: [{ turn: 1, text: 'q1' }, { turn: 2, text: 'q2' }] },
  { sessionId: 'B', parentSessionId: 'A', targetTurn: 2, operation: 'retry', createdAt: 2, turns: [] },
  { sessionId: 'C', parentSessionId: 'A', targetTurn: 2, operation: 'retry', createdAt: 3, turns: [] },
];

test('ringFor lists the fork session plus every version of that turn', () => {
  const ring = ringFor(family, 'B', 2);
  assert.ok(ring);
  assert.deepEqual(ring.alternatives.map((v) => v.sessionId), ['A', 'B', 'C']);
  assert.equal(ring.index, 1);
});

test('ringFor renumbers over deleted versions', () => {
  const versions = [
    { sessionId: 'A', createdAt: 1, turns: [] },
    { sessionId: 'B', parentSessionId: 'A', targetTurn: 2, createdAt: 2, turns: [] },
    { sessionId: 'C', parentSessionId: 'A', targetTurn: 2, createdAt: 3, turns: [], deleted: true },
  ];
  const ring = ringFor(versions, 'B', 2);
  assert.deepEqual(ring.alternatives.map((v) => v.sessionId), ['A', 'B']);
});

test('ringFor is null for a lone message', () => {
  assert.equal(ringFor([{ sessionId: 'A', createdAt: 1, turns: [] }], 'A', 1), null);
});

test('rootOf walks to the family root', () => {
  assert.equal(rootOf(family, 'B'), 'A');
  assert.equal(rootOf(family, 'A'), 'A');
});

test('attachParentId fans repeated edits off the original', () => {
  const nodes = new Map([
    ['B', { targetTurn: 2, parentSessionId: 'A' }],
    ['A', { targetTurn: undefined, parentSessionId: undefined }],
  ]);
  assert.equal(attachParentId(nodes, 'B', 2), 'A');
  assert.equal(attachParentId(nodes, 'A', 2), 'A');
});

test('ancestorChainFromLog bridges a deleted parent', () => {
  // Session C's log carries its own marker last and the parent's marker before
  // it; each inverse names that marker owner's parent. The chain starts at the
  // direct parent, not at the session itself.
  const markers = [
    { type: 'message-tree/version', data: { inverse: { sessionId: 'A' } } },
    { type: 'message-tree/version', data: { inverse: { sessionId: 'B' } } },
  ];
  const chain = ancestorChainFromLog('B', markers);
  assert.deepEqual(chain.map((link) => link.sessionId), ['B', 'A']);
  assert.equal(chain[0].marker.data.inverse.sessionId, 'A');
  assert.equal(chain[1].marker, undefined);
});

test('collectFamily keeps tombstones for missing parents', () => {
  const flat = collectFamily('A', [
    { id: 'A', createdAt: 1 },
    { id: 'B', parentId: 'A', createdAt: 2 },
    { id: 'C', parentId: 'Z', createdAt: 3 },
    { id: 'Z', parentId: 'A', createdAt: 2.5 },
  ]);
  const ids = flat.map(({ entry }) => entry.id);
  assert.deepEqual(ids, ['A', 'B', 'Z', 'C']);
  assert.equal(flat.find(({ entry }) => entry.id === 'Z').entry.ghost, undefined);
});

test('collectFamily bridges a hole that is the requested root', () => {
  const flat = collectFamily('ghost-x', [{ id: 'B', parentId: 'ghost-x', createdAt: 2 }]);
  assert.deepEqual(flat.map(({ entry }) => entry.id), ['ghost-x', 'B']);
  assert.equal(flat[0].entry.ghost, true);
  assert.equal(flat[1].depth, 1);
});

test('buildTurnTree nests a version under the previous turn and marks the path', () => {
  const versions = [
    { sessionId: 'A', createdAt: 1, depth: 0, turns: [{ turn: 1, text: 'q1', time: 1 }, { turn: 2, text: 'q2', time: 2 }] },
    { sessionId: 'B', parentSessionId: 'A', targetTurn: 2, operation: 'retry', createdAt: 3, depth: 1, turns: [{ turn: 2, text: 'q2', time: 3 }], model: { provider: 'q', model: 'm2', name: 'Model M2' } },
  ];
  const nodes = buildTurnTree(versions, 'B');
  const b = nodes.find((n) => n.sessionId === 'B' && n.turn === 2);
  assert.equal(b.operation, 'retry');
  assert.equal(b.model.name, 'Model M2');
  assert.equal(b.current, true);
  assert.equal(b.onCurrentPath, true);
  // Turn 2 of the parent was replaced by the version, so only Turn 1 of A
  // remains on the active path.
  const a1 = nodes.find((n) => n.sessionId === 'A' && n.turn === 1);
  const a2 = nodes.find((n) => n.sessionId === 'A' && n.turn === 2);
  assert.equal(a1.onCurrentPath, true);
  assert.equal(a2.onCurrentPath, false);
});
