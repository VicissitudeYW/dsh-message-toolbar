// Harness for the 1.6.0 host change: a replayed question carries dropped files.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const home = mkdtempSync(path.join(tmpdir(), 'mtt-attach-home-'));
process.env.USERPROFILE = home;
process.env.HOME = home;

const root = new URL('../lib/index.js', import.meta.url).href.replace(/lib\/index\.js$/, '');
const { apply, MESSAGE_TOOLBAR_PATH } = await import(root + 'lib/index.js');
const { flushState, reloadState, promptFiles } = await import(root + 'lib/state-store.js');
const { recordRun, runsForSession, setHidden, reconcileRuns } = await import(root + 'lib/state-store.js');

// Every case starts from an empty plugin state: attachments a reader dropped are
// remembered across replays, which is exactly what makes one case leak into the
// next one otherwise.
const STATE_FILE = path.join(home, '.dsh', 'message-toolbar', 'state.json');
function resetState() {
  try { flushState(); } catch (e) {}
  rmSync(STATE_FILE, { force: true });
  reloadState();
}

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log('ok   ' + label); return; }
  failures += 1;
  console.log('FAIL ' + label + '\n  actual:   ' + a + '\n  expected: ' + e);
}

function userMessage(id, text, extra) {
  return { id, role: 'user', content: [{ type: 'text', text }, ...(extra || [])], source: { kind: 'user' } };
}

function assistantMessage(id) {
  return { id, role: 'assistant', content: [{ type: 'text', text: 'answer' }], source: { kind: 'model', provider: 'p', model: 'm' } };
}

function log(question, extra) {
  return [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', data: userMessage('u1', 'first', undefined) },
    { seq: 2, type: 'assistant/message', data: { turn: 1, step: 1, message: assistantMessage('a1'), stream: [] } },
    { seq: 3, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 4, type: 'turn/start', data: { turn: 2 } },
    { seq: 5, type: 'user/message', data: userMessage('u2', question, extra) },
    { seq: 6, type: 'assistant/message', data: { turn: 2, step: 1, message: assistantMessage('a2'), stream: [] } },
    { seq: 7, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
}

let queued = [];
function makeContext(events) {
  const routes = new Map();
  const agent = {
    session: { header: { id: 'session-attach-1', cwd: 'D:/work' }, events },
    followup(message) { queued.push(message); },
    runMaintenance(fn) { return fn(); },
    cancel() { return true; },
    whenIdle() { return Promise.resolve(); },
  };
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
    agents: { get: (id) => (id === 'session-attach-1' ? agent : undefined) },
    sessions: { get: () => undefined },
    // `hide` checks that the turn exists before it records the flag, so the
    // harness has to answer with the same log the agent holds.
    sessionQuery: {
      async observeSession(id) {
        if (id !== 'session-attach-1') throw new Error('unknown session');
        return { header: { id, cwd: 'D:/work' }, events };
      },
    },
    llm: { listProviders: () => [], listModels: async () => [], stream: async function* () {} },
  };
  apply(ctx);
  return { handler: routes.get(MESSAGE_TOOLBAR_PATH), ctx };
}

function request(body) {
  const chunks = [Buffer.from(JSON.stringify(body), 'utf8')];
  const listeners = {};
  return {
    method: 'POST',
    url: MESSAGE_TOOLBAR_PATH,
    headers: { 'content-type': 'application/json' },
    on(event, fn) { (listeners[event] ||= []).push(fn); if (event === 'data') chunks.forEach((c) => fn(c)); if (event === 'end') fn(); return this; },
  };
}

function response() {
  return {
    status: 0,
    body: '',
    headersSent: false,
    writableEnded: false,
    writeHead(status) { this.status = status; this.headersSent = true; },
    write(text) { this.body += text; return true; },
    flushHeaders() {},
    end(text) { if (text) this.body += text; this.writableEnded = true; },
  };
}

async function run(events, body) {
  resetState();
  queued = [];
  const { handler } = makeContext(events);
  const res = response();
  await handler(request(body), res);
  return { status: res.status, payload: JSON.parse(res.body || '{}'), queued };
}

/** Same, without clearing the plugin state: for "what does the next pass see?". */
async function replay(events, body) {
  queued = [];
  const { handler } = makeContext(events);
  const res = response();
  await handler(request(body), res);
  return { status: res.status, payload: JSON.parse(res.body || '{}'), queued };
}



// 1. a dropped file travels with the replayed question
{
  const file = { type: 'file', attachment: { attachmentId: 'att-1', name: 'spec.pdf', bytes: 1234 } };
  const { status, queued: sent } = await run(log('second'), { action: 'answer-run', sessionId: 'session-attach-1', turn: 2, files: [file] });
  check('status', status, 200);
  check('one message queued', sent.length, 1);
  check('content', sent[0].content, [{ type: 'text', text: 'second' }, file]);
  check('role', sent[0].role, 'user');
  check('fresh id', typeof sent[0].id === 'string' && sent[0].id !== 'u2', true);
  check('source', sent[0].source, { kind: 'user' });
}

// 2. an attachment the question already had survives, before the new one
{
  const existing = { type: 'file', attachment: { attachmentId: 'att-old', name: 'old.txt', bytes: 5 } };
  const dropped = { type: 'image', attachment: { attachmentId: 'att-new', name: 'shot.png', width: 10, height: 10 } };
  const { queued: sent } = await run(log('second', [existing]), { action: 'answer-run', sessionId: 'session-attach-1', turn: 2, files: [dropped] });
  check('keeps the old attachment first', sent[0].content, [{ type: 'text', text: 'second' }, existing, dropped]);
}

// 3. no files at all: the message is replayed exactly as it was
{
  const { queued: sent } = await run(log('second'), { action: 'answer-run', sessionId: 'session-attach-1', turn: 2 });
  check('untouched replay', sent[0].content, [{ type: 'text', text: 'second' }]);
  check('keeps the original id', sent[0].id === 'u2', false);
}

// 4. the attachments are remembered: the row keeps drawing them, and a later
//    replay still carries them even though that pass dropped nothing new.
{
  resetState();
  const file = { type: 'file', attachment: { attachmentId: 'att-keep', name: 'keep.txt', bytes: 3 } };
  const first = await replay(log('second'), { action: 'answer-run', sessionId: 'session-attach-1', turn: 2, files: [file] });
  check('first pass carries it', first.queued[0].content, [{ type: 'text', text: 'second' }, file]);
  const after = await replay(log('second'), { action: 'prompt-save', sessionId: 'session-attach-1', turn: 2, text: 'second', files: [file] });
  check('the state remembers them', promptFiles('session-attach-1', 2), [file]);
  check('the save answered with them', after.payload.prompts['2'].files, [file]);
  const second = await replay(log('second'), { action: 'answer-run', sessionId: 'session-attach-1', turn: 2 });
  check('the next pass still carries it', second.queued[0].content, [{ type: 'text', text: 'second' }, file]);
  // Saving without `files` (an answer edit, not a question edit) leaves them be.
  const saved = await replay(log('second'), { action: 'prompt-save', sessionId: 'session-attach-1', turn: 2, text: 'rewritten' });
  check('a text-only save keeps them', saved.payload.prompts['2'].files, [file]);
  check('a text-only save stores the wording', saved.payload.prompts['2'].text, 'rewritten');
}

// 5. bad payloads are refused as client errors
{
  const bad = await run(log('second'), { action: 'answer-run', sessionId: 'session-attach-1', turn: 2, files: [{ type: 'text', text: 'nope' }] });
  check('refuses a text block as an attachment', bad.status, 400);
  const notArray = await run(log('second'), { action: 'answer-run', sessionId: 'session-attach-1', turn: 2, files: 'x' });
  check('refuses a non-array', notArray.status, 400);
  const noId = await run(log('second'), { action: 'answer-run', sessionId: 'session-attach-1', turn: 2, files: [{ type: 'file', attachment: { name: 'x' } }] });
  check('refuses a reference without an id', noId.status, 400);
  check('nothing was queued', noId.queued.length, 0);
}

// 6. deleting an answer also takes it out of the group that counts it
//
// A group keeps `active` pointing at the answer on screen. If a deleted answer
// stayed in `turns` / active, the surviving card stood down (its component
// returns null for every turn that is not the active one) and that answer lost
// its toolbar while its rows were still there — the report this covers.
{
  const events = log('second').concat([
    { seq: 8, type: 'turn/start', data: { turn: 3 } },
    { seq: 9, type: 'user/message', data: userMessage('u3', 'third', undefined) },
    { seq: 10, type: 'assistant/message', data: { turn: 3, step: 1, message: assistantMessage('a3'), stream: [] } },
    { seq: 11, type: 'turn/end', data: { turn: 3, reason: { kind: 'error' } } },
  ]);
  resetState();
  const { handler } = makeContext(events);
  const post = async (body) => {
    const res = response();
    await handler(request(body), res);
    return { status: res.status, payload: JSON.parse(res.body || '{}') };
  };
  recordRun('session-attach-1', 1, 2, { provider: 'p', model: 'm2' });
  recordRun('session-attach-1', 1, 3, { provider: 'p', model: 'm3' });
  const dropped = await post({ action: 'hide', sessionId: 'session-attach-1', turn: 3, scope: 'answer', hidden: true });
  check('status', dropped.status, 200);
  check('the group forgets the deleted answer', dropped.payload.runs['1'].turns, [1, 2]);
  check('the answer before it takes the screen', dropped.payload.runs['1'].active, 2);
  check('its model label goes too', dropped.payload.runs['1'].models['3'], undefined);
  const last = await post({ action: 'hide', sessionId: 'session-attach-1', turn: 2, scope: 'answer', hidden: true });
  check('a group of one is no group', last.payload.runs, {});

  // State written before the repair: a group that still lists a deleted answer
  // is healed when the payload is built, so the survivor's card comes back.
  resetState();
  recordRun('session-attach-1', 1, 2, { provider: 'p', model: 'm2' });
  recordRun('session-attach-1', 1, 3, { provider: 'p', model: 'm3' });
  setHidden('session-attach-1', 'answer', 3, true);
  check('a stale group still names it', runsForSession('session-attach-1')['1'].active, 3);
  reconcileRuns('session-attach-1');
  check('healed turns', runsForSession('session-attach-1')['1'].turns, [1, 2]);
  check('healed active', runsForSession('session-attach-1')['1'].active, 2);
}

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nall good' : '\n' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
