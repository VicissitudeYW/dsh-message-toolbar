import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { clientHarness, state } from './helpers/client-harness.mjs';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-host-regression-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const { harness, history } = await import('./helpers/host-harness.mjs');
const store = await import('../lib/state-store.js');
const stateFile = path.join(home, '.dsh', 'message-toolbar', 'state.json');
after(() => { store.flushState(); fs.rmSync(home, { recursive: true, force: true }); });

function reset() {
  store.flushState(); fs.rmSync(stateFile, { force: true }); store.reloadState();
}

function finishAnswer(h, turn, text, model = 'original') {
  h.session.append('assistant/message', { turn, step: 1, message: { id: `answer-${turn}`, role: 'assistant',
    source: { kind: 'model', provider: 'p', model }, content: [{ type: 'text', text }] } });
  h.session.append('turn/end', { turn, reason: { kind: 'completed' } });
}

function legacyVersion(h, sessionId, effect = {}) {
  const { agent } = h.seedSession({ sessionId, seed: history(1), inheritedEventCount: 4,
    meta: { parentSession: 'session-test', cwd: os.homedir(), isSeeded: true } });
  agent.session.append('message-toolbar/version', { schemaVersion: 2, sessionId,
    effect: { operation: 'edit-answer', targetTurn: 1, ...effect }, inverse: { kind: 'restore-version', sessionId: 'session-test' } });
  return sessionId;
}

const eventTurnSettled = () => new Promise((resolve) => setImmediate(resolve));

test('regeneration queues only the source agent without navigation or archive changes', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'context-update', operation: 'retry', turn: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.payload.sessionId, 'session-test');
  assert.equal(result.payload.navigationToken, undefined);
  assert.equal(h.sent.length, 1);
  assert.deepEqual(h.sent[0].content, [{ type: 'text', text: 'question 1' }]);
  assert.deepEqual(h.flushed, ['session-test', 'session-test']);
  assert.deepEqual(h.archived, []);
  assert.deepEqual((await h.get()).payload.versions.map(version => version.sessionId), ['session-test']);
});

test('a retry response waits until its queued question is appended to the original session', async () => {
  reset(); const h = harness(history(), { deferFollowupMessage: true });
  let settled = false;
  const pending = h.post({ action: 'context-branch', operation: 'retry', turn: 1 }).then(result => {
    settled = true;
    return result;
  });
  await eventTurnSettled();
  assert.equal(settled, false, 'an HTTP success must not acknowledge an inbox-only prompt');
  h.agent.appendQueuedMessage();
  const result = await pending;
  assert.equal(result.status, 200, result.payload.error);
  assert.equal(h.events.some(event => event.type === 'user/message' && event.data.id === h.sent[0].id), true);
  assert.equal(h.flushed.filter(id => id === result.payload.sessionId).length, 2,
    'existing history and the admitted prompt are both durably flushed before success');
});

test('a failed retry still lets the reader recover the original answer and continuation', async () => {
  reset(); const h = harness(history());
  const result = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(result.status, 200, result.payload.error);
  h.session.append('turn/end', { turn: 3, reason: { kind: 'error', message: 'provider unavailable' } });
  const state = await h.get(result.payload.sessionId);
  assert.equal(state.status, 200, state.payload.error);
  assert.equal(state.payload.contextChoices['3'].items.length, 2, 'the failed turn still offers the answer switcher');
  const first = state.payload.contextChoices['3'].items[0];
  assert.equal(first.preview, 'answer 1');
  const selected = await h.post({ action: 'context-select', turn: 3, id: first.id });
  assert.equal(selected.status, 200, selected.payload.error);
  assert.deepEqual((await h.get()).payload.hidden.turns, [3]);
});

test('editing or deleting a middle message preserves the surrounding transcript and source events', async () => {
  const checkDisplay = {
    'edit-prompt': state => assert.equal(state.prompts['2'].text, 'edited'),
    'edit-answer': state => assert.equal(state.answers['2'].override.text, 'edited'),
    'delete-answer': state => assert.deepEqual(state.hidden.answers, [2]),
    'delete-question': state => assert.deepEqual(state.hidden.turns, [2]),
  };
  for (const [operation, check] of Object.entries(checkDisplay)) {
    reset(); const h = harness(history(3)); const before = structuredClone(h.events);
    const response = await h.post({ action: 'context-update', operation, turn: 2, text: 'edited' });
    assert.equal(response.status, 200, response.payload.error);
    assert.equal(response.payload.sessionId, 'session-test');
    assert.deepEqual(h.events, before); assert.equal(h.sent.length, 0);
    store.reloadState();
    const { payload } = await h.get();
    check(payload);
    assert.deepEqual(Object.keys(payload.contextChoices), operation === 'delete-question' ? ['1', '3'] : ['1', '2', '3'], operation);
    assert.deepEqual(h.archived, [], operation);
  }
});

test('deleting a question keeps the later question’s answer choices and their continuations', async () => {
  reset(); const h = harness(history(3));
  await h.post({ action: 'context-update', operation: 'retry', turn: 2 });
  finishAnswer(h, 4, 'second answer to question 2');
  const { items } = (await h.get()).payload.contextChoices['4'];
  const [original, retry] = items;
  await h.post({ action: 'context-select', turn: 4, id: original.id });
  const removed = await h.post({ action: 'context-update', operation: 'delete-question', turn: 1 });
  assert.equal(removed.status, 200, removed.payload.error);
  assert.deepEqual((await h.get()).payload.hidden.turns, [1, 4]);
  await h.post({ action: 'context-select', turn: 2, id: retry.id });
  assert.deepEqual((await h.get()).payload.hidden.turns, [1, 2, 3]);
  await h.post({ action: 'context-select', turn: 4, id: original.id });
  assert.deepEqual((await h.get()).payload.hidden.turns, [1, 4]);
});

test('failure to persist the existing log leaves the previous selection intact', async () => {
  reset(); const h = harness(history(), { flushError: new Error('disk full') });
  const result = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(result.status, 409); assert.match(result.payload.error, /disk full/);
  assert.deepEqual(h.sent, []);
  assert.deepEqual(h.archived, []);
  assert.equal(store.contextFor('session-test'), undefined);
});

test('a missing persistence listener cannot acknowledge or queue a retry', async () => {
  reset(); const h = harness();
  h.ctx.sessions.flush = async () => false;
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(response.status, 409);
  assert.equal(h.sent.length, 0);
  assert.equal(h.archived.includes('session-test'), false);
});

test('preparing navigation rejects unrelated conversations without persisting a focus job', async () => {
  reset(); const h = harness();
  h.seedSession({ sessionId: 'native-fork', seed: h.events,
    meta: { parentSession: 'session-test', cwd: os.homedir(), isSeeded: true }, inheritedEventCount: h.events.length });
  const response = await h.post({ action: 'prepare-focus', sessionId: 'native-fork', sourceSessionId: 'session-test' });
  assert.equal(response.status, 409);
  assert.equal(store.navigationFor('native-fork'), undefined);
});

test('deleting the current version returns to its parent and removes only the toolbar card', async () => {
  reset(); const h = harness();
  const versionId = legacyVersion(h, 'old-version');
  const response = await h.post({ action: 'delete-version', sessionId: versionId });
  assert.equal(response.status, 200, response.payload.error);
  assert.equal(response.payload.sessionId, 'session-test');
  assert.equal(h.archived.includes(versionId), false);
  const focused = await h.post({ action: 'focus', sessionId: response.payload.sessionId, token: response.payload.navigationToken });
  assert.equal(focused.status, 200, focused.payload.error);
  assert.deepEqual(h.archived, []);
  const parent = await h.get();
  assert.equal(parent.payload.versions.find(version => version.sessionId === versionId)?.deleted, true);
});

test('deleting the current version can return to an available sibling when its parent is archived', async () => {
  reset(); const h = harness();
  const sibling = legacyVersion(h, 'old-first');
  const open = legacyVersion(h, 'old-second');
  await h.ctx.get('workspaceRegistry').archiveSession('session-test');

  const removed = await h.post({ action: 'delete-version', sessionId: open });
  assert.equal(removed.status, 200, removed.payload.error);
  assert.equal(removed.payload.sessionId, sibling);
  assert.equal(removed.payload.archived, false);
  assert.deepEqual(h.archived, ['session-test']);
});

test('deleting the only open version leaves it available until another version is opened', async () => {
  reset(); const h = harness();
  const open = legacyVersion(h, 'old-version');
  await h.ctx.get('workspaceRegistry').archiveSession('session-test');

  const removed = await h.post({ action: 'delete-version', sessionId: open });
  assert.equal(removed.status, 409);
  assert.match(removed.payload.error, /打开其他版本/);
  assert.equal(store.deletedVersionIds().has(open), false);
  assert.deepEqual(h.archived, ['session-test']);
});

test('deleting a version preserves it when the replacement is archived before the handoff is saved', async () => {
  reset(); const h = harness();
  const open = legacyVersion(h, 'old-version');
  const query = h.ctx.sessionQuery;
  const list = query.listSessions;
  let lookups = 0;
  query.listSessions = async () => {
    if (++lookups === 2) await h.ctx.get('workspaceRegistry').archiveSession('session-test');
    return list();
  };

  const removed = await h.post({ action: 'delete-version', sessionId: open });
  assert.equal(removed.status, 409);
  assert.equal(store.deletedVersionIds().has(open), false);
  assert.deepEqual(h.archived, ['session-test']);
});

test('an old pending handoff survives reload without changing the archive', async () => {
  reset(); const h = harness();
  const first = legacyVersion(h, 'old-version');
  store.recordNavigation('session-test', { token: 'legacy-token', root: 'session-test', source: 'session-test',
    target: first, completed: false, archived: false, sourceArchived: false });
  store.flushState(); store.reloadState();

  const target = await h.get(first);
  assert.equal(target.payload.pendingFocus?.token, 'legacy-token');
  const result = await h.post({ action: 'focus', sessionId: first, token: 'legacy-token' });
  assert.equal(result.status, 200, result.payload.error);
  assert.equal((await h.get(first)).payload.pendingFocus, null);
  assert.deepEqual(h.archived, []);
});

test('cancelling navigation preserves a source the user archived after preparing the handoff', async () => {
  reset(); const h = harness();
  const version = legacyVersion(h, 'old-version');
  const { payload: job } = await h.post({ action: 'prepare-focus', sessionId: version, sourceSessionId: 'session-test' });
  const registry = h.ctx.get('workspaceRegistry');
  await registry.archiveSession('session-test');
  const cancelled = await h.post({ action: 'cancel-focus', sessionId: version, token: job.token });
  assert.equal(cancelled.status, 200, cancelled.payload.error);
  assert.equal(cancelled.payload.cancelled, true);
  const focused = await h.post({ action: 'focus', sessionId: version, token: job.token });
  assert.equal(focused.status, 409);
  assert.deepEqual(h.archived, ['session-test']);
});

test('restoring an old version card leaves it archived until that version is explicitly opened', async () => {
  reset(); const h = harness();
  const sessionId = legacyVersion(h, 'old-version');
  store.markDeleted(sessionId, { parent: 'session-test', turn: 1 });
  const registry = h.ctx.get('workspaceRegistry');
  await registry.archiveSession(sessionId);
  await registry.archiveSession('manual-archive');

  const restored = await h.post({ action: 'restore-version', sessionId });
  assert.equal(restored.status, 200, restored.payload.error);
  assert.equal((await h.get()).payload.versions.find(version => version.sessionId === sessionId)?.deleted, undefined);
  assert.deepEqual(h.archived, [sessionId, 'manual-archive']);

  const opened = await h.post({ action: 'activate', sessionId });
  assert.equal(opened.status, 200, opened.payload.error);
  assert.deepEqual(h.archived, ['manual-archive']);
});

test('an unsupported unarchive API never mutates private workspace state', async () => {
  reset(); const h = harness();
  const registry = h.ctx.get('workspaceRegistry');
  registry.archivedSessionIds.push('session-test');
  delete registry.unarchiveSession;
  let usedPrivate = false;
  registry.enqueueOperation = async fn => { usedPrivate = true; await fn(); };
  registry.requireState = () => ({ archivedSessionIds: ['session-test'] });
  registry.setState = async () => {};
  const response = await h.post({ action: 'activate' });
  assert.equal(response.status, 409);
  assert.equal(usedPrivate, false);
});

test('a superseded navigation cannot complete, and the current navigation leaves all versions available', async () => {
  reset(); const h = harness();
  const first = legacyVersion(h, 'old-first');
  const second = legacyVersion(h, 'old-second');
  const firstJob = await h.post({ action: 'prepare-focus', sessionId: first, sourceSessionId: 'session-test' });
  const secondJob = await h.post({ action: 'prepare-focus', sessionId: second, sourceSessionId: 'session-test' });
  const stale = await h.post({ action: 'focus', sessionId: first, token: firstJob.payload.token });
  assert.equal(stale.status, 409);
  assert.deepEqual(h.archived, []);
  const focused = await h.post({ action: 'focus', sessionId: second, token: secondJob.payload.token });
  assert.equal(focused.status, 200, focused.payload.error);
  assert.deepEqual(h.archived, []);
  assert.equal((await h.get(second)).payload.pendingFocus, null);
});

test('deleting the middle of three answers selects its predecessor and restores its followup', async () => {
  reset(); const h = harness();
  await h.post({ action: 'context-update', operation: 'retry', turn: 1 });
  finishAnswer(h, 3, 'answer B');
  await h.post({ action: 'context-update', operation: 'retry', turn: 3 });
  finishAnswer(h, 4, 'answer C');
  const { items } = (await h.get()).payload.contextChoices['4'];
  assert.deepEqual(items.map(item => item.preview), ['answer 1', 'answer B', 'answer C']);
  assert.equal((await h.post({ action: 'context-select', turn: 4, id: items[1].id })).status, 200);
  assert.equal((await h.post({ action: 'context-update', operation: 'delete-answer', turn: 3 })).status, 200);
  const { contextChoices, hidden } = (await h.get()).payload;
  assert.deepEqual(hidden.turns, [3, 4]);
  assert.equal(contextChoices['1'].active, items[0].id);
  assert.deepEqual(contextChoices['1'].items.map(item => item.preview), ['answer 1', 'answer C']);
});

test('legacy choices and edits are usable immediately without a migration session', async () => {
  reset(); const h = harness(history(4));
  store.recordRun('session-test', 1, 2);
  store.recordRun('session-test', 3, 4);
  store.setPromptOverride('session-test', 1, 'edited old question', []);
  const initial = (await h.get()).payload;
  assert.equal(initial.needsContextMigration, undefined);
  assert.deepEqual(initial.contextChoices['4'].items.map(item => item.preview), ['answer 3', 'answer 4']);
  assert.equal(initial.prompts['2'].text, 'edited old question');
  const first = initial.contextChoices['2'].items[0];
  const { status, payload } = await h.post({ action: 'context-select', turn: 2, id: first.id });
  assert.equal(status, 200, payload.error);
  assert.equal(payload.sessionId, 'session-test');
  assert.equal((await h.get()).payload.contextChoices['1'].active, first.id);
  assert.equal(h.sent.length, 0);
});

test('a legacy sync request leaves an archived migration copy untouched', async () => {
  reset(); const h = harness();
  const version = legacyVersion(h, 'legacy-copy');
  store.setPromptOverride('session-test', 1, 'edited old question', []);
  store.recordMigration('session-test', version, [], h.events.length - 1);
  await h.ctx.get('workspaceRegistry').archiveSession(version);
  const { status, payload } = await h.post({ action: 'context-normalize' });
  assert.equal(status, 200, payload.error);
  assert.equal(payload.sessionId, 'session-test');
  assert.equal(payload.navigationToken, undefined);
  assert.deepEqual(h.archived, [version]);
  assert.equal(h.sent.length, 0);
});

test('stale display-only mutation clients are rejected before changing history or state', async () => {
  reset(); const h = harness();
  for (const action of ['answer-run', 'answer-generate', 'prompt-save', 'answer-save', 'answer-select', 'run-select', 'run-delete', 'answer-delete', 'hide']) {
    const response = await h.post({ action, turn: 1, text: 'edited', scope: 'answer', hidden: true, active: 2, id: 'native' });
    assert.equal(response.status, 409, action);
    assert.match(response.payload.error, /更新.*重启/);
  }
  assert.equal(h.children.length, 0); assert.equal(h.sent.length, 0);
  assert.equal(store.answerEntry('session-test', 1), undefined);
});

test('native fork navigation never archives an unrelated source conversation', async () => {
  reset(); const h = harness();
  const native = h.seedSession({ sessionId: 'native-fork', seed: h.events, meta: { parentSession: 'session-test', cwd: os.homedir(), isSeeded: true }, inheritedEventCount: h.events.length });
  const focus = await h.post({ action: 'prepare-focus', sessionId: 'native-fork', sourceSessionId: 'native-fork' });
  assert.equal(focus.status, 200, focus.payload.error);
  const result = await h.post({ action: 'focus', sessionId: 'native-fork', token: focus.payload.token });
  assert.equal(result.status, 200, result.payload.error);
  assert.equal(h.archived.includes('session-test'), false);
  assert.equal(native.agent.session.header.parentSession, 'session-test');
});

test('invalid models, attachments and missing targets have no cancellation or queue effects', async () => {
  for (const body of [{ model: {} }, { files: 'bad' }, { files: [{ type: 'text' }] }, { turn: 999 }]) {
    reset(); const h = harness();
    const result = await h.post({ action: 'context-branch', operation: 'retry', turn: 1, stopPrevious: true, ...body });
    assert.equal(result.status, 400, result.payload.error);
    assert.equal(h.cancelled(), 0); assert.equal(h.children.length, 0); assert.equal(h.sent.length, 0);
  }
});

test('simultaneous toolbar retries admit at most one prompt', async () => {
  reset(); const h = harness();
  const responses = await Promise.all([1, 2].map(() => h.post({ action: 'context-branch', operation: 'retry', turn: 1 })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(h.sent.length, 1);
});

test('a failed native enqueue restores the previous model and answer state', async () => {
  reset(); const h = harness(history(), { followupError: new Error('queue failed') });
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 1, model: { provider: 'p', model: 'other' } });
  assert.equal(response.status, 409); assert.match(response.payload.error, /queue failed/);
  assert.equal(h.agent.model.current().model, 'original'); assert.deepEqual(h.sent, []);
  assert.equal(store.contextFor('session-test'), undefined);
  assert.equal(h.listenerCount(), 0);
});

test('native model switching restores the prior selection after its exact generated turn', async () => {
  reset(); const h = harness();
  await h.post({ action: 'context-branch', operation: 'retry', turn: 1, model: { provider: 'p', model: 'other' } });
  assert.equal(h.agent.model.current().model, 'other');
  h.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
  await eventTurnSettled();
  assert.equal(h.agent.model.current().model, 'original'); assert.equal(h.listenerCount(), 0);
});

test('a completed alternate-model version keeps its model label after composer restoration', async () => {
  reset(); const h = harness();
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 1,
    model: { provider: 'p', model: 'other' } });
  assert.equal(response.status, 200, response.payload.error);
  finishAnswer(h, 3, 'answer from alternate', 'other');
  await eventTurnSettled();
  assert.equal(h.agent.model.current().model, 'original');

  const state = await h.get(response.payload.sessionId);
  assert.equal(state.status, 200, state.payload.error);
  const choice = state.payload.contextChoices['3'].items.find(item => item.preview === 'answer from alternate');
  assert.equal(choice.model, 'other');
});

test('native restoration preserves a newer user model selection', async () => {
  reset(); const h = harness();
  await h.post({ action: 'context-branch', operation: 'retry', turn: 1, model: { provider: 'p', model: 'other' } });
  h.agent.model.select({ provider: 'p', model: 'newer' });
  h.session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
  await eventTurnSettled(); assert.equal(h.agent.model.current().model, 'newer');
});

test('reserved session object keys cannot corrupt shared dictionaries', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'context-branch', operation: 'edit-prompt', sessionId: '__proto__', turn: 1, text: 'x' });
  const polluted = Object.prototype['1'];
  delete Object.prototype['1'];
  assert.equal(result.status, 400);
  assert.equal(polluted, undefined);
});

test('all inherited session dictionary keys are rejected before state mutation', async () => {
  for (const sessionId of ['toString', 'valueOf', 'hasOwnProperty', '__defineGetter__']) {
    reset(); const h = harness();
    const result = await h.post({ action: 'context-branch', operation: 'edit-prompt', sessionId, turn: 1, text: 'x' });
    delete Object.prototype[sessionId]['1'];
    assert.equal(result.status, 400, sessionId);
  }
});

test('invalid JSON is a client error', async () => {
  reset(); const h = harness();
  assert.equal((await h.post({}, '{not json')).status, 400);
});

test('unsupported inherited language keys are rejected without a model call', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'translate', eventSeq: 2, lang: 'toString' });
  assert.equal(result.status, 400);
  assert.match(result.payload.error, /不支持的语言/);
  assert.equal(h.requests.length, 0);
});

test('file rollback failures expose retained backup paths to the client', async () => {
  reset(); const h = harness();
  h.events.push({ seq: 8, type: 'workspace/changes', data: { turn: 1 } });
  const error = Object.assign(new Error('rollback needs recovery'), {
    code: 'WORKSPACE_REVERT_IO', rollbackComplete: false, recoveryFiles: ['workspace/.mtt-backup'],
  });
  h.ctx.get = () => ({ summary() { throw error; } });
  const result = await h.post({ action: 'revert', turn: 1 });
  assert.equal(result.status, 409);
  assert.equal(result.payload.rollbackComplete, false);
  assert.deepEqual(result.payload.recoveryFiles, error.recoveryFiles);
  assert.match(result.payload.error, /workspace\/\.mtt-backup/);
});

test('the first translation response includes its source for immediate bilingual rendering', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'translate', eventSeq: 2, lang: 'zh' });
  assert.equal(result.status, 200);
  assert.equal(result.payload.origin, 'answer 1');
});

test('disconnecting a streaming translation aborts the provider signal without caching partial text', async () => {
  reset(); const h = harness();
  let streamStarted;
  const started = new Promise((resolve) => { streamStarted = resolve; });
  let release;
  const aborted = new Promise((resolve) => { release = resolve; });
  h.ctx.llm.stream = async function* (request) {
    h.requests.push(request);
    streamStarted();
    yield { type: 'text-delta', text: 'partial translation' };
    await aborted;
    request.signal.throwIfAborted();
  };
  const stream = h.postStream({ action: 'translate', turn: 1, text: 'answer 1', lang: 'zh', stream: true });
  await started;
  assert.ok(h.requests[0].signal instanceof AbortSignal);
  assert.equal(h.requests[0].signal.aborted, false);

  stream.close();
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await stream.completion;
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(store.translationFor('session-test', 'turn:1', 'zh'), undefined);
  assert.equal(store.shownForSession('session-test')['1'], undefined);
  assert.equal(stream.response.body.includes('"type":"done"'), false);
  assert.equal(stream.response.listenerCount('close'), 0);
});

test('a translation disconnected before session loading never starts a provider request', async () => {
  reset(); const h = harness(); let release;
  const loading = new Promise((resolve) => { release = resolve; });
  h.ctx.sessions.get = () => undefined;
  h.ctx.sessionQuery.observeSession = () => loading;
  const stream = h.postStream({ action: 'translate', eventSeq: 2, lang: 'zh', stream: true });
  stream.close();
  release(h.session);
  await stream.completion;
  assert.equal(h.requests.length, 0);
  assert.equal(store.shownForSession('session-test')['1'], undefined);
});

test('the DSH worker tunnel ending its response still cancels the translation provider', async () => {
  reset(); const h = harness();
  let started, unblock;
  const ready = new Promise((resolve) => { started = resolve; });
  const blocked = new Promise((resolve) => { unblock = resolve; });
  h.ctx.llm.stream = async function* (request) {
    h.requests.push(request);
    started();
    yield { type: 'text-delta', text: 'partial' };
    await blocked;
    request.signal.throwIfAborted();
  };
  const stream = h.postStream({ action: 'translate', eventSeq: 2, lang: 'zh', stream: true });
  await ready;
  // The worker response provides on/off but no Node removeListener method.
  stream.response.removeListener = undefined;
  stream.response.off = (name, listener) => EventEmitter.prototype.removeListener.call(stream.response, name, listener);
  stream.response.writableEnded = true;
  stream.response.emit('close');
  unblock();
  await stream.completion;
  assert.equal(h.requests[0].signal.aborted, true);
  assert.equal(store.translationFor('session-test', 2, 'zh'), undefined);
});

test('a slow session lookup cannot supersede a newer translation of the same turn', async () => {
  reset(); const h = harness();
  let releaseFirst;
  const firstRead = new Promise((resolve) => { releaseFirst = resolve; });
  let count = 0;
  h.ctx.sessions.get = () => undefined;
  h.ctx.sessionQuery.observeSession = () => ++count === 1 ? firstRead : h.session;
  const earlier = h.postStream({ action: 'translate', eventSeq: 2, lang: 'zh', stream: true });
  const later = h.postStream({ action: 'translate', turn: 1, text: 'answer 1', lang: 'fr', stream: true });
  await later.completion;
  releaseFirst(h.session);
  await earlier.completion;

  assert.equal(h.requests.length, 1);
  assert.equal(store.shownForSession('session-test')['1'], 'fr');
  assert.equal(store.translationFor('session-test', 2, 'zh'), undefined);
});

test('closing a translation invalidates the pending session lookup for that turn', async () => {
  reset(); const h = harness();
  let release;
  h.ctx.sessions.get = () => undefined;
  h.ctx.sessionQuery.observeSession = () => new Promise((resolve) => { release = resolve; });
  const stream = h.postStream({ action: 'translate', eventSeq: 2, lang: 'zh', stream: true });
  const off = await h.post({ action: 'translate-off', turn: 1 });
  assert.equal(off.status, 200);
  release(h.session);
  await stream.completion;
  assert.equal(h.requests.length, 0);
  assert.equal(store.shownForSession('session-test')['1'], undefined);
});

test('translate-off aborts only the active translation for its turn, even when addressed by eventSeq', async () => {
  reset(); const h = harness();
  const started = [];
  const releases = [];
  h.ctx.llm.stream = async function* (request) {
    h.requests.push(request);
    started.push(request);
    yield { type: 'text-delta', text: 'partial' };
    await new Promise((resolve) => { releases.push(resolve); });
    request.signal.throwIfAborted();
  };
  const first = h.postStream({ action: 'translate', eventSeq: 2, lang: 'zh', stream: true });
  const second = h.postStream({ action: 'translate', eventSeq: 6, lang: 'fr', stream: true });
  while (started.length < 2 || releases.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const off = await h.post({ action: 'translate-off', turn: 1 });
  assert.equal(off.status, 200);
  assert.equal(started[0].signal.aborted, true);
  assert.equal(started[1].signal.aborted, false);
  releases.forEach((resolve) => resolve());
  await Promise.all([first.completion, second.completion]);
  assert.equal(store.translationFor('session-test', 2, 'zh'), undefined);
  assert.equal(store.translationFor('session-test', 6, 'fr')?.text, 'partial');
});

test('client cancellation reaches the provider over a real HTTP streaming connection', { timeout: 5000 }, async (t) => {
  reset(); const h = harness();
  let providerStarted, routeFinished, providerSignal;
  const started = new Promise((resolve) => { providerStarted = resolve; });
  const completed = new Promise((resolve) => { routeFinished = resolve; });
  h.ctx.llm.stream = async function* (request) {
    providerSignal = request.signal;
    providerStarted();
    yield { type: 'text-delta', index: 0, text: 'partial' };
    await new Promise((resolve) => {
      if (request.signal.aborted) resolve();
      else request.signal.addEventListener('abort', resolve, { once: true });
    });
    request.signal.throwIfAborted();
  };
  const server = http.createServer((request, response) => {
    h.handle(request, response).finally(routeFinished);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const client = clientHarness(); client.store.set('session-test', state());
  client.window.fetch = (_url, init) => fetch(`http://127.0.0.1:${server.address().port}/message-toolbar`, init);
  const translating = client.translateInto('session-test', 1, { eventSeq: 2, lang: 'zh' });
  await started;
  assert.equal(providerSignal.aborted, false);
  client.cancelTranslation('session-test', 1);
  assert.equal(await translating, null);
  await completed;
  assert.equal(providerSignal.aborted, true);
  assert.equal(client.store.getLiveTranslation('session-test', 1), null);
  assert.equal(store.translationFor('session-test', 2, 'zh'), undefined);
  assert.equal(store.shownForSession('session-test')['1'], undefined);
});

test('translation cache cannot reuse the previous answer under the same turn key', async () => {
  reset(); const h = harness();
  await h.post({ action: 'translate', turn: 1, text: 'old answer', lang: 'zh' });
  const result = await h.post({ action: 'translate', turn: 1, text: 'changed answer', lang: 'zh' });
  assert.equal(result.status, 200);
  assert.equal(result.payload.cached, false);
  assert.equal(result.payload.origin, 'changed answer');
  assert.equal(h.requests.length, 2);
});

for (const kind of ['error', 'aborted']) {
  for (const action of ['translate']) {
    test(`${action} rejects a DSH ${kind} finish even after receiving partial text`, async () => {
      reset(); const h = harness();
      h.ctx.llm.stream = async function* () {
        yield { type: 'text-delta', index: 0, text: 'incomplete text' };
        yield { type: 'finish', reason: { kind, failure: { code: 'UPSTREAM_FAILURE', message: 'provider stopped' } } };
      };
      const result = await h.post({ action, turn: 1, text: 'answer 1', lang: 'zh' });
      assert.equal(result.status, 409);
      assert.match(result.payload.error, /provider stopped/);
      assert.equal(store.translationFor('session-test', 'turn:1', 'zh'), undefined);
      assert.equal(store.answerEntry('session-test', 1), undefined);
    });
  }
}

test('translation marks the DSH max-tokens finish as truncated', async () => {
  reset(); const h = harness();
  h.ctx.llm.stream = async function* () {
    yield { type: 'text-delta', index: 0, text: 'incomplete translation' };
    yield { type: 'finish', reason: { kind: 'max-tokens' } };
  };
  const result = await h.post({ action: 'translate', turn: 1, text: 'answer 1', lang: 'zh' });
  assert.equal(result.status, 200);
  assert.equal(result.payload.truncated, true);
  assert.equal(store.translationFor('session-test', 'turn:1', 'zh')?.truncated, true);
});

test('successful mutation acknowledgement already has durable state on disk', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'context-branch', operation: 'edit-prompt', turn: 1, text: 'durable' });
  assert.equal(result.status, 200, result.payload.error);
  assert.equal(fs.existsSync(stateFile), true);
  store.reloadState();
  assert.equal((await h.get(result.payload.sessionId)).payload.prompts['1'].text, 'durable');
});

test('editing an answer while translation streams prevents stale translation writeback', async () => {
  reset(); const h = harness();
  let release, signalStarted;
  const wait = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { signalStarted = resolve; });
  h.ctx.llm.stream = async function* () {
    signalStarted(); yield { type: 'text-delta', text: 'old translation' }; await wait;
  };
  const pending = h.post({ action: 'translate', turn: 1, text: 'answer 1', lang: 'zh' });
  await started;
  await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'changed answer' });
  release();
  assert.equal((await pending).status, 409);
  assert.equal(store.shownForSession('session-test')['1'], undefined);
  assert.equal(store.translationFor('session-test', 'turn:1', 'zh'), undefined);
});

test('folding model selection retires a consumed pending choice before later headers', async () => {
  reset();
  const events = history();
  events.push(
    { seq: 8, type: 'model/selection', data: { provider: 'p', model: 'old' } },
    { seq: 9, type: 'request/header', data: { header: { config: { provider: 'p', model: 'old' } } } },
    { seq: 10, type: 'request/header', data: { header: { config: { provider: 'p', model: 'current' } } } },
  );
  const h = harness(events, { cold: true });
  const result = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(result.status, 200, result.payload.error);
  assert.equal(h.resumed[0].agentOptions.model, 'current');
  assert.equal(h.resumed[0].resumeSessionId, 'session-test');
});

test('an aborted JSON request terminates instead of waiting forever for end', async () => {
  reset(); const h = harness();
  const request = Object.assign(new EventEmitter(), { method: 'POST', url: '/message-toolbar' });
  const response = { status: 0, headersSent: false, writeHead(status) { this.status = status; }, end() {} };
  const operation = h.handle(request, response);
  request.emit('aborted');
  let timer;
  const completed = await Promise.race([operation.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 100); })]);
  clearTimeout(timer);
  assert.equal(completed, true);
  assert.equal(response.status, 400);
});
