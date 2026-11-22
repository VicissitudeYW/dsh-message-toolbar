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

function appendReplayTurn(h, turn, messageId, reason = { kind: 'completed' }) {
  h.session.append('turn/start', { turn });
  h.session.append('user/message', { id: messageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'replayed question' }] });
  h.session.append('turn/end', { turn, reason });
}

const eventTurnSettled = () => new Promise((resolve) => setImmediate(resolve));

test('native question-answer actions are routed through public session branches and never queue the source agent', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(result.status, 200);
  assert.equal(typeof result.payload.sessionId, 'string');
  assert.notEqual(result.payload.sessionId, 'session-test');
  assert.equal(h.sent.length, 0);
  assert.equal(h.children[0].sent.length, 1);
  assert.deepEqual(h.children[0].sent[0].content, [{ type: 'text', text: 'question 1' }]);
  assert.ok(h.flushed.includes(result.payload.sessionId));
  const focused = await h.post({ action: 'focus', sessionId: result.payload.sessionId, token: result.payload.navigationToken });
  assert.equal(focused.status, 200, focused.payload.error);
  assert.deepEqual(h.archived, []);
});

test('a retry response waits until its queued question is appended to the child session', async () => {
  reset(); const h = harness(history(), { deferFollowupMessage: true });
  let settled = false;
  const pending = h.post({ action: 'context-branch', operation: 'retry', turn: 1 }).then(result => {
    settled = true;
    return result;
  });
  await eventTurnSettled();
  assert.equal(settled, false, 'an HTTP success must not acknowledge an inbox-only prompt');
  h.children[0].appendQueuedMessage();
  const result = await pending;
  assert.equal(result.status, 200, result.payload.error);
  assert.equal(h.children[0].session.events.some(event => event.type === 'user/message'
    && event.data.id === h.children[0].sent[0].id), true);
  assert.equal(h.flushed.filter(id => id === result.payload.sessionId).length, 2,
    'the branch and its appended prompt are both durably flushed before success');
});

test('an unfinished retry branch keeps prior choices but has no active answer until one is written', async () => {
  reset(); const h = harness(history());
  const result = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(result.status, 200, result.payload.error);
  const child = h.children[0];
  child.session.append('turn/end', { turn: 1, reason: { kind: 'error', message: 'provider unavailable' } });
  const state = await h.get(result.payload.sessionId);
  assert.equal(state.status, 200, state.payload.error);
  assert.deepEqual(state.payload.contextChoices['1'].items.map(item => item.preview), ['answer 1']);
  assert.equal(state.payload.contextChoices['1'].active, null);
});

test('context saves and deletes change only a flushed child, never the source events', async () => {
  for (const operation of ['edit-prompt', 'edit-answer', 'delete-answer', 'delete-question']) {
    reset(); const h = harness(); const before = structuredClone(h.events);
    const response = await h.post({ action: 'context-branch', operation, turn: 1, text: 'edited' });
    assert.equal(response.status, 200, response.payload.error);
    assert.deepEqual(h.events, before); assert.equal(h.sent.length, 0);
    assert.equal(h.children[0].sent.length, 0);
    const texts = h.children[0].session.events.filter(e => ['user/message', 'assistant/message'].includes(e.type))
      .map(e => (e.data.message ?? e.data).content.map(b => b.text).join(''));
    assert.deepEqual(texts, ({ 'edit-prompt': ['edited', 'answer 1'], 'edit-answer': ['question 1', 'edited'],
      'delete-answer': ['question 1'], 'delete-question': [] })[operation]);
    const focused = await h.post({ action: 'focus', sessionId: response.payload.sessionId, token: response.payload.navigationToken });
    assert.equal(focused.status, 200, focused.payload.error);
    assert.deepEqual(h.archived, [], operation);
  }
});

test('a failed branch flush releases the child without archiving it or queuing the source', async () => {
  reset(); const h = harness(history(), { flushError: new Error('disk full') });
  const result = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(result.status, 409); assert.match(result.payload.error, /disk full/);
  assert.deepEqual(h.sent, []); assert.equal(h.children[0].sent.length, 0);
  assert.deepEqual(h.archived, []); assert.equal(h.disposed.length, 1);
});

test('a missing persistence listener cannot acknowledge or queue a durable branch', async () => {
  reset(); const h = harness();
  h.ctx.sessions.flush = async () => false;
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(response.status, 409);
  assert.equal(h.children[0].sent.length, 0);
  assert.equal(h.archived.includes('session-test'), false);
  assert.equal(h.disposed.length, 1);
});

test('preparing navigation rejects unrelated conversations without persisting a focus job', async () => {
  reset(); const h = harness();
  await h.ctx.agents.create({ sessionId: 'native-fork', seed: h.events,
    meta: { parentSession: 'session-test', cwd: os.homedir(), isSeeded: true }, inheritedEventCount: h.events.length });
  const response = await h.post({ action: 'prepare-focus', sessionId: 'native-fork', sourceSessionId: 'session-test' });
  assert.equal(response.status, 409);
  assert.equal(store.navigationFor('native-fork'), undefined);
});

test('deleting the current version returns to its parent and removes only the toolbar card', async () => {
  reset(); const h = harness();
  const created = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'edited' });
  const response = await h.post({ action: 'delete-version', sessionId: created.payload.sessionId });
  assert.equal(response.status, 200, response.payload.error);
  assert.equal(response.payload.sessionId, 'session-test');
  assert.equal(h.archived.includes(created.payload.sessionId), false);
  const focused = await h.post({ action: 'focus', sessionId: response.payload.sessionId, token: response.payload.navigationToken });
  assert.equal(focused.status, 200, focused.payload.error);
  assert.deepEqual(h.archived, []);
  const parent = await h.get();
  assert.equal(parent.payload.versions.find(version => version.sessionId === created.payload.sessionId)?.deleted, true);
});

test('deleting the current version can return to an available sibling when its parent is archived', async () => {
  reset(); const h = harness();
  const sibling = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'first' });
  const open = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'second' });
  await h.ctx.get('workspaceRegistry').archiveSession('session-test');

  const removed = await h.post({ action: 'delete-version', sessionId: open.payload.sessionId });
  assert.equal(removed.status, 200, removed.payload.error);
  assert.equal(removed.payload.sessionId, sibling.payload.sessionId);
  assert.equal(removed.payload.archived, false);
  assert.deepEqual(h.archived, ['session-test']);
});

test('deleting the only open version leaves it available until another version is opened', async () => {
  reset(); const h = harness();
  const open = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'edited' });
  await h.ctx.get('workspaceRegistry').archiveSession('session-test');

  const removed = await h.post({ action: 'delete-version', sessionId: open.payload.sessionId });
  assert.equal(removed.status, 409);
  assert.match(removed.payload.error, /打开其他版本/);
  assert.equal(store.deletedVersionIds().has(open.payload.sessionId), false);
  assert.deepEqual(h.archived, ['session-test']);
});

test('deleting a version preserves it when the replacement is archived before the handoff is saved', async () => {
  reset(); const h = harness();
  const open = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'edited' });
  const query = h.ctx.sessionQuery;
  const list = query.listSessions;
  let lookups = 0;
  query.listSessions = async () => {
    if (++lookups === 2) await h.ctx.get('workspaceRegistry').archiveSession('session-test');
    return list();
  };

  const removed = await h.post({ action: 'delete-version', sessionId: open.payload.sessionId });
  assert.equal(removed.status, 409);
  assert.equal(store.deletedVersionIds().has(open.payload.sessionId), false);
  assert.deepEqual(h.archived, ['session-test']);
});

test('an old pending handoff survives reload without changing the archive', async () => {
  reset(); const h = harness();
  const first = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'first' });
  store.recordNavigation('session-test', { token: 'legacy-token', root: 'session-test', source: 'session-test',
    target: first.payload.sessionId, completed: false, archived: false, sourceArchived: false });
  store.flushState(); store.reloadState();

  const target = await h.get(first.payload.sessionId);
  assert.equal(target.payload.pendingFocus?.token, 'legacy-token');
  const result = await h.post({ action: 'focus', sessionId: first.payload.sessionId, token: 'legacy-token' });
  assert.equal(result.status, 200, result.payload.error);
  assert.equal((await h.get(first.payload.sessionId)).payload.pendingFocus, null);
  assert.deepEqual(h.archived, []);
});

test('cancelling navigation preserves a source the user archived after preparing the handoff', async () => {
  reset(); const h = harness();
  const branch = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'edited' });
  const registry = h.ctx.get('workspaceRegistry');
  await registry.archiveSession('session-test');
  const cancelled = await h.post({ action: 'cancel-focus', sessionId: branch.payload.sessionId, token: branch.payload.navigationToken });
  assert.equal(cancelled.status, 200, cancelled.payload.error);
  assert.equal(cancelled.payload.cancelled, true);
  const focused = await h.post({ action: 'focus', sessionId: branch.payload.sessionId, token: branch.payload.navigationToken });
  assert.equal(focused.status, 409);
  assert.deepEqual(h.archived, ['session-test']);
});

test('restoring an old version card leaves it archived until that version is explicitly opened', async () => {
  reset(); const h = harness();
  const branch = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'edited' });
  const sessionId = branch.payload.sessionId;
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

test('native answer choices deduplicate edits and inherited copies and retain the selected continuation', async () => {
  reset(); const h = harness();
  const retried = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  const child = h.children[0];
  child.session.append('assistant/message', { turn: 1, step: 1, message: { id: 'new-a1', role: 'assistant', content: [{ type: 'text', text: 'new answer' }] } });
  child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const edited = await h.post({ action: 'context-branch', operation: 'edit-answer', sessionId: retried.payload.sessionId, turn: 1, text: 'edited answer' });
  const result = await h.get(edited.payload.sessionId);
  assert.equal(result.status, 200, result.payload.error);
  assert.equal(result.payload.contextChoices['1'].items.length, 2);
  assert.deepEqual(result.payload.contextChoices['1'].items.map(item => item.preview), ['answer 1', 'edited answer']);
  assert.equal(result.payload.contextChoices['1'].items[1].sessionId, edited.payload.sessionId);
});

test('a superseded navigation cannot complete, and the current navigation leaves all versions available', async () => {
  reset(); const h = harness();
  const first = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'first edit' });
  const second = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'second edit' });
  const stale = await h.post({ action: 'focus', sessionId: first.payload.sessionId, token: first.payload.navigationToken });
  assert.equal(stale.status, 409);
  assert.deepEqual(h.archived, []);
  const focused = await h.post({ action: 'focus', sessionId: second.payload.sessionId, token: second.payload.navigationToken });
  assert.equal(focused.status, 200, focused.payload.error);
  assert.deepEqual(h.archived, []);
  assert.equal((await h.get(second.payload.sessionId)).payload.pendingFocus, null);
});

test('successive edits record operation time so later versions sort after their source', async () => {
  reset(); const h = harness();
  const first = await h.post({ action: 'context-branch', operation: 'edit-answer', turn: 1, text: 'edit one' });
  const second = await h.post({ action: 'context-branch', operation: 'edit-answer', sessionId: first.payload.sessionId, turn: 1, text: 'edit two' });
  const firstVersion = (await h.get(first.payload.sessionId)).payload.versions.find(version => version.sessionId === first.payload.sessionId);
  const secondVersion = (await h.get(second.payload.sessionId)).payload.versions.find(version => version.sessionId === second.payload.sessionId);
  assert.ok(secondVersion.createdAt > firstVersion.createdAt,
    `new edit time ${secondVersion.createdAt} must follow prior edit time ${firstVersion.createdAt}`);
});

test('deleting an alternative removes it from every live choice while preserving the prompt', async () => {
  reset(); const h = harness();
  const first = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  const child = h.children[0];
  child.session.append('assistant/message', { turn: 1, step: 1, message: { id: 'new', role: 'assistant', content: [{ type: 'text', text: 'new answer' }] } });
  child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  const removed = await h.post({ action: 'context-branch', operation: 'delete-answer', sessionId: first.payload.sessionId, turn: 1 });
  assert.equal(removed.status, 200, removed.payload.error);
  assert.equal(removed.payload.sessionId, 'session-test');
  const state = (await h.get()).payload;
  assert.equal(state.contextChoices['1'].items.length, 1);
  assert.equal(state.contextChoices['1'].items[0].preview, 'answer 1');
});

test('deleting an answer stays on the new continuation if the alternate answer is archived', async () => {
  reset(); const h = harness();
  const first = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  const child = h.children[0];
  child.session.append('assistant/message', { turn: 1, step: 1, message: { id: 'new', role: 'assistant', content: [{ type: 'text', text: 'new answer' }] } });
  child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await h.ctx.get('workspaceRegistry').archiveSession('session-test');

  const removed = await h.post({ action: 'context-branch', operation: 'delete-answer', sessionId: first.payload.sessionId, turn: 1 });
  assert.equal(removed.status, 200, removed.payload.error);
  assert.equal(removed.payload.sessionId, removed.payload.createdSessionId);
  assert.equal(removed.payload.archived, false);
  assert.deepEqual(h.archived, ['session-test']);
});

test('legacy answer selection materializes only the chosen answer in a native session', async () => {
  reset(); const h = harness(history(3));
  store.recordRun('session-test', 1, 3);
  store.setPromptOverride('session-test', 1, 'edited old question', []);
  const initial = (await h.get()).payload;
  assert.equal(initial.contextChoices['1'].items.length, 2);
  const target = initial.contextChoices['1'].items.find(item => item.preview === 'answer 1');
  const selected = await h.post({ action: 'context-select', turn: 1, id: target.id });
  assert.equal(selected.status, 200, selected.payload.error);
  assert.deepEqual(h.children[0].session.events.filter(e => e.type === 'assistant/message').map(e => e.data.message.content[0].text), ['answer 1']);
  assert.equal(h.sent.length, 0);
});

test('a legacy session keeps each answer menu keyed to its original question after folding earlier replays', async () => {
  reset();
  const h = harness(history(4));
  store.recordRun('session-test', 1, 2);
  store.recordRun('session-test', 3, 4);
  const source = (await h.get()).payload;

  assert.deepEqual(source.contextChoices['3'].items.map(item => item.preview).sort(), ['answer 3', 'answer 4']);
  const result = await h.post({ action: 'context-normalize' });
  const migrated = (await h.get(result.payload.sessionId)).payload;
  assert.deepEqual(migrated.contextChoices['2'].items.map(item => item.preview).sort(), ['answer 3', 'answer 4']);
});

test('context normalization migrates a legacy session with a stale replacement summary into a navigable native session', async () => {
  reset();
  const events = history(3);
  for (const event of events) {
    if (event.type === 'user/message' || event.type === 'assistant/message') event.surfaceOp = 'append';
  }
  events.push({ seq: events.length, type: 'developer/message', time: 200,
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 }, sourceEventSeqs: [1, 2],
    data: { id: 'compressed-summary', role: 'developer',
      content: [{ type: 'text', text: 'summary of the original first answer' }] } });
  const before = structuredClone(events);
  const h = harness(events);
  store.recordRun('session-test', 1, 3);
  store.setPromptOverride('session-test', 1, 'edited legacy question', []);

  const result = await h.post({ action: 'context-normalize', sessionId: 'session-test' });

  assert.equal(result.status, 200, result.payload.error);
  assert.notEqual(result.payload.sessionId, 'session-test');
  assert.equal(typeof result.payload.createdSessionId, 'string');
  assert.equal(typeof result.payload.navigationToken, 'string');
  assert.equal(result.payload.sourceSessionId, 'session-test');
  assert.deepEqual(events, before, 'normalization must never mutate the source session');
  assert.equal(h.sent.length, 0, 'normalization must not queue a model request');
  assert.equal(h.requests.length, 0, 'normalization must not call the model');

  const child = h.children.find(item => item.session.header.id === result.payload.sessionId);
  assert.ok(child, 'the response must point at the created native session');
  assert.equal(child.session.events.some(event => event.data?.id === 'compressed-summary'), false,
    'a summary covering changed legacy events must not be copied into the new branch');
  assert.equal(child.session.events.some(event => event.type === 'user/message'
    && event.data.content.some(block => block.text === 'edited legacy question')), true);
});

test('context normalization reuses its durable child and preserves only original hidden prompts', async () => {
  reset();
  const h = harness(history(3));
  store.recordRun('session-test', 1, 3);
  store.setHidden('session-test', 'prompt', 1, true);
  store.setHidden('session-test', 'prompt', 3, true);
  store.storeTranslation('session-test', 2, 'en', { turn: 1, text: 'original translation' });

  const first = await h.post({ action: 'context-normalize', sessionId: 'session-test' });
  assert.equal(first.status, 200, first.payload.error);
  const target = first.payload.sessionId;
  const focused = await h.post({ action: 'focus', sessionId: target, token: first.payload.navigationToken });
  assert.equal(focused.status, 200, focused.payload.error);
  assert.deepEqual(h.archived, []);
  assert.deepEqual(store.hiddenForSession(target).prompts, [1]);
  assert.equal(store.migrationFor('session-test')?.targetSessionId, target);
  assert.equal((await h.get(target)).payload.needsContextMigration, false);
  assert.equal(store.translationFor('session-test', 2, 'en')?.text, 'original translation');

  await h.ctx.get('workspaceRegistry').archiveSession(target);
  store.flushState();
  store.reloadState();
  const retried = await h.post({ action: 'context-normalize', sessionId: 'session-test' });

  assert.equal(retried.status, 200, retried.payload.error);
  assert.equal(retried.payload.sessionId, target);
  assert.equal(retried.payload.reusedMigration, true);
  assert.equal(retried.payload.archived, true);
  assert.equal(h.children.length, 1);
  assert.deepEqual(store.hiddenForSession(target).prompts, [1]);
  assert.equal(h.sent.length, 0);
  assert.equal(h.requests.length, 0);
});

test('automatic migration never reuses a snapshot after the original history grows', async () => {
  reset(); const h = harness(history(1));
  store.setPromptOverride('session-test', 1, 'edited old question', []);
  const first = await h.post({ action: 'context-normalize' });
  assert.equal(first.status, 200, first.payload.error);
  appendReplayTurn(h, 2, 'new-follow-up');

  const next = await h.post({ action: 'context-normalize' });
  assert.equal(next.status, 200, next.payload.error);
  assert.notEqual(next.payload.sessionId, first.payload.sessionId);
  const messages = h.children.at(-1).session.events.filter(event => event.type === 'user/message');
  assert.deepEqual(messages.map(event => event.data.id), ['u1', 'new-follow-up']);
});

test('source growth during migration prevents a handoff to an incomplete snapshot', async () => {
  reset(); const h = harness(history(1));
  store.setPromptOverride('session-test', 1, 'edited old question', []);
  const flushBranch = h.ctx.sessions.flush;
  let pushed = false;
  h.ctx.sessions.flush = async session => {
    if (!pushed) { pushed = true; appendReplayTurn(h, 2, 'concurrent-follow-up'); }
    return flushBranch(session);
  };

  const result = await h.post({ action: 'context-normalize' });
  assert.equal(result.status, 409);
  assert.match(result.payload.error, /原会话有了新消息/);
  assert.equal(store.migrationFor('session-test'), undefined);
  assert.equal(h.archived.includes('session-test'), false);
  const next = await h.post({ action: 'context-normalize' });
  assert.equal(next.status, 200, next.payload.error);
  assert.equal(h.children.at(-1).session.events.some(event => event.data?.id === 'concurrent-follow-up'), true);
});

test('automatic migration never reopens a version the user deleted', async () => {
  reset();
  const h = harness(history());
  store.setPromptOverride('session-test', 1, 'edited old question', []);
  const first = await h.post({ action: 'context-normalize' });
  assert.equal(first.status, 200, first.payload.error);
  store.markDeleted(first.payload.sessionId, { parent: 'session-test', turn: 1 });

  const next = await h.post({ action: 'context-normalize' });

  assert.equal(next.status, 200, next.payload.error);
  assert.notEqual(next.payload.sessionId, first.payload.sessionId);
  assert.equal(store.deletedVersionIds().has(first.payload.sessionId), true);
  assert.equal(store.migrationFor('session-test')?.targetSessionId, next.payload.sessionId);
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
  const native = await h.ctx.agents.create({ sessionId: 'native-fork', seed: h.events, meta: { parentSession: 'session-test', cwd: os.homedir(), isSeeded: true }, inheritedEventCount: h.events.length });
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

test('simultaneous context requests cannot both create branches from one source', async () => {
  reset(); const h = harness();
  const responses = await Promise.all([1, 2].map(() => h.post({ action: 'context-branch', operation: 'retry', turn: 1 })));
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  assert.equal(h.children.length, 1);
});

test('a native followup queue failure disposes the child without selecting or queuing the source', async () => {
  reset(); const h = harness(history(), { followupError: new Error('queue failed') });
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 1, model: { provider: 'p', model: 'other' } });
  assert.equal(response.status, 409); assert.match(response.payload.error, /queue failed/);
  assert.equal(h.disposed.length, 1); assert.deepEqual(h.selected, []); assert.deepEqual(h.sent, []);
});

test('native model switching restores the prior selection after its exact generated turn', async () => {
  reset(); const h = harness();
  await h.post({ action: 'context-branch', operation: 'retry', turn: 1, model: { provider: 'p', model: 'other' } });
  const child = h.children[0];
  assert.equal(child.model.current().model, 'other');
  child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await eventTurnSettled();
  assert.equal(child.model.current().model, 'original'); assert.equal(h.listenerCount(), 0);
});

test('a completed alternate-model version keeps its model label after composer restoration', async () => {
  reset(); const h = harness();
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 1,
    model: { provider: 'p', model: 'other' } });
  assert.equal(response.status, 200, response.payload.error);
  const child = h.children[0];
  child.session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'alternate-answer',
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'other' },
      content: [{ type: 'text', text: 'answer from alternate' }],
    },
  });
  child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await eventTurnSettled();
  assert.equal(child.model.current().model, 'original');

  const state = await h.get(response.payload.sessionId);
  assert.equal(state.status, 200, state.payload.error);
  const version = state.payload.versions.find(item => item.sessionId === response.payload.sessionId);
  assert.equal(version.model.model, 'other');
  const choice = state.payload.contextChoices['1'].items.find(item => item.sessionId === response.payload.sessionId);
  assert.equal(choice.model, 'other');
});

test('a version without an explicit model uses the session model as its label', async () => {
  reset(); const h = harness();
  const response = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(response.status, 200, response.payload.error);
  const child = h.children[0];
  child.session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: {
      id: 'default-answer',
      role: 'assistant',
      source: { kind: 'model', provider: 'p', model: 'original' },
      content: [{ type: 'text', text: 'answer from default' }],
    },
  });
  child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await eventTurnSettled();

  const state = await h.get(response.payload.sessionId);
  assert.equal(state.status, 200, state.payload.error);
  const version = state.payload.versions.find(item => item.sessionId === response.payload.sessionId);
  assert.equal(version.model.model, 'original');
});

test('native restoration preserves a newer user model selection', async () => {
  reset(); const h = harness();
  await h.post({ action: 'context-branch', operation: 'retry', turn: 1, model: { provider: 'p', model: 'other' } });
  const child = h.children[0];
  child.model.select({ provider: 'p', model: 'newer' });
  child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await eventTurnSettled(); assert.equal(child.model.current().model, 'newer');
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
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).navigation['session-test'].target, result.payload.sessionId);
  assert.ok(h.flushed.includes(result.payload.sessionId));
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
  const h = harness(events);
  const result = await h.post({ action: 'context-branch', operation: 'retry', turn: 1 });
  assert.equal(result.status, 200, result.payload.error);
  assert.equal(h.children[0].model.current().model, 'current');
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
