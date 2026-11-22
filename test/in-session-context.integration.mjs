// Optional installed-runtime verification. Run with Electron's Node mode and
// pass its resources/app.asar. All persistence and plugin state use a temp home.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const asar = process.argv[2];
if (!asar) throw new Error('Pass the installed resources/app.asar path.');
const tempParent = await realpath(tmpdir());
const root = await realpath(await mkdtemp(join(tempParent, 'mtt-native-context-')));
assert.equal(dirname(root), tempParent);
process.env.USERPROFILE = root; process.env.HOME = root;
const ids = ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt',
  'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent', 'dsh-agent-loop', 'dsh-session-persistence-jsonl', 'dsh-session-query',
  'dsh-token-meter', 'dsh-compaction-basic', 'dsh-storage', 'dsh-storage-json', 'dsh-storage-domain', 'dsh-workspace'];
const [cordis, llm, sessions, projections, prompt, tools, executor, agents, loop, persistence, query, meter, compaction,
  storage, storageJson, storageDomain, workspace] =
  await Promise.all(ids.map(id => import(pathToFileURL(`${asar}/dsh/node_modules/@deepseek-ai/${id}/lib/index.js`))));
const { apply } = await import('../lib/index.js');
const store = await import('../lib/state-store.js');
const ctx = new cordis.Context();
const requests = []; let reply = 0, handler, waiting;
class ScriptedModel extends llm.LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(request) {
    requests.push(request);
    const lastUser = request.messages.findLast(m => m.role === 'user' && m.source.kind === 'user');
    if (lastUser?.content.some(b => b.text === 'WAIT')) {
      waiting?.resolve(request);
      await new Promise(resolve => {
        const timeout = setTimeout(resolve, 4000);
        request.signal.addEventListener('abort', () => { clearTimeout(timeout); resolve(); }, { once: true });
      });
      request.signal.throwIfAborted();
    }
    if (lastUser?.content.some(b => b.text === 'FAIL')) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'FIXTURE', message: 'Fixture model unavailable' } } };
      return;
    }
    if (lastUser?.content.some(b => b.text === 'TOOL-WORK') && !request.messages.some(m => m.role === 'tool')) {
      const block = { type: 'tool-call', id: 'proof-call', name: 'proof_read', arguments: '{}' };
      yield { type: 'block-start', index: 0, blockType: 'tool-call' };
      yield { type: 'tool-call-delta', index: 0, id: 'proof-call', name: 'proof_read', argumentsDelta: '{}' };
      yield { type: 'block-end', index: 0, block };
      yield { type: 'finish', reason: { kind: 'tool-calls' } };
      return;
    }
    const text = `ANSWER-${++reply}`;
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}
class ScriptedCompaction extends compaction.BasicCompactionEngine {
  async summarize() {
    return { summary: [{ type: 'text', text: 'NATIVE-SUMMARY' }], provider: 'scripted', model: 'original' };
  }
}
async function get(sessionId) {
  let status, data = '';
  await handler({ method: 'GET', url: `/message-toolbar?sessionId=${sessionId}` },
    { writeHead(code) { status = code; }, end(value) { data += value; } });
  assert.equal(status, 200, data);
  return JSON.parse(data);
}
const route = { provider: 'scripted', model: 'original' };
const message = text => llm.createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });
async function ask(agent, text) { agent.followup(message(text)); await agent.whenIdle(); }
const texts = request => request.messages.filter(m => m.role === 'user' || m.role === 'assistant')
  .map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join(''));
const checkpointText = request => request.messages.filter(message => message.source.kind === 'compact-checkpoint')
  .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text));
async function post(body) {
  let status, data = '';
  await handler({ method: 'POST', url: '/message-toolbar', on(event, fn) {
    if (event === 'data') fn(Buffer.from(JSON.stringify(body))); if (event === 'end') fn(); return this;
  } }, { writeHead(code) { status = code; }, end(value) { data += value; } });
  const result = JSON.parse(data);
  assert.equal(status, 200, JSON.stringify(result));
  return result;
}
async function retry(agent, turn, model) {
  const sessionId = agent.session.id;
  const result = await post({ action: 'context-branch', sessionId, turn, operation: 'retry', model });
  assert.equal(result.sessionId, sessionId, '重答必须留在同一 DSH session');
  assert.equal(result.navigationToken, undefined);
  await agent.whenIdle();
  return result;
}
async function select(agent, turn, id) {
  const result = await post({ action: 'context-select', sessionId: agent.session.id, turn, id });
  assert.equal(result.sessionId, agent.session.id);
  assert.equal(result.navigationToken, undefined);
}
async function change(agent, operation, turn, extra = {}) {
  const result = await post({ action: 'context-update', sessionId: agent.session.id, turn, operation, ...extra });
  assert.deepEqual([result.sessionId, result.inPlace, result.navigationToken], [agent.session.id, true, undefined]);
}
async function engine(withWorkspace = false) {
  const host = withWorkspace ? ctx : new cordis.Context();
  for (const plugin of [llm.default, sessions.default, projections.default, prompt.default, tools.default, executor,
    agents.default, loop.default, query.default, meter.default, storage.default]) await host.plugin(plugin);
  await host.plugin(persistence, { root: join(root, 'sessions'), compression: 'none' });
  await host.plugin(ScriptedCompaction, { auto: false });
  await host.plugin(storageJson, { root: join(root, 'storage') });
  await host.plugin(storageDomain, { backend: 'json' });
  await host.plugin(workspace.default);
  host.provide('webServer', { register(route) { handler = route.handler; return () => {}; } });
  host.llm.registerAdapter(['scripted'], new ScriptedModel());
  host.tools.register(tools.defineTool({ name: 'proof_read', description: 'read-only scripted proof', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'TOOL-RESULT'; } }));
  apply(host);
  return host;
}

try {
  await engine(true);
  const registry = ctx.workspaceRegistry;
  const group = await registry.create(root, 'Single session test');
  const { agent } = await ctx.agents.create({ sessionId: sessions.SessionId('main'), meta: { cwd: root }, agentOptions: route });
  await group.attachSession(agent.session.id);
  await registry.pinSession(agent.session.id);
  await ask(agent, 'PREFIX');
  await ask(agent, 'QUESTION');
  const originalAnswer = texts(requests.at(-1));
  await ask(agent, 'A-FOLLOWUP');
  const firstAnswer = texts(requests.at(-1)).at(-2);
  assert.deepEqual(originalAnswer, ['PREFIX', 'ANSWER-1', 'QUESTION']);
  const originalEvents = agent.session.snapshotEvents();
  await retry(agent, 2, { provider: 'scripted', model: 'alternate' });
  assert.equal(requests.at(-1).model, 'alternate');
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'ANSWER-1', 'QUESTION']);
  const alternateAnswer = `ANSWER-${reply}`;
  const state = await get(agent.session.id);
  const alternatives = Object.values(state.contextChoices).find(group => group.items.some(item => item.preview === firstAnswer));
  assert.ok(alternatives);
  assert.equal(alternatives.items.length, 2);
  const first = alternatives.items.find(item => item.preview === firstAnswer);
  const second = alternatives.items.find(item => item.preview === alternateAnswer);
  assert.equal(second.model, 'alternate');
  await ask(agent, 'B-FOLLOWUP');
  assert.equal(requests.at(-1).model, 'original');
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'ANSWER-1', 'QUESTION', alternateAnswer, 'B-FOLLOWUP']);
  await select(agent, second.turn, first.id);
  await ask(agent, 'A-BACK');
  assert.deepEqual(texts(requests.at(-1)).slice(0, 5), ['PREFIX', 'ANSWER-1', 'QUESTION', firstAnswer, 'A-FOLLOWUP']);
  assert.ok(!texts(requests.at(-1)).includes('B-FOLLOWUP'));
  await select(agent, first.turn, second.id);
  await ask(agent, 'B-BACK');
  assert.deepEqual(texts(requests.at(-1)).slice(0, 5), ['PREFIX', 'ANSWER-1', 'QUESTION', alternateAnswer, 'B-FOLLOWUP']);
  assert.ok(!texts(requests.at(-1)).includes('A-FOLLOWUP'));
  assert.deepEqual(group.sessionIds, [agent.session.id]);
  assert.deepEqual(registry.pinnedSessionIds, [agent.session.id]);
  assert.deepEqual(registry.archivedSessionIds, []);
  assert.deepEqual(agent.session.snapshotEvents().slice(0, originalEvents.length), originalEvents);

  const create = async id => (await ctx.agents.create({ sessionId: sessions.SessionId(id), meta: { cwd: root }, agentOptions: route })).agent;
  const work = await create('tool-work');
  await ask(work, 'TOOL-WORK');
  await change(work, 'edit-answer', 1, { text: 'EDITED-TOOL-ANSWER' });
  await ask(work, 'TOOL-AFTER-EDIT');
  const toolRequest = requests.at(-1);
  assert.equal(toolRequest.messages.filter(m => m.role === 'tool' && m.toolCallId === 'proof-call').length, 1);
  assert.equal(toolRequest.messages.flatMap(m => m.content).filter(b => b.type === 'tool-call' && b.id === 'proof-call').length, 1);
  assert.ok(toolRequest.tools.some(tool => tool.name === 'proof_read'));
  assert.ok(texts(toolRequest).includes('EDITED-TOOL-ANSWER'));
  const afterEdit = `ANSWER-${reply}`;
  await change(work, 'delete-answer', 1);
  await ask(work, 'TOOL-AFTER-DELETE');
  assert.deepEqual(texts(requests.at(-1)), ['TOOL-WORK', 'TOOL-AFTER-EDIT', afterEdit, 'TOOL-AFTER-DELETE']);
  assert.ok(!requests.at(-1).messages.some(m => m.role === 'tool'));

  const edited = await create('edited-middle');
  await ask(edited, 'KEEP-BEFORE');
  const beforeEdit = `ANSWER-${reply}`;
  await ask(edited, 'REWRITE-ME');
  await ask(edited, 'KEEP-AFTER');
  const keptAfter = `ANSWER-${reply}`;
  await change(edited, 'edit-prompt', 2, { text: 'REWRITTEN' });
  await change(edited, 'edit-answer', 2, { text: 'REWRITTEN-ANSWER' });
  await ask(edited, 'VERIFY-EDIT');
  assert.deepEqual(texts(requests.at(-1)), ['KEEP-BEFORE', beforeEdit, 'REWRITTEN', 'REWRITTEN-ANSWER', 'KEEP-AFTER', keptAfter, 'VERIFY-EDIT']);
  const editConfirmation = `ANSWER-${reply}`;
  await change(edited, 'delete-question', 2);
  await ask(edited, 'VERIFY-DELETION');
  assert.deepEqual(texts(requests.at(-1)), ['KEEP-BEFORE', beforeEdit, 'KEEP-AFTER', keptAfter, 'VERIFY-EDIT', editConfirmation, 'VERIFY-DELETION']);

  const legacy = await create('legacy');
  await ask(legacy, 'LEGACY-QUESTION');
  const stale = `ANSWER-${reply}`;
  await ask(legacy, 'LEGACY-CONTINUATION');
  await ask(legacy, 'LEGACY-QUESTION');
  const chosen = `ANSWER-${reply}`;
  store.recordRun('legacy', 1, 3);
  store.setPromptOverride('legacy', 1, 'EDITED-LEGACY-QUESTION', []);
  await ask(legacy, 'AFTER-LEGACY');
  assert.deepEqual(texts(requests.at(-1)).slice(0, 3), ['EDITED-LEGACY-QUESTION', chosen, 'LEGACY-CONTINUATION']);
  assert.ok(!texts(requests.at(-1)).includes(stale));

  const legacyHidden = await create('legacy-hidden');
  await ask(legacyHidden, 'OLD-QUESTION');
  const oldAnswer = `ANSWER-${reply}`;
  await ask(legacyHidden, 'OLD-QUESTION');
  const keptReplay = `ANSWER-${reply}`;
  await ask(legacyHidden, 'OLD-QUESTION');
  store.rememberReplay('legacy-hidden', 1, 2);
  store.rememberReplay('legacy-hidden', 1, 3);
  for (const turn of [2, 3]) store.setHidden('legacy-hidden', 'prompt', turn, true);
  store.setHidden('legacy-hidden', 'answer', 3, true);
  const oldView = await get(legacyHidden.session.id);
  assert.deepEqual(oldView.hidden.turns, [3], 'a deleted replay stays absent from the transcript');
  assert.deepEqual(oldView.hidden.prompts, [2], 'the surviving replay still hides only its duplicate prompt');
  await ask(legacyHidden, 'AFTER-HIDDEN');
  assert.deepEqual(texts(requests.at(-1)), ['OLD-QUESTION', oldAnswer, 'OLD-QUESTION', keptReplay, 'AFTER-HIDDEN']);

  for (const editTurn of [1, 2]) {
    const compact = await create(`compact-${editTurn}`);
    const long = 'COMPACT-OLD-PROMPT '.repeat(600).trim();
    await ask(compact, long);
    assert.ok(await ctx.compaction.compactNow(compact, AbortSignal.timeout(5000)));
    await ask(compact, 'AFTER-COMPACT');
    await change(compact, 'edit-prompt', editTurn, { text: 'EDITED-PROMPT' });
    await ask(compact, 'COMPACT-CHECK');
    const summary = checkpointText(requests.at(-1));
    if (editTurn === 1) assert.deepEqual(summary, []);
    else assert.ok(summary.includes('NATIVE-SUMMARY'));
    assert.ok(texts(requests.at(-1)).includes('EDITED-PROMPT'));
    assert.ok(!texts(requests.at(-1)).includes(long));
  }

  const supplemental = await create('supplemental');
  await ask(supplemental, 'SUPPLEMENT-FIRST');
  await ask(supplemental, 'SUPPLEMENT-RETRY');
  await change(supplemental, 'edit-prompt', 2, { text: 'EDIT-SUPPLEMENT' });
  supplemental.followup(llm.createUserMessage({ source: { kind: 'tool-context' }, content: [{ type: 'text', text: 'NATIVE-TOOL-CONTEXT' }] }));
  await supplemental.whenIdle();
  await ask(supplemental, 'AFTER-SUPPLEMENT');
  // Even turns without a human prompt may produce a native reply.
  const automatic = supplemental.session.snapshotEvents().find(e => e.type === 'assistant/message' && e.data.turn === 3);
  assert.ok(automatic, 'fixture must produce an assistant reply without a human turn');
  assert.ok(requests.at(-1).messages.some(m => m.id === automatic.data.message.id));

  const interruption = await create('interruption');
  await ask(interruption, 'RETRY-ME');
  const retained = `ANSWER-${reply}`;
  await ask(interruption, 'KEEP-THIS-FOLLOWUP');
  await change(interruption, 'retry', 1, { text: 'FAIL' });
  await interruption.whenIdle();
  let ring = (await get(interruption.session.id)).contextChoices[3];
  assert.equal(ring.items.length, 2);
  await select(interruption, 3, ring.items.find(choice => choice.preview === retained).id);
  waiting = Promise.withResolvers();
  await change(interruption, 'retry', 1, { text: 'WAIT', model: { provider: 'scripted', model: 'alternate' } });
  const cancelRequest = await waiting.promise;
  assert.deepEqual(texts(cancelRequest), ['WAIT']);
  interruption.cancel({ kind: 'user' });
  await interruption.whenIdle();
  assert.equal(cancelRequest.signal.aborted, true);
  ring = (await get(interruption.session.id)).contextChoices[4];
  await select(interruption, 4, ring.items.find(choice => choice.preview === retained).id);
  await ask(interruption, 'AFTER-CANCEL');
  assert.equal(requests.at(-1).model, 'original');
  assert.deepEqual(texts(requests.at(-1)).slice(0, 3), ['RETRY-ME', retained, 'KEEP-THIS-FOLLOWUP']);
  assert.ok(!texts(requests.at(-1)).includes('FAIL'));
  assert.ok(!texts(requests.at(-1)).includes('WAIT'));

  await ctx.sessions.flush(agent.session);
  await ctx.fiber.dispose();
  store.reloadState();
  const cold = await engine();
  try {
    const restored = await cold.agents.resume({ resumeSessionId: sessions.SessionId('main'), agentOptions: route });
    await ask(restored.agent, 'COLD');
    assert.deepEqual(texts(requests.at(-1)).slice(0, 5), ['PREFIX', 'ANSWER-1', 'QUESTION', alternateAnswer, 'B-FOLLOWUP']);
    assert.ok(!texts(requests.at(-1)).includes(firstAnswer));
  } finally { await cold.fiber.dispose(); }
  console.log('PASS same session, continuation selection, model restoration, workspace, tools, legacy edits, compaction and cold reload');
} finally {
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
