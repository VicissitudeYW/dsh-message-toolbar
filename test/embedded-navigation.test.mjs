import test from 'node:test';
import assert from 'node:assert/strict';
import { clientHarness, state, deferred, jsonResponse, flush } from './helpers/client-harness.mjs';

const EVENT = 'dsh-message-toolbar:open-version';
const target = { sessionId: 'target', navigationToken: 'focus-token' };

function setup(options) {
  const h = clientHarness(options);
  h.store.set('source', state());
  h.store.set('target', state());
  h.sent = [];
  h.window.fetch = async (_url, init) => {
    if (!init?.body) return jsonResponse(state());
    const body = JSON.parse(init.body); h.sent.push(body);
    return jsonResponse({ sessionId: 'target', navigationToken: 'focus-token' });
  };
  h.nav = h.installWorkspaceNavigation();
  return h;
}

test('unclaimed version navigation supplies source and target before using the workspace', async () => {
  const h = setup(); let observed;
  h.window.addEventListener(EVENT, (event) => { observed = event.detail; });
  await h.switchToVersion(h.nav, target, 'source');
  assert.equal(observed?.version, 1);
  assert.equal(observed.sourceSessionId, 'source');
  assert.equal(observed.targetSessionId, 'target');
  assert.deepEqual(h.opened, ['target']);
});

test('the first embedded claimant owns navigation and completion waits for its destination', async () => {
  const h = setup(), ready = deferred();
  let first, second, called = 0, settled = false;
  h.window.addEventListener(EVENT, (event) => {
    first = event.detail.claim(async () => { called += 1; await ready.promise; });
    second = event.detail.claim(async () => { throw new Error('second claimant must not run'); });
  });
  const selecting = h.switchToVersion(h.nav, target, 'source').then(() => { settled = true; });
  await flush();
  assert.equal(first, true);
  assert.equal(second, false);
  assert.equal(called, 1);
  assert.equal(settled, false);
  assert.deepEqual(h.opened, []);
  ready.resolve(); await selecting;
  assert.equal(settled, true);
  assert.deepEqual(h.opened, []);
});

test('failed embedded persistence rejects the operation without falling back to the workspace', async () => {
  const h = setup();
  h.window.addEventListener(EVENT, (event) => {
    event.detail.claim(async () => { throw new Error('card version could not be saved'); });
  });
  await assert.rejects(h.switchToVersion(h.nav, target, 'source'), /could not be saved/);
  assert.deepEqual(h.opened, []);
  h.render(h.ContextFocus, { sessionId: 'target' }); await flush();
  assert.equal(h.sent.some((body) => body.action === 'focus'), false);
});

test('an embedded destination still completes the durable focus after its composer mounts', async () => {
  const h = setup();
  h.window.addEventListener(EVENT, (event) => { event.detail.claim(async () => {}); });
  await h.switchToVersion(h.nav, target, 'source');
  assert.equal(h.sent.some((body) => body.action === 'focus'), false);
  h.render(h.ContextFocus, { sessionId: 'target' }); await flush();
  assert.equal(h.sent.find((body) => body.action === 'focus')?.token, 'focus-token');
  assert.deepEqual(h.opened, []);
});

test('a late edit result cannot navigate after its source composer unmounts', async () => {
  const h = setup(), result = deferred();
  h.render(h.ContextFocus, { sessionId: 'source' });
  h.window.fetch = async (_url, init) => init?.body ? result.promise : jsonResponse(state());
  const editing = h.changeContext({ action: 'context-branch', operation: 'edit-answer', sessionId: 'source', turn: 1, text: 'edited' });
  h.unmount();
  result.resolve(jsonResponse({ sessionId: 'target', navigationToken: 'focus-token' }));
  await assert.rejects(editing, /switched|navigation|session|branch/i);
  assert.deepEqual(h.opened, []);
});

test('a late edit result cannot navigate from an inert source composer', async () => {
  const h = setup(), result = deferred();
  const tree = h.render(h.ContextFocus, { sessionId: 'source' });
  // Native overlay pages mark covered ancestors inert while retaining their chat.
  if (tree[0].props.ref) tree[0].props.ref.current = { isConnected: true, closest: () => ({ inert: true }) };
  h.window.fetch = async (_url, init) => init?.body ? result.promise : jsonResponse(state());
  const editing = h.changeContext({ action: 'context-branch', operation: 'edit-answer', sessionId: 'source', turn: 1, text: 'edited' });
  result.resolve(jsonResponse({ sessionId: 'target', navigationToken: 'focus-token' }));
  await assert.rejects(editing, /switched|navigation|session|branch/i);
  assert.deepEqual(h.opened, []);
});

test('a closed and reopened composer with the same session does not accept an old edit result', async () => {
  const h = setup(), result = deferred();
  h.render(h.ContextFocus, { sessionId: 'source' });
  h.window.fetch = async (_url, init) => init?.body ? result.promise : jsonResponse(state());
  const editing = h.changeContext({ action: 'context-branch', operation: 'edit-answer', sessionId: 'source', turn: 1, text: 'edited' });
  h.unmount();
  h.render(h.ContextFocus, { sessionId: 'source' });
  result.resolve(jsonResponse({ sessionId: 'target', navigationToken: 'focus-token' }));
  await assert.rejects(editing, /switched|navigation|session|branch/i);
  assert.deepEqual(h.opened, []);
});

test('removing a foreground composer restores the retained parent as a navigation source', async () => {
  const h = setup();
  h.store.set('child', state());
  h.render(function Deck() {
    return [
      { type: h.ContextFocus, props: { sessionId: 'source' } },
      { type: h.ContextFocus, props: { sessionId: 'child' } },
    ];
  }, {});
  h.unmount(h.ContextFocus, 1);
  h.window.addEventListener(EVENT, (event) => { event.detail.claim(async () => {}); });
  await h.changeContext({ action: 'context-branch', operation: 'edit-answer', sessionId: 'source', turn: 1, text: 'edited' });
  assert.deepEqual(h.opened, []);
});

test('a listener cannot claim a version navigation after dispatch has completed', async () => {
  const h = setup(); let lateClaim;
  h.window.addEventListener(EVENT, (event) => { lateClaim = event.detail.claim; });
  await h.switchToVersion(h.nav, target, 'source');
  assert.equal(lateClaim(async () => { throw new Error('late claimant'); }), false);
  assert.deepEqual(h.opened, ['target']);
});

test('a newer navigation prevents an older edit result from being delivered to an embedded host', async () => {
  const h = setup(), result = deferred();
  let claims = 0;
  h.window.addEventListener(EVENT, (event) => { event.detail.claim(async () => { claims += 1; }); });
  h.window.fetch = async (_url, init) => init?.body ? result.promise : jsonResponse(state());
  const editing = h.changeContext({ action: 'context-branch', operation: 'edit-answer', sessionId: 'source', turn: 1, text: 'edited' });
  await h.switchToVersion(h.nav, target, 'source');
  result.resolve(jsonResponse({ sessionId: 'target', navigationToken: 'old-focus-token' }));
  await assert.rejects(editing, /switched|navigation|session|branch/i);
  assert.equal(claims, 1);
  assert.deepEqual(h.opened, []);
});

test('a covered destination does not organize versions and can retry after returning to the foreground', async () => {
  let covered = true;
  const h = setup({ elementRef: () => ({ isConnected: true, closest: () => covered ? { inert: true } : null }) });
  h.store.set('target', state({ pendingFocus: { token: 'focus-token', target: 'target', source: 'source' } }));
  h.window.fetch = async (_url, init) => {
    if (!init?.body) return jsonResponse(state());
    const body = JSON.parse(init.body); h.sent.push(body);
    return jsonResponse(body.action === 'prepare-focus' ? { token: 'retry-token' } : { ok: true });
  };
  h.render(h.ContextFocus, { sessionId: 'target' }); await flush();
  assert.equal(h.sent.some((body) => body.action === 'focus'), false);
  covered = false;
  const tree = h.render(h.ContextFocus, { sessionId: 'target' });
  const find = (nodes) => nodes.flatMap((node) => [node, ...find(node.children || [])]);
  const retry = find(tree).find((node) => node.type === 'button' && node.children?.some((child) => child.text === 'Retry opening version'));
  assert.ok(retry, 'the saved navigation remains available when the card returns');
  await retry.props.onClick();
  h.render(h.ContextFocus, { sessionId: 'target' }); await flush();
  assert.equal(h.sent.filter((body) => body.action === 'focus').length, 1);
  assert.equal(h.sent.find((body) => body.action === 'focus')?.token, 'retry-token');
});

test('an embedded navigation finishes before a second context operation may mutate its source', async () => {
  const h = setup(), ready = deferred();
  let claims = 0;
  h.window.addEventListener(EVENT, (event) => { event.detail.claim(async () => { claims += 1; await ready.promise; }); });
  const first = h.switchToVersion(h.nav, target, 'source');
  await flush();
  const second = h.changeContext({ action: 'context-branch', operation: 'edit-answer', sessionId: 'source', turn: 1, text: 'second edit' });
  const completed = Promise.allSettled([first, second]);
  await flush();
  const beforeRelease = h.sent.filter((body) => body.action === 'context-branch');
  ready.resolve();
  const outcomes = await completed;
  assert.equal(beforeRelease.length, 0, 'the second operation must fail before creating another session');
  assert.equal(outcomes[0].status, 'fulfilled');
  assert.equal(outcomes[1].status, 'rejected');
  assert.match(outcomes[1].reason.message, /switch|wait|切换|稍后/i);
  assert.equal(claims, 1);
  await h.changeContext({ action: 'context-branch', operation: 'edit-answer', sessionId: 'source', turn: 1, text: 'later edit' });
  assert.equal(h.sent.filter((body) => body.action === 'context-branch').length, 1);
});

test('a rejected embedded navigation releases its claim so the next operation can run', async () => {
  const h = setup(); let fail = true;
  h.window.addEventListener(EVENT, (event) => { event.detail.claim(async () => { if (fail) throw new Error('cannot save this card'); }); });
  await assert.rejects(h.switchToVersion(h.nav, target, 'source'), /cannot save/);
  fail = false;
  await h.changeContext({ action: 'context-branch', operation: 'edit-answer', sessionId: 'source', turn: 1, text: 'retry edit' });
  assert.equal(h.sent.filter((body) => body.action === 'context-branch').length, 1);
  assert.deepEqual(h.opened, []);
});
