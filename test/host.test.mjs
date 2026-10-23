
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
const { flushState, reloadState } = await import('../lib/state-store.js');

/**
 * The plugin keeps one durable state file, so answer-variant tests would
 * otherwise see each other's variants. Flush the pending write, delete the
 * file, and drop the in-memory cache.
 */
function resetPluginState() {
  flushState();
  fs.rmSync(path.join(TMP, '.dsh', 'message-toolbar', 'state.json'), { force: true });
  reloadState();
}

/* ------------------------------------------------------------- fixtures -- */

function textMessage(id, role, text) {
  // An assistant message always carries a model source; a replay needs it, and
  // the log has it, so the fixture does too.
  const source = role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'p', model: 'm' };
  return { id, role, content: [{ type: 'text', text }], source };
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
    ['A', liveSession('A', undefined, options.rootEvents ?? rootEvents(), 0)],
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
      // In-place answering replays the prompt on the session's own agent, so the
      // live agent has to accept a follow-up just like a freshly created one.
      followup: (message) => { followups.push(message); },
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
      stream: async function* (call) {
        services.lastStream = call;
        if (options.echoTranslate === true) {
          // Hand the masked text straight back, the way a translator that respects
          // placeholders would — so whatever comes out is what the round trip
          // restored, and the request itself can be inspected.
          const prompt = call.messages[0].content[0].text;
          const masked = prompt.slice(prompt.indexOf('<<<TEXT\n') + 8, prompt.lastIndexOf('\nTEXT>>>'));
          yield { type: 'text-delta', index: 0, text: masked };
          yield { type: 'finish', reason: 'stop' };
          return;
        }
        yield { type: 'block-start', index: 0, blockType: 'reasoning' };
        yield { type: 'reasoning-delta', index: 0, text: 'THINK' };
        yield { type: 'block-start', index: 1, blockType: 'text' };
        yield { type: 'text-delta', index: 1, text: 'TRANS' };
        yield { type: 'text-delta', index: 1, text: 'LATED' };
        // options here is makeContext's fixture knobs, not the call's arguments.
        yield { type: 'finish', reason: options.finishReason || 'stop' };
      },
    },
  };
  const ctx = Object.assign({}, services, {
    get: (name) => services[name],
    effect: (fn) => { const dispose = fn(); return dispose; },
  });
  return { ctx, services, created, followups };
}

async function callRaw(handler, method, body, search) {
  const chunks = [];
  let ended = false;
  const res = {
    statusCode: 0,
    headers: {},
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    flushHeaders() {},
    write(text) { chunks.push(text); },
    end(text) { if (text !== undefined) chunks.push(text); ended = true; },
    get writableEnded() { return ended; },
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
  const text = chunks.join('');
  const frames = text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  return { status: res.statusCode, text, frames };
}

async function call(handler, method, body, search) {
  const result = await callRaw(handler, method, body, search);
  return { status: result.status, json: JSON.parse(result.text || 'null') };
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

// A turn that ended without a durable answer has no native action row, so the
// client needs to know which turns those are: `answered: false` is what draws
// the fallback toolbar (retry / model switch / delete) for a failed answer.
test('GET reports per-turn answered and end reason', async () => {
  const events = rootEvents();
  events.push({ type: 'turn/start', seq: 10, time: 1010, data: { turn: 3 } });
  events.push({ type: 'user/message', seq: 11, time: 1011, data: textMessage('u3', 'user', 'third question') });
  events.push({ type: 'turn/end', seq: 12, time: 1012, data: { turn: 3, reason: { kind: 'error' } } });
  events.push({ type: 'turn/start', seq: 13, time: 1013, data: { turn: 4 } });
  events.push({ type: 'user/message', seq: 14, time: 1014, data: textMessage('u4', 'user', 'fourth question') });

  const { ctx, services } = makeContext({ rootEvents: events });
  apply(ctx);

  const { status, json } = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(status, 200);
  const byTurn = new Map(json.turns.map((t) => [t.turn, t]));
  assert.equal(byTurn.get(1).answered, true, 'a turn with a durable answer says so');
  assert.equal(byTurn.get(3).answered, false, 'a failed turn has no answer');
  assert.equal(byTurn.get(3).reason, 'error', 'the end reason reaches the client');
  assert.equal(byTurn.get(4).open, true, 'a turn that never ended is open');
  assert.equal(byTurn.get(4).answered, false);
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

// A closed turn cannot take a second answer, so "answer this again" replays the
// prompt as a fresh turn in the same session and reports which turn it opened, so
// the client can hide the replayed prompt and stream DSH's own live page under it.
test('POST answer-run replays the prompt as a new turn of the same session', async () => {
  const { ctx, services, created, followups } = makeContext();
  apply(ctx);

  const { status, json } = await call(services.handler, 'POST', {
    action: 'answer-run', sessionId: 'A', turn: 2, stopPrevious: false,
  });
  assert.equal(status, 200);
  // No child session: the answer has to land in this transcript.
  assert.equal(created.length, 0);
  assert.equal(json.sessionId, 'A');
  assert.equal(json.inPlace, true);
  assert.equal(json.replayedFrom, 2);
  assert.equal(json.turn, 3);
  assert.equal(followups.length, 1);
  assert.equal(followups[0].role, 'user');
  assert.equal(followups[0].content[0].text, 'second question');
});

// A long answer needs a long translation. When the model still runs out of room,
// the payload says so instead of passing half a page off as the whole thing.
test('POST translate reports a translation the model could not finish', async () => {
  const { ctx, services } = makeContext({ finishReason: 'length' });
  apply(ctx);
  resetPluginState();

  const { status, json } = await call(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', eventSeq: 8, lang: 'ja',
  });
  assert.equal(status, 200);
  assert.equal(json.truncated, true);
  assert.equal(json.text, 'TRANSLATED');
  // A translation is exactly as long as the text it translates: we cap nothing and
  // let the provider's own window be the only limit.
  assert.equal(services.lastStream.maxTokens, undefined);
  const tree = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(tree.json.translations['8'].ja.truncated, true);
  resetPluginState();
});

// Code and formulas are lifted out of the request and put back afterwards: the
// only way to keep `console.log` and \frac{a}{b} byte-identical is to never hand
// them to the model.
test('POST translate keeps code and formulas out of the model hands', async () => {
  const { ctx, services } = makeContext({ echoTranslate: true });
  apply(ctx);
  resetPluginState();

  const text = [
    'Run `npm run build` before anything else.',
    '',
    '```js',
    'const x = console.log(1);',
    '```',
    '',
    'The identity $$\\sum_i x_i$$ holds, and \\(\\frac{a}{b}\\) too.',
    '',
    'It costs $5 and $10, which is prose rather than math.',
  ].join('\n');
  const { status, json } = await call(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', turn: 2, lang: 'zh', text,
  });
  assert.equal(status, 200);
  // What the reader gets back is the source, untouched, plus whatever the model
  // wrote around the placeholders.
  assert.equal(json.text, text);

  const prompt = services.lastStream.messages[0].content[0].text;
  assert.doesNotMatch(prompt, /console\.log/);
  assert.doesNotMatch(prompt, /sum_i x_i/);
  assert.doesNotMatch(prompt, /frac\{a\}\{b\}/);
  assert.match(prompt, /⟦1⟧/);
  // Money is prose, not math: `$5 and $10` has to reach the model untouched.
  assert.match(prompt, /\$5 and \$10/);
  resetPluginState();
});
// A mixed answer is common: half of it already in the language the reader picked.
// Sending that half to a translator buys a second copy of it, so it is lifted out
// along with the code.
test('POST translate leaves text already in the target language alone', async () => {
  const { ctx, services } = makeContext({ echoTranslate: true });
  apply(ctx);
  resetPluginState();

  const text = [
    '这段话已经是我要的简体中文，不用再翻译。',
    '',
    'This paragraph is English and has to be translated.',
  ].join('\n');
  const { status, json } = await call(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', turn: 2, lang: 'zh', text,
  });
  assert.equal(status, 200);
  assert.equal(json.text, text);

  const prompt = services.lastStream.messages[0].content[0].text;
  assert.doesNotMatch(prompt, /这段话已经是我要的简体中文/);
  assert.match(prompt, /This paragraph is English/);
  assert.match(prompt, /⟦1⟧/);

  // For a Latin-script target the script cannot tell the languages apart, so
  // nothing is lifted on a guess.
  const en = await call(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', turn: 3, lang: 'en', text, force: true,
  });
  assert.equal(en.status, 200);
  assert.match(services.lastStream.messages[0].content[0].text, /这段话已经是我要的简体中文/);
  resetPluginState();
});
// The translation arrives the way an answer does — one frame per token batch — so
// the card can draw it as it is written instead of after the round trip.
test('POST translate streams the translation frame by frame', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  resetPluginState();

  const { status, json, frames } = await callRaw(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', eventSeq: 8, lang: 'ja', stream: true,
  });
  assert.equal(status, 200);
  assert.deepEqual(frames.map((frame) => frame.type), ['start', 'delta', 'delta', 'done']);
  assert.equal(frames[1].text, 'TRANS');
  assert.equal(frames[3].payload.text, 'TRANSLATED');
  // The finished stream leaves the same state a plain POST would, so a reload
  // does not have to re-bill the translation.
  const tree = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(tree.json.translations['8'].ja.text, 'TRANSLATED');
  assert.equal(json, undefined);
  resetPluginState();
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
  // Choosing a language is also choosing what the turn shows: the translation
  // replaces the answer in place, so the payload names the language on screen.
  assert.equal(tree.json.shown['2'], 'zh');
});

test('a translation travels with the text on screen and can be turned off', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  resetPluginState();

  // A variant is not in the log, so the client hands over the text it shows.
  const byText = await call(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', turn: 2, lang: 'en', text: 'a variant answer',
  });
  assert.equal(byText.status, 200);
  assert.equal(byText.json.lang, 'en');
  assert.equal(byText.json.seq, 'turn:2');
  assert.equal(byText.json.shown, 'en');
  assert.ok(services.lastStream.messages[0].content[0].text.includes('a variant answer'));

  const shown = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(shown.json.shown['2'], 'en');
  assert.equal(shown.json.translations['turn:2'].en.text, 'TRANSLATED');
  // The reader sees both languages, so the payload carries the side that is on
  // screen: a translation never replaces it. Here that side is the text the
  // client handed over, because a variant lives outside the log.
  assert.equal(shown.json.origins['2'], 'a variant answer');

  const off = await call(services.handler, 'POST', { action: 'translate-off', sessionId: 'A', turn: 2 });
  assert.equal(off.status, 200);
  assert.equal(off.json.shown, null);

  const after = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.deepEqual(after.json.shown, {});
  // The translation stays cached — turning it off is a view decision.
  assert.equal(after.json.translations['turn:2'].en.text, 'TRANSLATED');
});

test('changing the answer forgets the translation of the old one', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  resetPluginState();

  await call(services.handler, 'POST', {
    action: 'translate', sessionId: 'A', turn: 2, lang: 'en', text: 'the first answer',
  });
  const shown = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(shown.json.shown['2'], 'en');
  assert.equal(shown.json.translations['turn:2'].en.text, 'TRANSLATED');

  // Another answer for the same turn means the translation no longer matches
  // what is on screen, so both the flag and the cached text have to go.
  const generated = await call(services.handler, 'POST', {
    action: 'answer-generate', sessionId: 'A', turn: 2,
  });
  assert.equal(generated.status, 200);

  const after = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.deepEqual(after.json.shown, {});
  assert.equal(after.json.translations['turn:2'], undefined);
});

test('POST answer-generate keeps the answer in-session and builds a plain transcript', async () => {
  const { ctx, services, created } = makeContext();
  apply(ctx);
  resetPluginState();

  const { status, json } = await call(services.handler, 'POST', {
    action: 'answer-generate', sessionId: 'A', turn: 2,
    model: { provider: 'q', model: 'm2', name: 'Model M2' },
  });
  assert.equal(status, 200);
  assert.equal(json.turn, 2);
  assert.equal(json.items.length, 1);
  assert.equal(json.active, json.items[0].id);
  assert.equal(json.items[0].kind, 'model');
  assert.equal(json.items[0].provider, 'q');
  assert.equal(json.items[0].model, 'm2');
  assert.equal(json.items[0].text, 'TRANSLATED');
  // No branch was created: the whole point of the variant model.
  assert.equal(created.length, 0);
  // The transcript is plain chat: earlier turns plus this turn's question.
  assert.deepEqual(services.lastStream.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(services.lastStream.messages[2].content[0].text, 'second question');
  assert.equal(services.lastStream.system, undefined);
  // A replayed answer must be a real message, not a bare role plus text: the
  // adapters drop entries without `id`/`source`, and a request whose messages
  // were dropped finishes with no content at all ("the model returned nothing").
  const replay = services.lastStream.messages[1];
  assert.equal(typeof replay.id, 'string');
  assert.ok(replay.id.length > 0);
  assert.equal(replay.source.kind, 'model');
  assert.equal(replay.source.provider, 'p');
  assert.equal(replay.source.model, 'm');

  const tree = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.equal(tree.json.answers['2'].active, json.active);
  assert.equal(tree.json.answers['2'].items[0].text, 'TRANSLATED');
});

test('POST answer-generate stream=true writes start, delta and done frames', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  resetPluginState();

  const { status, text } = await callRaw(services.handler, 'POST', {
    action: 'answer-generate', sessionId: 'A', turn: 2, stream: true,
    model: { provider: 'q', model: 'm2', name: 'Model M2' },
  });
  assert.equal(status, 200);
  const frames = text.split('\n').filter((line) => line.trim().length > 0).map((line) => JSON.parse(line));
  assert.deepEqual(frames.map((f) => f.type), ['start', 'reasoning', 'delta', 'delta', 'done']);
  assert.equal(frames[0].turn, 2);
  assert.equal(frames[0].provider, 'q');
  assert.equal(frames[0].model, 'm2');
  // A thinking model narrates first: that narration is a frame of its own, so the
  // client can show the run's process above the answer.
  assert.equal(frames[1].text, 'THINK');
  // One frame per token batch, so the client can paint as it arrives.
  assert.equal(frames[2].text, 'TRANS');
  assert.equal(frames[3].text, 'LATED');
  assert.equal(frames[2].text + frames[3].text, 'TRANSLATED');
  const done = frames[4].payload;
  assert.equal(done.items.length, 1);
  assert.equal(done.items[0].text, 'TRANSLATED');
  assert.equal(done.items[0].reasoning, 'THINK');
  assert.equal(done.active, done.items[0].id);
});

// Editing overwrites what is on screen: a visible variant is rewritten in place,
// and the logged answer (which no API can rewrite) takes an override. Either way
// the ring does not grow — saving an edit is not a new answer.
test('POST answer-save overwrites the visible alternative instead of adding one', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  resetPluginState();

  const generated = await call(services.handler, 'POST', {
    action: 'answer-generate', sessionId: 'A', turn: 1,
  });
  assert.equal(generated.status, 200);
  const variantId = generated.json.items[0].id;

  const saved = await call(services.handler, 'POST', {
    action: 'answer-save', sessionId: 'A', turn: 1, text: 'my own rewrite',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.items.length, 1, 'the edit replaces the variant, it does not add one');
  assert.equal(saved.json.items[0].id, variantId, 'the same alternative keeps its identity');
  assert.equal(saved.json.items[0].text, 'my own rewrite');
  assert.equal(saved.json.items[0].edited, true);
  assert.equal(saved.json.active, variantId);

  const native = await call(services.handler, 'POST', {
    action: 'answer-select', sessionId: 'A', turn: 1, id: 'native',
  });
  assert.equal(native.status, 200);
  assert.equal(native.json.active, 'native');
  assert.equal(native.json.items.length, 1);

  const removed = await call(services.handler, 'POST', {
    action: 'answer-delete', sessionId: 'A', turn: 1, id: variantId,
  });
  assert.equal(removed.json.active, 'native');
  assert.equal(removed.json.items.length, 0);
});

test('editing the logged answer stores an override the reader can undo', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  resetPluginState();

  const saved = await call(services.handler, 'POST', {
    action: 'answer-save', sessionId: 'A', turn: 2, text: 'rewritten by hand',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.active, 'native', 'still one answer: no alternative was added');
  assert.equal(saved.json.items.length, 0);
  assert.equal(saved.json.override.text, 'rewritten by hand');

  const source = await call(services.handler, 'POST', {
    action: 'answer-source', sessionId: 'A', turn: 2,
  });
  assert.equal(source.json.text, 'rewritten by hand', 'the editor reopens on the override');
  assert.equal(source.json.native, 'second answer', 'the log still holds the model text');

  const restored = await call(services.handler, 'POST', {
    action: 'answer-restore', sessionId: 'A', turn: 2,
  });
  assert.equal(restored.status, 200);
  assert.equal(restored.json.override, null);
  const after = await call(services.handler, 'POST', {
    action: 'answer-source', sessionId: 'A', turn: 2,
  });
  assert.equal(after.json.text, 'second answer');
});

test('POST answer-source hands the editor the visible text and the logged text', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  resetPluginState();

  const plain = await call(services.handler, 'POST', {
    action: 'answer-source', sessionId: 'A', turn: 2,
  });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.active, 'native');
  assert.equal(plain.json.text, 'second answer');
  assert.equal(plain.json.native, 'second answer');

  await call(services.handler, 'POST', { action: 'answer-generate', sessionId: 'A', turn: 2 });
  const variant = await call(services.handler, 'POST', {
    action: 'answer-source', sessionId: 'A', turn: 2,
  });
  assert.equal(variant.json.text, 'TRANSLATED');
  assert.equal(variant.json.native, 'second answer');
  assert.equal(variant.json.source, 'model');
});

test('answer-generate rejects a turn that does not exist', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);

  const { status, json } = await call(services.handler, 'POST', {
    action: 'answer-generate', sessionId: 'A', turn: 9,
  });
  assert.equal(status, 400);
  assert.match(json.error, /9/);
});

test('POST hide removes a turn or an answer from the view and restores it', async () => {
  const { ctx, services } = makeContext();
  apply(ctx);
  resetPluginState();

  const hiddenTurn = await call(services.handler, 'POST', {
    action: 'hide', sessionId: 'A', turn: 1, scope: 'turn', hidden: true,
  });
  assert.equal(hiddenTurn.status, 200);
  assert.deepEqual(hiddenTurn.json.hidden, { turns: [1], answers: [], prompts: [] });

  const payload = await call(services.handler, 'GET', undefined, '?sessionId=A');
  assert.deepEqual(payload.json.hidden, { turns: [1], answers: [], prompts: [] });

  const hiddenAnswer = await call(services.handler, 'POST', {
    action: 'hide', sessionId: 'A', turn: 2, scope: 'answer', hidden: true,
  });
  assert.deepEqual(hiddenAnswer.json.hidden, { turns: [1], answers: [2], prompts: [] });

  const restored = await call(services.handler, 'POST', {
    action: 'hide', sessionId: 'A', turn: 2, scope: 'answer', hidden: false,
  });
  assert.deepEqual(restored.json.hidden, { turns: [1], answers: [], prompts: [] });

  const badScope = await call(services.handler, 'POST', {
    action: 'hide', sessionId: 'A', turn: 1, scope: 'everything', hidden: true,
  });
  assert.equal(badScope.status, 400);
  assert.match(badScope.json.error, /scope/);

  const missingTurn = await call(services.handler, 'POST', {
    action: 'hide', sessionId: 'A', turn: 9, scope: 'turn', hidden: true,
  });
  assert.equal(missingTurn.status, 400);
  assert.match(missingTurn.json.error, /9/);
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
