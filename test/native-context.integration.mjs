// Optional installed-runtime verification. Run with Electron's Node mode and
// pass its resources/app.asar. All persistence and plugin state use a temp home.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const asar = process.argv[2];
if (!asar) throw new Error('Pass the installed resources/app.asar path.');
const root = await mkdtemp(join(tmpdir(), 'mtt-native-context-'));
process.env.USERPROFILE = root; process.env.HOME = root;
const ids = ['cordis', 'dsh-llm', 'dsh-session', 'dsh-session-projection', 'dsh-system-prompt',
  'dsh-tools', 'dsh-tool-executor-native', 'dsh-agent', 'dsh-agent-loop', 'dsh-session-persistence-jsonl', 'dsh-session-query'];
const [cordis, llm, sessions, projections, prompt, tools, executor, agents, loop, persistence, query] =
  await Promise.all(ids.map(id => import(pathToFileURL(`${asar}/dsh/node_modules/@deepseek-ai/${id}/lib/index.js`))));
const { apply } = await import('../lib/index.js');
const store = await import('../lib/state-store.js');
const ctx = new cordis.Context();
const requests = []; let reply = 0, handler;
class ScriptedModel extends llm.LlmAdapter {
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(request) {
    requests.push(request);
    const lastUser = request.messages.findLast(m => m.role === 'user' && m.source.kind === 'user');
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
async function post(body) {
  let status, data = '';
  await handler({ method: 'POST', url: '/message-toolbar', on(event, fn) {
    if (event === 'data') fn(Buffer.from(JSON.stringify(body))); if (event === 'end') fn(); return this;
  } }, { writeHead(code) { status = code; }, end(value) { data += value; } });
  const result = JSON.parse(data);
  assert.equal(status, 200, JSON.stringify(result));
  return result;
}
async function branch(sessionId, operation, turn, text, extra = {}) {
  const result = await post({ action: 'context-branch', sessionId, operation, turn, ...(text === undefined ? {} : { text }), ...extra });
  const agent = ctx.agents.get(sessions.SessionId(result.sessionId));
  await agent.whenIdle();
  return { ...result, agent };
}
try {
  for (const plugin of [llm.default, sessions.default, projections.default, prompt.default, tools.default, executor,
    agents.default, loop.default, query.default]) await ctx.plugin(plugin);
  await ctx.plugin(persistence, { root: join(root, 'sessions'), compression: 'none' });
  ctx.provide('webServer', { register(route) { handler = route.handler; return () => {}; } });
  const archivedSessionIds = [];
  ctx.provide('workspaceRegistry', { archivedSessionIds, list() { return []; },
    async archiveSession(id) { archivedSessionIds.push(id); },
    async unarchiveSession(id) { const i = archivedSessionIds.indexOf(id); if (i >= 0) archivedSessionIds.splice(i, 1); },
  });
  ctx.llm.registerAdapter(['scripted'], new ScriptedModel());
  ctx.tools.register(tools.defineTool({ name: 'proof_read', description: 'read-only scripted proof', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'TOOL-RESULT'; } }));
  apply(ctx);
  const source = await ctx.agents.create({ sessionId: sessions.SessionId('source'), meta: { cwd: root }, agentOptions: route });
  await ask(source.agent, 'PREFIX'); await ask(source.agent, 'TARGET'); await ask(source.agent, 'OLD-FOLLOWUP');
  const sourceEvents = source.agent.session.snapshotEvents();
  const retry = await branch('source', 'retry', 2, undefined, { model: { provider: 'scripted', model: 'temporary' } });
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'ANSWER-1', 'TARGET']);
  assert.equal(requests.at(-1).model, 'temporary');
  await ask(retry.agent, 'NEW-FOLLOWUP');
  assert.equal(requests.at(-1).model, 'original');
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'ANSWER-1', 'TARGET', 'ANSWER-4', 'NEW-FOLLOWUP']);
  const retryState = await get(retry.sessionId);
  assert.equal(retryState.contextChoices['2'].items.some(item => item.preview === 'ANSWER-2'), true);
  const originalChoice = retryState.contextChoices['2'].items.find(item => item.preview === 'ANSWER-2');
  const picked = await post({ action: 'context-select', sessionId: retry.sessionId, turn: 2, id: originalChoice.id });
  assert.equal(picked.sessionId, 'source');
  await ask(source.agent, 'SOURCE-FOLLOWUP');
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'ANSWER-1', 'TARGET', 'ANSWER-2', 'OLD-FOLLOWUP', 'ANSWER-3', 'SOURCE-FOLLOWUP']);
  const beforeSave = requests.length;
  const editedPrompt = await branch('source', 'edit-prompt', 2, 'EDITED-QUESTION');
  assert.equal(requests.length, beforeSave);
  await ask(editedPrompt.agent, 'CHECK-QUESTION');
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'ANSWER-1', 'EDITED-QUESTION', 'ANSWER-2', 'CHECK-QUESTION']);
  const editedAnswer = await branch('source', 'edit-answer', 2, 'EDITED-ANSWER');
  await ask(editedAnswer.agent, 'CHECK-ANSWER');
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'ANSWER-1', 'TARGET', 'EDITED-ANSWER', 'CHECK-ANSWER']);
  const deleted = await branch('source', 'delete-answer', 1);
  await ask(deleted.agent, 'CHECK-DELETE');
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'CHECK-DELETE']);
  const noQuestion = await branch('source', 'delete-question', 2);
  await ask(noQuestion.agent, 'CHECK-QUESTION-DELETE');
  assert.deepEqual(texts(requests.at(-1)), ['PREFIX', 'ANSWER-1', 'CHECK-QUESTION-DELETE']);
  assert.deepEqual(source.agent.session.snapshotEvents().slice(0, sourceEvents.length), sourceEvents);
  const native = await ctx.agents.create({ sessionId: sessions.SessionId('tool-source'), meta: { cwd: root }, agentOptions: route });
  await ask(native.agent, 'TOOL-WORK');
  const toolEvents = native.agent.session.snapshotEvents();
  assert.equal(toolEvents.filter(e => e.type === 'tool/call').length, 1);
  const toolEdit = await branch('tool-source', 'edit-answer', 1, 'TOOL-EDIT');
  await ask(toolEdit.agent, 'AFTER-TOOL-EDIT');
  assert.equal(requests.at(-1).messages.some(m => m.role === 'tool' && m.toolCallId === 'proof-call'), true);
  assert.equal(texts(requests.at(-1)).includes('TOOL-EDIT'), true);
  const toolDeleted = await branch(toolEdit.sessionId, 'delete-answer', 1);
  await ask(toolDeleted.agent, 'AFTER-TOOL-DELETE');
  assert.equal(requests.at(-1).messages.some(m => m.role === 'tool'), false,
    JSON.stringify({ selected: toolDeleted.sessionId, created: toolDeleted.createdSessionId,
      state: (await get(toolDeleted.sessionId)).contextChoices['1'], texts: texts(requests.at(-1)) }));
  const legacy = await ctx.agents.create({ sessionId: sessions.SessionId('legacy'), meta: { cwd: root }, agentOptions: route });
  await ask(legacy.agent, 'OLD-QUESTION');
  const discarded = texts({ messages: legacy.agent.session.deriveMessages() }).at(-1);
  await ask(legacy.agent, 'LATER-QUESTION');
  await ask(legacy.agent, 'OLD-QUESTION');
  const chosen = texts({ messages: legacy.agent.session.deriveMessages() }).at(-1);
  store.recordRun('legacy', 1, 3);
  store.setPromptOverride('legacy', 1, 'EDITED-LEGACY', []);
  const migrated = await post({ action: 'context-normalize', sessionId: 'legacy' });
  const migratedAgent = ctx.agents.get(sessions.SessionId(migrated.sessionId));
  await ask(migratedAgent, 'AFTER-MIGRATION');
  assert.equal(texts(requests.at(-1)).filter(text => text === 'EDITED-LEGACY').length, 1);
  assert.equal(texts(requests.at(-1)).includes(discarded), false);
  assert.equal(texts(requests.at(-1)).includes(chosen), true);
  // Flush and release the exact session created through the plugin route.
  await ctx.sessions.flush(editedAnswer.agent.session);
  editedAnswer.agent.cancel({ kind: 'user' }); await editedAnswer.agent.whenIdle();
  // A separate owner scope lets the registry and storage close before resume.
  // Dispose the root after retaining the durable id; the cold context is below.
  await ctx.fiber.dispose();
  const cold = new cordis.Context();
  try {
    for (const plugin of [llm.default, sessions.default, projections.default, prompt.default, tools.default, executor, agents.default, loop.default]) await cold.plugin(plugin);
    await cold.plugin(persistence, { root: join(root, 'sessions'), compression: 'none' });
    cold.llm.registerAdapter(['scripted'], new ScriptedModel());
    const resumed = await cold.agents.resume({ resumeSessionId: sessions.SessionId(editedAnswer.sessionId), agentOptions: route });
    await ask(resumed.agent, 'AFTER-COLD-RELOAD');
    assert.deepEqual(texts(requests.at(-1)).slice(0, 4), ['PREFIX', 'ANSWER-1', 'TARGET', 'EDITED-ANSWER']);
    assert.equal(texts(requests.at(-1)).includes('ANSWER-2'), false);
    const resumedTools = await cold.agents.resume({ resumeSessionId: sessions.SessionId(toolEdit.sessionId), agentOptions: route });
    await ask(resumedTools.agent, 'COLD-TOOL-CHECK');
    assert.equal(requests.at(-1).messages.some(m => m.role === 'tool' && m.toolCallId === 'proof-call'), true);
    assert.equal(texts(requests.at(-1)).includes('TOOL-EDIT'), true);
    console.log('PASS real plugin routes, native requests, branch continuations, edits, deletion, legacy migration, tools, model restore and cold reload');
  } finally { await cold.fiber.dispose(); }
} finally {
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
