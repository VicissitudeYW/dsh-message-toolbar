
// Host integration test: drives the real HTTP handler of lib/index.js against
// synthetic session logs, with a fake Cordis context.

import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Isolate the plugin state file before importing the host module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'mtt-test-'));
process.env.USERPROFILE = TMP;
process.env.HOME = TMP;

const { apply } = await import('../lib/index.js');

/* ------------------------------------------------------------- fixtures -- */

function textMessage(id, role, text) {
  return { id, role, content: [{ type: 'text', text }], source: role === 'user' ? { kind: 'user' } : undefined };
}

function rootEvents() {
  return [
    { type: 'turn/start', seq: 0, time: 1000, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 1001, data: textMessage('u1', 'user', 'first question') },
    { type: 'request/header', seq: 2, time: 1002, data: { header: { config: { provider: 'p', model: 'm' } } } },
    { type: 'assistant/message', seq: 3, time: 1003, data: { turn: 1, step: 1, message: textMessage('a1', 'assistant', 'first answer'), stream: [] } },
    { type: 'turn/end', seq: 4, time: 1004, data: { turn: 1, reason: 'stop' } },
    { type: 'turn/start', seq: 5, time: 1005, data: { turn: 2 } },
    { type: 'user/message', seq: 6, time: 1006, data: textMessage('u2', 'user', 'second question') },
    { type: 'request/header', seq: 7, time: 1007, data: { header: { config: { provider: 'p', model: 'm' } } } },
    { type: 'assistant/message', seq: 8, time: 1008, data: { turn: 2, step: 1, message: textMessage('a2', 'assistant', 'second answer'), stream: [] } },
    { type: 'turn/end', seq: 9, time: 1009, data: { turn: 2, reason: 'stop' } },
  ];
}

function versionedEvents(markerType = 'message-toolbar/version') {
  const events = rootEvents().slice(0, 5);
  events.push({
    type: markerType,
    seq: 5,
    time: 2000,
    data: {
      schemaVersion: 1,
      effect: { operation: 'retry', targetTurn: 2, targetEventSeq: 6, before: 'second question', id: 'v1' },
      inverse: { kind: 'restore-version', sessionId: 'A' },
      sessionId: 'B',
    },
    ignorable: true,
  });
  events.push({ type: 'turn/start', seq: 6, time: 2001, data: { turn: 2 } });
  events.push({ type: 'user/message', seq: 7, time: 2002, data: textMessage('u2b', 'user', 'second question') });
  events.push({ type: 'request/header', seq: 8, time: 2003, data: { header: { config: { provider: 'q', model: 'm2' } } } });
  events.push({ type: 'assistant/message', seq: 9, time: 2004, data: { turn: 2, step: 1, message: textMessage('a2b', 'assistant', 'second answer by q'), stream: [] } });
  events.push({ type: 'turn/end', seq: 10, time: 2005, data: { turn: 2, reason: 'stop' } });
  return events;
}

function liveSession(id, parentSession, events, inheritedEventCount) {
  return {
    header: { id, parentSession, cwd: '/w', createdAt: 1000 },
    inheritedEventCount,
    events,
    seq: events.length,
    snapshotEvents() { return this.events; },
  };
}

function makeContext(options = {}) {
  const created = [];
  const followups = [];
  const sessions = new Map([
    ['A', liveSession('A', undefined, rootEvents(), 0)],
    ['B', liveSession('B', 'A', versionedEvents(options.markerType), 5)],
  ]);
  const registry = {
    archivedSessionIds: [],
    list: () => [],
    archiveSession: async (id) => { registry.archivedSessionIds.push(id); },
    unarchiveSession: async (id) => { registry.archivedSessionIds = registry.archivedSessionIds.filter((x) => x !== id); },
  };
  const agents = {
    get: (id) => sessions.has(id) ? {
      session: sessions.get(id),
      runMaintenance: async (fn) => fn(agents.get(id)),
      cancel: () => {},
      whenIdle: async () => {},
    } : undefined,
    create: async (options) => {
      created.push(options);
      const agent = {
        session: { id: options.sessionId },
        inbox: { clear: () => {} },
        followup: (message) => { followups.push(message); },
      };
      return { agent, dispose: async () => {} };
    },
    resume: async () => { throw new Error('resume should not be needed'); },
  };
  const services = {
    sessions: {
      get: (id) => sessions.get(id),
      flush: async () => {},
    },
    agents,
    sessionQuery: {
      listSessions: async () => [...sessions.values()].map((s) => ({ header: s.header })),
      readSession: async (id) => sessions.get(id),
    },
    webServer: {
      register(spec) { services.handler = spec.handler; return { dispose() {} }; },
    },
    workspaceRegistry: registry,
    llm: {
      listProviders: () => [{ id: 'p', name: 'Provider P' }, { id: 'q', name: 'Provider Q' }],
      listModels: (provider) => [{ id: provider === 'q' ? 'm2' : 'm', name: provider === 'q' ? 'Model M2' : 'Model M' }],
      stream: async function* (options) {
        services.lastStream = options;
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'text-delta', index: 0, text: 'TRANSLATED' };
        yield { type: 'finish', reason: 'stop' };
      },
    },
  };
  const ctx = Object.assign({}, services, {
    get: (name) => services[name],
    effect: (fn) => { const dispose = fn(); return dispose; },
  });
  return { ctx, services, created, followups };
}

async function call(handler, method, body, search) {
  const chunks = [];
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(text) { chunks.push(text); },
  };
  const req = {
    method,
    url: '/message-toolbar' + (search || ''),
    on(event, fn) {
      if (event === 'data' && body !== undefined) fn(JSON.stringify(body));
      if (event === 'end') fn();
    },
  };
  await handler(req, res);
  return { status: res.statusCode, json: JSON.parse(chunks.join('') || 'null') };
}

/* ---------------------------------------------------------------- tests -- */

test('GET projects the version family and the message index', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);

  const { status, json } = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(status, 200);
  assert.equal(json.sessionId, 'A');
  assert.equal(json.versions.length, 2);
  const b = json.versions.find((v) => v.sessionId === 'B');
  assert.equal(b.parentSessionId, 'A');
  assert.equal(b.operation, 'retry');
  assert.equal(b.targetTurn, 2);
  assert.equal(b.current, false);
  assert.equal(json.messages.length, 4);
  assert.deepEqual(json.messages.map((m) => m.id), ['u1', 'a1', 'u2', 'a2']);
  assert.equal(json.messages[1].turn, 1);
  assert.equal(json.messages[3].turn, 2);
  assert.deepEqual(json.translations, {});
});

test('POST edit creates a rewound child with a durable marker', async () => {
  const { ctx, services, created, followups } = makeContext();
  apply(ctx);

  const { status, json } = await call(services.handler, 'POST', {
    action: 'edit', sessionId: 'A', eventSeq: 6, blockIndex: 0, text: 'edited second', stopPrevious: false,
  });
  assert.equal(status, 200);
  assert.ok(json.sessionId.startsWith('session-'));

  assert.equal(created.length, 1);
  const options = created[0];
  // boundary = turn 2 start (seq 5) - 1 = 4, plus the marker appended.
  assert.equal(options.seed.length, 6);
  const marker = options.seed[5];
  assert.equal(marker.type, 'message-toolbar/version');
  assert.equal(marker.ignorable, true);
  assert.equal(marker.data.sessionId, json.sessionId);
  assert.equal(marker.data.effect.operation, 'edit');
  assert.equal(marker.data.effect.targetTurn, 2);
  assert.equal(marker.data.effect.after, 'edited second');
  assert.equal(marker.data.inverse.sessionId, 'A');
  assert.equal(options.meta.parentSession, 'A');

  assert.equal(followups.length, 1);
  assert.equal(followups[0].content[0].text, 'edited second');
});

test('POST retry with a model overrides routing and records it on the card', async () => {
  const { ctx, services, created } = makeContext();
  apply(ctx);

  const { status, json } = await call(services.handler, 'POST', {
    action: 'retry', sessionId: 'A', turn: 2, stopPrevious: false,
    model: { provider: 'q', model: 'm2', name: 'Model M2' },
  });
  assert.equal(status, 200);
  assert.equal(json.provider, 'q');
  assert.equal(json.model, 'm2');
  assert.equal(json.turn, 2);

  const options = created[0];
  assert.equal(options.agentOptions.provider, 'q');
  assert.equal(options.agentOptions.model, 'm2');
  const marker = options.seed[options.seed.length - 1];
  assert.deepEqual(marker.data.effect.model, { provider: 'q', model: 'm2', name: 'Model M2' });
});

test('POST translate calls the model once and caches the answer', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);

  const first = await call(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', eventSeq: 8, lang: 'zh',
  });
  assert.equal(first.status, 200);
  assert.equal(first.json.text, 'TRANSLATED');
  assert.equal(first.json.cached, false);
  assert.equal(first.json.turn, 2);
  assert.equal(first.json.role, 'assistant');
  assert.ok(services.lastStream.system.includes('translator'));
  assert.ok(services.lastStream.messages[0].content[0].text.includes('second answer'));

  const second = await call(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', eventSeq: 8, lang: 'zh',
  });
  assert.equal(second.status, 200);
  assert.equal(second.json.cached, true);

  const tree = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(tree.json.translations['8'].zh.text, 'TRANSLATED');
  assert.equal(tree.json.translations['8'].zh.turn, 2);
});

test('DELETE/RESTORE a version card flips its deleted flag', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);

  const removed = await call(services.handler, 'POST', { action: 'delete-version', sessionId: 'B' });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.deleted, true);
  assert.equal(removed.json.parent, 'A');

  const after = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(after.json.versions.find((v) => v.sessionId === 'B').deleted, true);
  assert.ok(after.json.deleted.includes('B'));

  const restored = await call(services.handler, 'POST', { action: 'restore-version', sessionId: 'B' });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.deleted, false);

  const final = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(final.json.versions.find((v) => v.sessionId === 'B').deleted, undefined);
});

test('DELETE refuses the original conversation', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  const result = await call(services.handler, 'POST', { action: 'delete-version', sessionId: 'A' });
  assert.equal(result.status, 400);
  assert.match(result.json.error, /版本卡片/);
});

test('POST focus leaves exactly one family member visible', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  const registry = ctx.workspaceRegistry;
  registry.archivedSessionIds.push('B');

  const result = await call(services.handler, 'POST', { action: 'focus', sessionId: 'B' });
  assert.equal(result.status, 200);
  assert.equal(result.json.active, 'B');
  assert.equal(result.json.unarchived, true);
  assert.deepEqual(result.json.archived, ['A']);
  assert.deepEqual(registry.archivedSessionIds, ['A']);
});

test('POST focus keeps a member whose turn is still running', async () => {
  const { ctx, services } = makeContext();
  const registry = ctx.workspaceRegistry;
  registry.archiveSession = async (id) => {
    const error = new Error('active');
    error.name = 'WorkspaceActiveSessionError';
    throw error;
  };
  apply(ctx);

  const result = await call(services.handler, 'POST', { action: 'focus', sessionId: 'B' });
  assert.equal(result.status, 200);
  assert.deepEqual(result.json.archived, []);
  assert.deepEqual(result.json.skipped, ['A']);
});

test('GET ?models=1 lists providers with their models', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  const { status, json } = await call(services.handler, 'GET', undefined, '?models=1');
  assert.equal(status, 200);
  assert.equal(json.providers.length, 2);
  assert.deepEqual(json.providers[1].models, [{ id: 'm2', name: 'Model M2' }]);
});

test('legacy message-tree/version markers are read as version cards', async () => {
  const { ctx, services } = makeContext({ markerType: 'message-tree/version' });
  apply(ctx);
  const { status, json } = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(status, 200);
  const b = json.versions.find((v) => v.sessionId === 'B');
  assert.equal(b.operation, 'retry');
  assert.equal(b.targetTurn, 2);

  // Deleting a legacy card must also work: the restore-version inverse alone
  // identifies the parent.
  const removed = await call(services.handler, 'POST', { action: 'delete-version', sessionId: 'B' });
  assert.equal(removed.status, 200);
  assert.equal(removed.json.parent, 'A');
});
