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
async function focus(navigation) {
  await post({ action: 'focus', sessionId: navigation.sessionId, token: navigation.navigationToken });
  assert.deepEqual(ctx.workspaceRegistry.archivedSessionIds, ['manual-archive']);
  assert.deepEqual(ctx.workspaceRegistry.pinnedSessionIds, ['source']);
}
async function branch(sessionId, operation, turn, text, extra = {}) {
  const result = await post({ action: 'context-branch', sessionId, operation, turn, ...(text === undefined ? {} : { text }), ...extra });
  const agent = ctx.agents.get(sessions.SessionId(result.sessionId));
  await agent.whenIdle();
  await focus(result);
  return { ...result, agent };
}
try {
  for (const plugin of [llm.default, sessions.default, projections.default, prompt.default, tools.default, executor,
    agents.default, loop.default, query.default, meter.default, storage.default]) await ctx.plugin(plugin);
  await ctx.plugin(persistence, { root: join(root, 'sessions'), compression: 'none' });
  await ctx.plugin(ScriptedCompaction, { auto: false });
  await ctx.plugin(storageJson, { root: join(root, 'storage') });
  await ctx.plugin(storageDomain, { backend: 'json' });
  await ctx.plugin(workspace.default);
  ctx.provide('webServer', { register(route) { handler = route.handler; return () => {}; } });
  const registry = ctx.workspaceRegistry;
  const group = await registry.create(root, 'Toolbar integration test');
  ctx.llm.registerAdapter(['scripted'], new ScriptedModel());
  ctx.tools.register(tools.defineTool({ name: 'proof_read', description: 'read-only scripted proof', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() { return 'TOOL-RESULT'; } }));
  apply(ctx);
  await ctx.agents.create({ sessionId: sessions.SessionId('manual-archive'), meta: { cwd: root }, agentOptions: route });
  await group.attachSession(sessions.SessionId('manual-archive'));
  await registry.archiveSession(sessions.SessionId('manual-archive'));
  const source = await ctx.agents.create({ sessionId: sessions.SessionId('source'), meta: { cwd: root }, agentOptions: route });
  await group.attachSession(sessions.SessionId('source'));
  await registry.pinSession(sessions.SessionId('source'));
  await ask(source.agent, 'PREFIX'); await ask(source.agent, 'TARGET'); await ask(source.agent, 'OLD-FOLLOWUP');
  const sourceEvents = source.agent.session.snapshotEvents();
  const retry = await branch('source', 'retry', 2, undefined, { model: { provider: 'scripted', model: 'temporary' } });
  assert.ok(group.sessionIds.includes(retry.sessionId));
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
  await focus(picked);
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
  const removedCard = await post({ action: 'delete-version', sessionId: noQuestion.sessionId });
  assert.equal(removedCard.sessionId, 'source');
  await focus(removedCard);
  assert.ok(group.sessionIds.includes(noQuestion.sessionId));
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
  await focus(migrated);
  await registry.archiveSession(migrated.sessionId);
  const migratedAgain = await post({ action: 'context-normalize', sessionId: 'legacy' });
  assert.equal(migratedAgain.reusedMigration, true);
  assert.equal(migratedAgain.sessionId, migrated.sessionId);
  assert.equal(migratedAgain.archived, true);
  assert.deepEqual(registry.archivedSessionIds, ['manual-archive', migrated.sessionId]);
  const activated = await post({ action: 'activate', sessionId: migratedAgain.sessionId });
  assert.equal(activated.unarchived, true);
  await focus(migratedAgain);
  const migratedAgent = ctx.agents.get(sessions.SessionId(migrated.sessionId));
  await ask(migratedAgent, 'AFTER-MIGRATION');
  assert.equal(texts(requests.at(-1)).filter(text => text === 'EDITED-LEGACY').length, 1);
  assert.equal(texts(requests.at(-1)).includes(discarded), false);
  assert.equal(texts(requests.at(-1)).includes(chosen), true);
  await ctx.sessions.flush(migratedAgent.session);
  const compactedPrompt = 'COMPACT-ORIGINAL '.repeat(512).trim();
  const migratedCompactions = [];
  for (const { id, turn, edited, keep } of [
    { id: 'compact-keep', turn: 2, edited: 'EDIT-OUTSIDE-SUMMARY', keep: true },
    { id: 'compact-drop', turn: 1, edited: 'EDIT-INSIDE-SUMMARY', keep: false },
  ]) {
    const { agent } = await ctx.agents.create({ sessionId: sessions.SessionId(id), meta: { cwd: root }, agentOptions: route });
    await ask(agent, compactedPrompt);
    assert.ok(await ctx.compaction.compactNow(agent, AbortSignal.timeout(5000)));
    await ask(agent, 'COMPACT-SUFFIX');
    assert.ok(checkpointText(requests.at(-1)).includes('NATIVE-SUMMARY'));
    assert.equal(texts(requests.at(-1)).includes(compactedPrompt), false);
    const original = agent.session.snapshotEvents();
    store.setPromptOverride(id, turn, edited, []);
    const beforeMigration = requests.length;
    const result = await post({ action: 'context-normalize', sessionId: id });
    assert.equal(requests.length, beforeMigration);
    assert.deepEqual(agent.session.snapshotEvents(), original);
    migratedCompactions.push({ sessionId: result.sessionId, edited, keep });
  }
  const { agent: middleAgent } = await ctx.agents.create({
    sessionId: sessions.SessionId('compact-middle'), meta: { cwd: root }, agentOptions: route,
  });
  await ask(middleAgent, 'MIDDLE-HEAD');
  await ask(middleAgent, 'MIDDLE-QUESTION');
  const discardedMiddleAnswer = texts({ messages: middleAgent.session.deriveMessages() }).at(-1);
  await ask(middleAgent, 'MIDDLE-QUESTION');
  const chosenMiddleAnswer = texts({ messages: middleAgent.session.deriveMessages() }).at(-1);
  await ask(middleAgent, compactedPrompt);
  const middleEvents = middleAgent.session.snapshotEvents();
  const start = middleEvents.findLast(event => event.type === 'user/message' && event.data.source.kind === 'user').seq;
  const end = middleEvents.findLast(event => event.type === 'assistant/message').seq;
  const removeMidCompaction = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (agent === middleAgent) await ctx.compaction.compactRegion(start, end, agent, signal);
    return next();
  });
  try { await ask(middleAgent, 'MIDDLE-SUFFIX'); }
  finally { removeMidCompaction(); }
  assert.ok(checkpointText(requests.at(-1)).includes('NATIVE-SUMMARY'));
  store.recordRun('compact-middle', 2, 3);
  const migratedMiddle = await post({ action: 'context-normalize', sessionId: 'compact-middle' });
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
    for (const { sessionId, edited, keep } of migratedCompactions) {
      const restored = await cold.agents.resume({ resumeSessionId: sessions.SessionId(sessionId), agentOptions: route });
      await ask(restored.agent, 'AFTER-COMPACT-MIGRATION');
      assert.deepEqual(checkpointText(requests.at(-1)).filter(text => text === 'NATIVE-SUMMARY'), keep ? ['NATIVE-SUMMARY'] : []);
      assert.ok(texts(requests.at(-1)).includes(edited));
      assert.equal(texts(requests.at(-1)).includes(compactedPrompt), false);
    }
    const resumedMiddle = await cold.agents.resume({ resumeSessionId: sessions.SessionId(migratedMiddle.sessionId), agentOptions: route });
    await ask(resumedMiddle.agent, 'AFTER-COLD-MIDDLE-REPLAY');
    const middleHistory = texts(requests.at(-1));
    assert.deepEqual(checkpointText(requests.at(-1)).filter(text => text === 'NATIVE-SUMMARY'), ['NATIVE-SUMMARY']);
    assert.equal(middleHistory.filter(text => text === 'MIDDLE-QUESTION').length, 1);
    assert.ok(middleHistory.includes(chosenMiddleAnswer));
    assert.equal(middleHistory.includes(discardedMiddleAnswer), false);
    assert.ok(middleHistory.includes('MIDDLE-SUFFIX'));
    const resumedLegacy = await cold.agents.resume({ resumeSessionId: sessions.SessionId(migrated.sessionId), agentOptions: route });
    await ask(resumedLegacy.agent, 'AFTER-COLD-LEGACY-REPLAY');
    assert.deepEqual(texts(requests.at(-1)).slice(0, 3), ['EDITED-LEGACY', chosen, 'LATER-QUESTION']);
    assert.equal(texts(requests.at(-1)).includes(discarded), false);
    console.log('PASS native requests, real workspace archive and pin preservation, branch continuations, edits, deletion, migration, compaction, model restore and cold reload');
  } finally { await cold.fiber.dispose(); }
} finally {
  await ctx.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
