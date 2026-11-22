import test from 'node:test';
import assert from 'node:assert/strict';
import { clientHarness, state, deferred, jsonResponse, findAll, textOf, flush, byClass, element } from './helpers/client-harness.mjs';

function setup(extra = {}) {
  const h = clientHarness(), sent = [];
  h.store.set('source', state(extra));
  h.window.fetch = async (_url, init) => {
    if (!init?.body) return jsonResponse(state());
    const body = JSON.parse(init.body); sent.push(body);
    if (body.action === 'changes') return jsonResponse({ supported: false });
    return jsonResponse({ sessionId: 'target', navigationToken: 'token', token: 'token' });
  };
  return { ...h, sent };
}
const button = (tree, name) => findAll(tree, node => node.type === 'button' && (node.props.title === name || textOf(node) === name))[0];

test('regenerate creates and opens a context branch, then focuses only after its toolbar mounts', async () => {
  const h = setup();
  await button(h.render(h.AssistantToolbar, { sessionId: 'source', turn: 1 }), 'Regenerate this turn').props.onClick();
  assert.equal(h.sent.find(body => body.action === 'context-branch')?.operation, 'retry');
  assert.deepEqual(h.opened, ['target']);
  assert.equal(h.sent.some(body => body.action === 'focus'), false);
  h.store.set('target', state());
  h.render(h.ContextFocus, { sessionId: 'target' }); await flush();
  assert.equal(h.sent.find(body => body.action === 'focus')?.token, 'token');
});

test('question Send submits one atomic retry with edited text and no preliminary save', async () => {
  const h = setup();
  const props = { sessionId: 'source', turn: 1, slot: element(), bubble: element() };
  let tree = h.render(h.UserRow, props);
  findAll(tree, node => node.props['data-mtt'] === 'edit')[0].props.onClick();
  tree = h.render(h.UserRow, props);
  byClass(tree, 'mtt-answer-edit-input')[0].props.onChange({ target: { value: 'revised question' } });
  tree = h.render(h.UserRow, props);
  await button(tree, 'Send').props.onClick();
  const mutations = h.sent.filter(body => body.action !== 'changes');
  assert.equal(mutations.length, 1);
  assert.equal(mutations[0].action, 'context-branch'); assert.equal(mutations[0].operation, 'retry');
  assert.equal(mutations[0].text, 'revised question'); assert.deepEqual(h.opened, ['target']);
});

test('answer arrows select a real session through the context route', async () => {
  const h = setup({ contextChoices: { '1': { active: 'a1', items: [
    { id: 'a1', sessionId: 'source', preview: 'one' }, { id: 'a2', sessionId: 'target', preview: 'two' },
  ] } } });
  const tree = h.render(h.AssistantToolbar, { sessionId: 'source', turn: 1 });
  const next = button(tree, 'Next answer'); assert.ok(next);
  await next.props.onClick();
  assert.equal(h.sent.find(body => body.action === 'context-select')?.id, 'a2');
  assert.deepEqual(h.opened, ['target']);
});

test('failed unarchive rejects navigation and does not open or focus the source', async () => {
  const h = setup();
  h.window.fetch = async () => ({ ok: false, status: 409, json: async () => ({ error: 'cannot activate' }) });
  await assert.rejects(h.switchToVersion({ openVersion(id) { h.opened.push(id); } },
    { sessionId: 'target', archived: true, navigationToken: 'token' }, 'source'), /cannot activate/);
  assert.deepEqual(h.opened, []);
});

test('failed focus can be retried from the destination composer', async () => {
  const h = setup(); let attempts = 0;
  h.store.set('target', state({ pendingFocus: { token: 'token', target: 'target', source: 'source' } }));
  h.window.fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body) h.sent.push(body);
    if (body?.action === 'focus' && ++attempts === 1) {
      return { ok: false, status: 500, json: async () => ({ error: 'temporary workspace failure' }) };
    }
    if (body?.action === 'prepare-focus') return jsonResponse({ sessionId: 'target', navigationToken: 'token-2', token: 'token-2' });
    return jsonResponse({ ok: true });
  };
  h.render(h.ContextFocus, { sessionId: 'target' }); await flush();
  const retry = button(h.render(h.ContextFocus, { sessionId: 'target' }), 'Retry organizing versions');
  assert.ok(retry);
  await retry.props.onClick();
  await flush(); h.render(h.ContextFocus, { sessionId: 'target' }); await flush();
  assert.equal(h.sent.filter(body => body.action === 'focus').length, 2, JSON.stringify(h.sent));
});

test('unmounting the destination composer cancels an unfinished focus request', async () => {
  const h = setup(), pending = deferred();
  h.store.set('target', state({ pendingFocus: { token: 'token', target: 'target' } }));
  h.window.fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body) h.sent.push(body);
    if (body?.action === 'focus') return pending.promise;
    return jsonResponse({ ok: true });
  };
  h.render(h.ContextFocus, { sessionId: 'target' }); await flush();
  assert.equal(h.sent.some(body => body.action === 'focus'), true);
  h.unmount(); await flush();
  assert.equal(h.sent.some(body => body.action === 'cancel-focus' && body.token === 'token'), true);
  pending.resolve(jsonResponse({ ok: true })); await flush();
});

test('opening a legacy session automatically starts migration and keeps a retry after failure', async () => {
  const h = setup({ needsContextMigration: true, contextError: 'old diagnostic' }), pending = deferred();
  h.window.fetch = async (_url, init) => {
    if (!init?.body) return jsonResponse(state({ needsContextMigration: true }));
    const body = JSON.parse(init.body); h.sent.push(body);
    return pending.promise;
  };

  let tree = h.render(h.ContextFocus, { sessionId: 'source' });
  await flush();
  tree = h.render(h.ContextFocus, { sessionId: 'source' });
  const notice = byClass(tree, 'mtt-context-notice')[0];
  assert.equal(notice.props.role, 'status');
  assert.equal(textOf(notice), 'Syncing old conversation…');
  assert.equal(button(tree, 'Retry sync'), undefined);
  assert.equal(byClass(tree, 'mtt-context-error').length, 0);
  assert.equal(h.sent.filter(body => body.action === 'context-normalize').length, 1);

  pending.resolve({ ok: false, status: 409, json: async () => ({ error: 'legacy history needs recovery' }) });
  await flush();
  tree = h.render(h.ContextFocus, { sessionId: 'source' });
  assert.ok(textOf(byClass(tree, 'mtt-context-error')[0])
    .includes('legacy history needs recovery'));
  assert.ok(button(tree, 'Retry sync'));
});

function composerBlocks() {
  const values = new Map(), listeners = new Set();
  return {
    get: id => values.get(id),
    storeFor: id => ({ getSnapshot: () => values.get(id),
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } }),
    set(id, block) { values.set(id, block); listeners.forEach(fn => fn()); },
  };
}

test('the native composer stays blocked through legacy detection and handoff, then releases the source', async () => {
  const h = clientHarness(), initial = deferred(), migration = deferred(), blocks = composerBlocks();
  const props = { sessionId: 'source', composerBlocks: blocks };
  h.window.fetch = async (_url, init) => init?.body ? migration.promise : initial.promise;
  h.render(h.ContextFocus, props);
  assert.ok(blocks.get('source')?.reason, 'opening a conversation must not expose Send before classification');

  initial.resolve(jsonResponse(state({ needsContextMigration: true })));
  await flush(); h.render(h.ContextFocus, props); await flush();
  assert.ok(blocks.get('source')?.reason, 'the original session still has legacy context');

  migration.resolve(jsonResponse({ sessionId: 'target', navigationToken: 'token' }));
  await flush();
  assert.deepEqual(h.opened, ['target']);
  assert.ok(blocks.get('source')?.reason, 'the source cannot submit before it leaves the pane');
  h.unmount();
  assert.equal(blocks.get('source'), undefined);
});

test('the initial composer check releases a normal session and does not clear other plugins’ blocks', async () => {
  const h = clientHarness(), initial = deferred(), blocks = composerBlocks();
  const props = { sessionId: 'source', composerBlocks: blocks };
  h.window.fetch = () => initial.promise;
  h.render(h.ContextFocus, props);
  assert.ok(blocks.get('source')?.reason);

  const theirs = { reason: 'Another plugin is preparing this session' };
  blocks.set('source', theirs);
  initial.resolve(jsonResponse(state()));
  await flush(); h.render(h.ContextFocus, props);
  assert.equal(blocks.get('source'), theirs);
  blocks.set('source', undefined);
  assert.equal(blocks.get('source'), undefined, 'a normal conversation must be able to send');
});

test('retrying a failed legacy navigation lets the host resolve the current migration target', async () => {
  const h = setup({ needsContextMigration: true });
  const originalFetch = h.window.fetch;
  const actions = [];
  let normalizations = 0;
  let opens = 0;
  h.window.fetch = async (_url, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    if (body) actions.push(body.action);
    if (body?.action === 'context-normalize') {
      return jsonResponse(++normalizations === 1
        ? { sessionId: 'target', navigationToken: 'first-token' }
        : { sessionId: 'replacement', navigationToken: 'replacement-token' });
    }
    if (body?.action === 'prepare-focus') return jsonResponse({ sessionId: 'target', token: 'retry-token' });
    return originalFetch(_url, init);
  };
  h.__setNavigation({ openVersion(id) {
    opens++;
    if (opens === 1) throw new Error('temporary navigation failure');
    h.opened.push(id);
  } });

  h.render(h.ContextFocus, { sessionId: 'source' }); await flush();
  let tree = h.render(h.ContextFocus, { sessionId: 'source' });
  const retry = button(tree, 'Retry sync');
  assert.ok(retry);
  await retry.props.onClick();
  await flush();

  assert.equal(actions.filter(action => action === 'context-normalize').length, 2);
  assert.equal(actions.filter(action => action === 'prepare-focus').length, 0);
  assert.deepEqual(h.opened, ['replacement']);
});

test('closing the source composer cancels the late legacy handoff without opening its branch', async () => {
  const h = setup({ needsContextMigration: true }), pending = deferred();
  h.window.fetch = async (_url, init) => {
    if (!init?.body) return jsonResponse(state({ needsContextMigration: true }));
    const body = JSON.parse(init.body); h.sent.push(body);
    if (body.action === 'context-normalize') return pending.promise;
    return jsonResponse({ ok: true });
  };

  h.render(h.ContextFocus, { sessionId: 'source' }); await flush();
  assert.equal(h.sent.filter(body => body.action === 'context-normalize').length, 1);
  h.unmount();
  pending.resolve(jsonResponse({ sessionId: 'target', navigationToken: 'late-token' }));
  await flush();

  assert.deepEqual(h.opened, []);
  assert.ok(h.sent.some(body => body.action === 'cancel-focus' && body.token === 'late-token'));
});

test('an inert legacy composer waits until it becomes visible before migrating', async () => {
  let covered = true, onAttributes;
  const h = setup();
  const parent = {};
  h.window.MutationObserver = class {
    constructor(callback) { onAttributes = callback; }
    observe() {}
    disconnect() {}
  };
  const tree = h.render(h.ContextFocus, { sessionId: 'source' });
  if (tree[0].props.ref) tree[0].props.ref.current = {
    isConnected: true, parentElement: parent, closest: () => covered ? parent : null,
  };
  h.store.set('source', state({ needsContextMigration: true }));
  h.render(h.ContextFocus, { sessionId: 'source' }); await flush();
  assert.equal(h.sent.filter(body => body.action === 'context-normalize').length, 0);
  assert.deepEqual(h.opened, []);

  covered = false;
  onAttributes?.(); await flush();
  assert.equal(h.sent.filter(body => body.action === 'context-normalize').length, 1);
  assert.deepEqual(h.opened, ['target']);
});

test('version cards name prompt, answer and deletion operations separately', () => {
  const h = setup({ versions: [
    { sessionId: 'source', turns: [{ turn: 1, text: 'question' }], current: true },
    { sessionId: 'prompt', parentSessionId: 'source', operation: 'edit-prompt', targetTurn: 1, turns: [{ turn: 1, text: 'question' }] },
    { sessionId: 'answer', parentSessionId: 'source', operation: 'edit-answer', targetTurn: 1, turns: [{ turn: 1, text: 'question' }] },
    { sessionId: 'deleted-answer', parentSessionId: 'source', operation: 'delete-answer', targetTurn: 1, turns: [{ turn: 1, text: 'question' }] },
    { sessionId: 'deleted-question', parentSessionId: 'source', operation: 'delete-question', targetTurn: 1, turns: [] },
  ] });
  const titles = findAll(h.render(h.VersionsView, { sessionId: 'source' }), node => node.props.className === 'mtt-node-title')
    .map(textOf);
  assert.ok(titles.includes('Edited question 1'));
  assert.ok(titles.includes('Edited answer 1'));
  assert.ok(titles.includes('Deleted answer 1'));
  assert.ok(titles.includes('Deleted question 1'));
});

test('deleting a version card uses the host navigation token and waits for target mount', async () => {
  const h = setup({ versions: [
    { sessionId: 'source', parentSessionId: 'target', operation: 'retry', targetTurn: 1, turns: [{ turn: 1, text: 'question' }], current: true },
    { sessionId: 'target', turns: [{ turn: 1, text: 'question' }] },
  ] });
  const draw = () => h.render(h.VersionsView, { sessionId: 'source' });
  const remove = button(byClass(draw(), 'mtt-node-current'), 'Delete this answer card');
  assert.ok(remove);
  await remove.props.onClick();
  await flush();
  assert.deepEqual(h.opened, ['target']);
  assert.equal(h.sent.filter(body => body.action === 'prepare-focus').length, 0);
  assert.equal(h.sent.some(body => body.action === 'focus'), false);
});
