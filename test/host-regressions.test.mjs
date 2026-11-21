import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-host-regression-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const { apply } = await import('../lib/index.js');
const store = await import('../lib/state-store.js');
const stateFile = path.join(home, '.dsh', 'message-toolbar', 'state.json');
after(() => { store.flushState(); fs.rmSync(home, { recursive: true, force: true }); });

function reset() {
  store.flushState(); fs.rmSync(stateFile, { force: true }); store.reloadState();
}

function history(count = 2) {
  return Array.from({ length: count }, (_, i) => i + 1).flatMap((turn) => {
    const seq = (turn - 1) * 4;
    return [
      { seq, type: 'turn/start', data: { turn } },
      { seq: seq + 1, type: 'user/message', data: { id: `u${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `question ${turn}` }] } },
      { seq: seq + 2, type: 'assistant/message', data: { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', content: [{ type: 'text', text: `answer ${turn}` }] } } },
      { seq: seq + 3, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ];
  });
}

function harness(events = history(), { followupError } = {}) {
  let handler;
  const sent = [], selected = [], requests = [];
  const listeners = new Map();
  let cancelled = 0;
  let currentSelection = { provider: 'p', model: 'original', reasoningEffort: 'medium' };
  const dispatch = (subject, event) => {
    for (const listener of listeners.get('session/event') ?? []) listener(subject, event);
  };
  const session = { header: { id: 'session-test', cwd: home }, events, append(type, data) {
    const event = { seq: events.length, type, data };
    events.push(event);
    dispatch(session, event);
  } };
  const agentContext = { on(type, listener) {
    const bucket = listeners.get(type) ?? new Set();
    bucket.add(listener);
    listeners.set(type, bucket);
    return () => bucket.delete(listener);
  } };
  const agent = {
    ctx: agentContext,
    session,
    model: {
      current() { return currentSelection && { ...currentSelection }; },
      select(selection) { selected.push(selection); currentSelection = { ...selection }; session.append('model/selection', selection); },
    },
    followup(message) { if (followupError) throw followupError; sent.push(message); },
    runMaintenance(fn) { return fn(); },
    cancel() { cancelled++; },
    async whenIdle() {},
  };
  const ctx = {
    effect(fn) { fn(); },
    webServer: { register(route) { handler = route.handler; return () => {}; } },
    sessions: { get() { return undefined; } },
    agents: { get(id) { return id === 'session-test' ? agent : undefined; } },
    sessionQuery: { async observeSession(id) { if (id !== 'session-test') throw new Error('missing'); return session; } },
    get() { return undefined; },
    llm: {
      listProviders() { return [{ id: 'p' }]; },
      async listModels() { return [{ id: 'm' }]; },
      async *stream(request) { requests.push(request); yield { type: 'text-delta', text: 'translated' }; },
    },
  };
  apply(ctx);
  async function post(body, raw) {
    const text = raw ?? JSON.stringify({ sessionId: 'session-test', ...body });
    const request = { method: 'POST', url: '/message-toolbar', on(name, listener) {
      if (name === 'data') listener(Buffer.from(text));
      if (name === 'end') listener();
      return this;
    } };
    const response = { status: 0, body: '', headersSent: false, writableEnded: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      write(value) { this.body += value; },
      end(value) { this.body += value ?? ''; this.writableEnded = true; },
    };
    await handler(request, response);
    return { status: response.status, payload: JSON.parse(response.body) };
  }
  return { post, handle: handler, events, ctx, agent, session, dispatch, sent, selected, requests, cancelled: () => cancelled };
}

function appendReplayTurn(h, turn, messageId, reason = { kind: 'completed' }) {
  h.session.append('turn/start', { turn });
  h.session.append('user/message', { id: messageId, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'replayed question' }] });
  h.session.append('turn/end', { turn, reason });
}

const eventTurnSettled = () => new Promise((resolve) => setImmediate(resolve));

test('answer-run honors group=false after the original answer was removed', async () => {
  reset();
  const h = harness();
  const result = await h.post({ action: 'answer-run', turn: 1, group: false });
  assert.equal(result.status, 200);
  assert.deepEqual(result.payload.runs, {});
});

test('regenerating a replay uses the edited original question and its attachments', async () => {
  reset(); store.recordRun('session-test', 1, 2);
  const file = { type: 'file', attachment: { attachmentId: 'edited-file' } };
  store.setPromptOverride('session-test', 1, 'edited original', [file]);
  const h = harness();
  const result = await h.post({ action: 'answer-run', turn: 2 });
  assert.equal(result.status, 200);
  assert.deepEqual(h.sent[0].content, [{ type: 'text', text: 'edited original' }, file]);
});

test('invalid models are rejected before cancellation or followup side effects', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'answer-run', turn: 1, model: {}, stopPrevious: true });
  assert.equal(result.status, 400);
  assert.equal(h.cancelled(), 0);
  assert.equal(h.sent.length, 0);
});

test('nonexistent replay targets are rejected before cancelling the running agent', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'answer-run', turn: 999, stopPrevious: true });
  assert.equal(result.status, 400);
  assert.equal(h.cancelled(), 0);
  assert.equal(h.sent.length, 0);
});

test('model switching uses the modern public agent.model.select API', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'answer-run', turn: 1, model: { provider: 'p', model: 'other' } });
  assert.equal(result.status, 200);
  assert.deepEqual(h.selected, [{ provider: 'p', model: 'other' }]);
});

test('a model-switch replay restores the previous selection after its matching turn ends', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'answer-run', turn: 1, model: { provider: 'p', model: 'other' } });
  assert.equal(result.status, 200);
  assert.deepEqual(h.selected, [{ provider: 'p', model: 'other' }]);
  appendReplayTurn(h, result.payload.turn, h.sent[0].id);
  await eventTurnSettled();
  assert.deepEqual(h.selected, [
    { provider: 'p', model: 'other' },
    { provider: 'p', model: 'original', reasoningEffort: 'medium' },
  ]);
});

test('a model-switch replay waits for its own message when another prompt opens first', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'answer-run', turn: 1, model: { provider: 'p', model: 'other' } });
  h.session.append('turn/start', { turn: result.payload.turn });
  h.session.append('user/message', { id: 'unrelated-user-message', role: 'user', source: { kind: 'user' }, content: [] });
  h.session.append('turn/end', { turn: result.payload.turn, reason: { kind: 'completed' } });
  await eventTurnSettled();
  assert.equal(h.selected.length, 1);
  const replayTurn = result.payload.turn + 1;
  appendReplayTurn(h, replayTurn, h.sent[0].id);
  await eventTurnSettled();
  assert.deepEqual(h.selected.at(-1), { provider: 'p', model: 'original', reasoningEffort: 'medium' });
});

for (const reason of [{ kind: 'error' }, { kind: 'aborted', reason: { kind: 'user' } }]) {
  test(`a model-switch replay restores the previous selection after ${reason.kind}`, async () => {
    reset(); const h = harness();
    const result = await h.post({ action: 'answer-run', turn: 1, model: { provider: 'p', model: 'other' } });
    appendReplayTurn(h, result.payload.turn, h.sent[0].id, reason);
    await eventTurnSettled();
    assert.deepEqual(h.selected.at(-1), { provider: 'p', model: 'original', reasoningEffort: 'medium' });
  });
}

test('model restoration leaves a newer user selection untouched', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'answer-run', turn: 1, model: { provider: 'p', model: 'other' } });
  h.agent.model.select({ provider: 'p', model: 'chosen-later' });
  appendReplayTurn(h, result.payload.turn, h.sent[0].id);
  await eventTurnSettled();
  assert.deepEqual(h.selected, [
    { provider: 'p', model: 'other' },
    { provider: 'p', model: 'chosen-later' },
  ]);
});

test('a replay queue failure restores the prior model and removes its watcher', async () => {
  reset(); const h = harness(history(), { followupError: new Error('queue unavailable') });
  const result = await h.post({ action: 'answer-run', turn: 1, model: { provider: 'p', model: 'other' } });
  assert.equal(result.status, 409);
  await eventTurnSettled();
  assert.deepEqual(h.selected, [
    { provider: 'p', model: 'other' },
    { provider: 'p', model: 'original', reasoningEffort: 'medium' },
  ]);
  const foreignSession = { header: { id: 'another-session' } };
  h.dispatch(foreignSession, { type: 'turn/start', data: { turn: 3 } });
  h.dispatch(foreignSession, { type: 'user/message', data: { id: 'not-a-replay', source: { kind: 'user' } } });
  h.dispatch(foreignSession, { type: 'turn/end', data: { turn: 3 } });
  await eventTurnSettled();
  assert.equal(h.selected.length, 2);
});

test('two replay requests cannot reserve the same future turn', async () => {
  reset(); const h = harness();
  const results = await Promise.all([
    h.post({ action: 'answer-run', turn: 1 }), h.post({ action: 'answer-run', turn: 1 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(h.sent.length, 1);
});

test('a queued replay remains reserved until its actual turn is visible', async () => {
  reset(); const h = harness();
  assert.equal((await h.post({ action: 'answer-run', turn: 1 })).status, 200);
  assert.equal((await h.post({ action: 'answer-run', turn: 1 })).status, 409);
  assert.equal(h.sent.length, 1);
});

test('deleting a nonexistent run does not leave phantom hidden flags', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'run-delete', turn: 999 });
  assert.equal(result.status, 400);
  assert.deepEqual(store.hiddenForSession('session-test').answers, []);
});

for (const singleton of [false, true]) {
  test('deleting a question hides all its replayed answers' + (singleton ? ' after the group became a singleton' : ''), async () => {
    reset(); const h = harness(history(3));
    store.recordRun('session-test', 1, 2);
    store.recordRun('session-test', 1, 3);
    if (singleton) {
      await h.post({ action: 'run-delete', turn: 1 });
      await h.post({ action: 'run-delete', turn: 2 });
      assert.deepEqual(store.runsForSession('session-test'), {});
    }
    const result = await h.post({ action: 'hide', turn: 1, scope: 'turn' });
    assert.equal(result.status, 200);
    assert.deepEqual(result.payload.hidden.turns, [1, 2, 3]);
    assert.deepEqual(result.payload.runs, {});
  });
}

test('deleting a real answer cancels its pending translation', async () => {
  reset(); const h = harness();
  store.recordRun('session-test', 1, 2);
  const token = store.beginTranslation('session-test', 2);
  const result = await h.post({ action: 'run-delete', turn: 2 });
  assert.equal(result.status, 200);
  assert.equal(store.currentTranslation('session-test', 2, token), false);
});

test('reserved session object keys cannot corrupt shared dictionaries', async () => {
  reset(); const h = harness();
  const result = await h.post({ action: 'prompt-save', sessionId: '__proto__', turn: 1, text: 'x' });
  const polluted = Object.prototype['1'];
  delete Object.prototype['1'];
  assert.equal(result.status, 400);
  assert.equal(polluted, undefined);
});

test('all inherited session dictionary keys are rejected before state mutation', async () => {
  for (const sessionId of ['toString', 'valueOf', 'hasOwnProperty', '__defineGetter__']) {
    reset(); const h = harness();
    const result = await h.post({ action: 'prompt-save', sessionId, turn: 1, text: 'x' });
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

test('translation cache cannot reuse the previous answer under the same turn key', async () => {
  reset(); const h = harness();
  await h.post({ action: 'translate', turn: 1, text: 'old answer', lang: 'zh' });
  const result = await h.post({ action: 'translate', turn: 1, text: 'changed answer', lang: 'zh' });
  assert.equal(result.status, 200);
  assert.equal(result.payload.cached, false);
  assert.equal(result.payload.origin, 'changed answer');
  assert.equal(h.requests.length, 2);
});

test('answer generation rejects a failed stream even after receiving partial text', async () => {
  reset(); const h = harness();
  h.ctx.llm.stream = async function* () { yield { type: 'text-delta', text: 'partial' }; throw new Error('connection lost'); };
  const result = await h.post({ action: 'answer-generate', turn: 1 });
  assert.equal(result.status, 409);
  assert.equal(store.answerEntry('session-test', 1), undefined);
});

test('successful mutation acknowledgement already has durable state on disk', async () => {
  reset(); const h = harness();
  assert.equal((await h.post({ action: 'prompt-save', turn: 1, text: 'durable' })).status, 200);
  assert.equal(fs.existsSync(stateFile), true);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).prompts['session-test']['1'].text, 'durable');
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
  await h.post({ action: 'answer-save', turn: 1, text: 'changed answer' });
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
  const result = await h.post({ action: 'answer-generate', turn: 1 });
  assert.equal(result.status, 200);
  assert.equal(h.requests[0].model, 'current');
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
