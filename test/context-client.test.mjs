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
