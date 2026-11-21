import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContextBranch, contextTurns, normalizeLegacyHistory, questionIdentity } from '../lib/context-branches.js';

function history(count = 3) {
  const events = [];
  const push = (type, data, extra = {}) => events.push({ type, seq: events.length, time: 100 + events.length, data, ...extra });
  for (let turn = 1; turn <= count; turn++) {
    push('turn/start', { turn }); push('step/start', { turn, step: 1 });
    push('user/message', { id: `q${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `Q${turn}` }, { type: 'file', attachment: { attachmentId: `f${turn}` } }] }, { surfaceOp: 'append' });
    push('assistant/message', { turn, step: 1, message: { id: `a${turn}`, role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' }, content: [{ type: 'text', text: `A${turn}` }] }, stream: [{ type: 'text-chunks', texts: [`A${turn}`] }] }, { surfaceOp: 'append' });
    push('step/end', { turn, step: 1 }); push('turn/end', { turn, reason: { kind: 'completed' } });
  }
  return events;
}
const messages = events => events.filter(e => e.type === 'user/message' || e.type === 'assistant/message')
  .map(e => e.data.message ?? e.data).map(m => m.content.filter(b => b.type === 'text').map(b => b.text).join(''));

test('retry forks the exact prefix and queues one copy of the question without its previous answer', () => {
  const source = history(); const snapshot = structuredClone(source);
  const result = buildContextBranch(source, { sessionId: 'root', operation: 'retry', turn: 2 });
  assert.deepEqual(messages(result.seed), ['Q1', 'A1']);
  assert.deepEqual(result.queuedUser.content, [{ type: 'text', text: 'Q2' }, { type: 'file', attachment: { attachmentId: 'f2' } }]);
  assert.equal(result.context['2'].questionId, 'q2'); assert.equal(result.seed.at(-1).type, 'message-toolbar/version');
  assert.deepEqual(result.seed.map(e => e.seq), result.seed.map((_, i) => i));
  result.seed[2].data.content[0].text = 'changed branch';
  assert.deepEqual(source, snapshot);
});
test('an edited prompt changes the durable copied question and keeps its answer without queuing a request', () => {
  const result = buildContextBranch(history(), { sessionId: 'root', operation: 'edit-prompt', turn: 2, text: 'Edited Q2', files: [] });
  assert.deepEqual(messages(result.seed), ['Q1', 'A1', 'Edited Q2', 'A2']);
  assert.equal(result.queuedUser, undefined);
  const turn = contextTurns(result.seed).find(t => t.turn === 2);
  assert.equal(turn.user.data.content.length, 1);
  assert.equal(turn.user.data.id, 'q2');
});

test('an edited answer keeps one answer identity and event, resets its stream, and retains closed tool pairs', () => {
  const source = history(1);
  const assistant = source.find(event => event.type === 'assistant/message');
  assistant.data.message.source.replayState = { content: 'original provider response' };
  assistant.data.message.content.push({ type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' });
  source.splice(4, 0,
    { type: 'tool/call', seq: 4, time: 104, data: { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: '{}' } },
    { type: 'tool/result', seq: 5, time: 105, data: { turn: 1, step: 1, message: { id: 'result-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'file contents' }] } }, surfaceOp: 'append' },
  );
  source.forEach((event, seq) => { event.seq = seq; event.time = 100 + seq; });
  const result = buildContextBranch(source, { sessionId: 'root', operation: 'edit-answer', turn: 1, text: 'Edited A1' });
  const edited = result.seed.find(event => event.type === 'assistant/message');
  assert.equal(edited.data.message.content[0].text, 'Edited A1');
  assert.deepEqual(edited.data.stream, []); assert.equal(edited.data.message.id, 'a1');
  assert.equal(result.seed.filter(event => event.type === 'tool/call').length, 1);
  assert.equal(result.seed.filter(event => event.type === 'tool/result').length, 1);
  assert.equal(result.context['1'].answerId, 'a1');
  assert.equal(edited.data.message.source.replayState, undefined);
});

test('deleting the last answer keeps the prompt, removes its reply and later questions, and closes the forked turn', () => {
  const result = buildContextBranch(history(), { sessionId: 'root', operation: 'delete-answer', turn: 2 });
  assert.deepEqual(messages(result.seed), ['Q1', 'A1', 'Q2']);
  // The public Session constructor owns the seed marker. Closers are appended
  // during setup, after that marker, before publication can start the loop.
  assert.equal(result.inheritedEventCount, result.seed.length);
  assert.equal(result.seed.some(e => e.type === 'session/end-seed'), false);
  assert.deepEqual(result.tail.map(e => [e.type, e.data]), [
    ['step/end', { turn: 2, step: 1 }],
    ['turn/end', { turn: 2, reason: { kind: 'forked' } }],
  ]);
  assert.equal(result.context['2'].answerId, null); assert.equal(result.queuedUser, undefined);
});

test('every closed branch lets the native constructor mark its entire inherited seed', () => {
  for (const operation of ['retry', 'edit-prompt', 'edit-answer', 'delete-question']) {
    const result = buildContextBranch(history(), { sessionId: 'root', operation, turn: 2, text: 'edited' });
    assert.equal(result.inheritedEventCount, result.seed.length);
    assert.deepEqual(result.tail, []);
    assert.equal(result.seed.some(e => e.type === 'session/end-seed'), false);
  }
});

test('editing a compacted question refuses a shadowed message instead of changing invisible history', () => {
  const source = history(1);
  source.push({ type: 'developer/message', seq: source.length, time: 200,
    surfaceOp: { op: 'replace', startSeq: 2, endSeq: 3 }, sourceEventSeqs: [2, 3],
    data: { id: 'summary', role: 'developer', content: [{ type: 'text', text: 'Q1 A1 summary' }] } });
  assert.throws(() => buildContextBranch(source, { sessionId: 'root', operation: 'edit-prompt', turn: 1, text: 'new' }), /压缩|替换/);
});

test('deleting a question drops its answer and all later context', () => {
  const result = buildContextBranch(history(), { sessionId: 'root', operation: 'delete-question', turn: 2 });
  assert.deepEqual(messages(result.seed), ['Q1', 'A1']); assert.equal(result.context['2'], undefined);
  assert.equal(result.seed.at(-1).data.effect.questionId, 'q2');
  assert.equal(result.seed.at(-1).data.effect.answerId, 'a2');
});

test('version marker times increase monotonically across rapid operations', () => {
  const source = history(1);
  const first = buildContextBranch(source, { sessionId: 'root', operation: 'edit-answer', turn: 1, text: 'A1 edited once' });
  const second = buildContextBranch(first.seed, { sessionId: first.sessionId, operation: 'edit-answer', turn: 1, text: 'A1 edited twice' });
  assert.ok(second.seed.at(-1).time > first.seed.at(-1).time);
});

test('branches of a prior edit retain earlier branch-specific context and distinct question identity', () => {
  const source = history();
  source.push({ type: 'message-toolbar/version', seq: source.length, time: 200, ignorable: true,
    data: { context: { '1': { questionId: 'logical-q1', answerId: 'edited-a1', answerText: 'changed' }, '2': { questionId: 'logical-q2', answerId: 'old-a2' } } } });
  const result = buildContextBranch(source, { sessionId: 'branch-q1', operation: 'retry', turn: 2 });
  assert.equal(result.context['1'].answerId, 'edited-a1'); assert.equal(result.context['2'].questionId, 'logical-q2');
  assert.deepEqual(messages(result.seed), ['Q1', 'A1']);
});

test('legacy runs migrate to one question and the selected real answer, including edited question attachments', () => {
  const source = history(3);
  const result = normalizeLegacyHistory(source, { runs: { '1': { turns: [1, 3], active: 3 } }, replays: { '3': 1 },
    prompts: { '1': { text: 'edited old question', files: [] } }, answers: {}, hidden: {} });
  assert.deepEqual(messages(result.events), ['edited old question', 'A3', 'Q2', 'A2']);
  assert.deepEqual(contextTurns(result.events).map(t => t.turn), [1, 2]);
  assert.equal(result.turnMap['3'], 1);
  assert.deepEqual(result.events.map(e => e.seq), result.events.map((_, i) => i));
  assert.equal(source[2].data.content[0].text, 'Q1');
});

test('legacy text variants become native answer history without carrying discarded tool work', () => {
  const source = history(1);
  source[3].data.message.content.push({ type: 'tool-call', id: 'old-call', name: 'read', arguments: '{}' });
  const result = normalizeLegacyHistory(source, { answers: { '1': { active: 'variant', items: [{ id: 'variant', text: 'chosen text' }] } } });
  assert.deepEqual(messages(result.events), ['Q1', 'chosen text']);
  assert.equal(result.events.some(e => e.data?.message?.content?.some(b => b.type === 'tool-call')), false);
});

test('different question wording never shares an answer choice group', () => {
  const original = history(1);
  const edited = buildContextBranch(original, { sessionId: 'root', operation: 'edit-prompt', turn: 1, text: 'different question' });
  assert.notEqual(questionIdentity(original, 1).questionKey, questionIdentity(edited.seed, 1).questionKey);
});

test('migrating a legacy text choice resets the last tool step to the retained prompt step', () => {
  const source = history(1);
  source.splice(5, 0,
    { type: 'step/start', data: { turn: 1, step: 2 } },
    { ...structuredClone(source[3]), data: { turn: 1, step: 2,
      message: { id: 'last-answer', role: 'assistant', content: [{ type: 'text', text: 'tool conclusion' }],
        source: { kind: 'model', provider: 'p', model: 'm', replayState: { secretOldProviderState: true } } } } },
    { type: 'step/end', data: { turn: 1, step: 2 } });
  source.forEach((event, seq) => { event.seq = seq; });
  const result = normalizeLegacyHistory(source, { answers: { '1': {
    active: 'text-choice', items: [{ id: 'text-choice', text: 'replacement answer', provider: 'p', model: 'm' }],
  } } });
  const answer = result.events.find(event => event.type === 'assistant/message');
  assert.equal(answer.data.step, 1);
  assert.deepEqual(answer.data.message.source, { kind: 'model', provider: 'p', model: 'm' });
  assert.equal(result.events.at(-2).data.step, 1);
});
