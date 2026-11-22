import crypto from 'node:crypto';
import { rebuildLegacyProjection } from './legacy-projection.js';

const VERSION_MARKERS = new Set(['message-toolbar/version', 'message-tree/version']);
const IDENTITY_MESSAGE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result', 'developer/message', 'system/message']);
let lastMarkerTime = 0;

function clone(value) { return structuredClone(value); }

export function hasLegacyContext(legacy) {
  return ['runs', 'replays', 'prompts', 'answers'].some(key => Object.keys(legacy[key] ?? {}).length > 0)
    || ['turns', 'answers'].some(key => Array.isArray(legacy.hidden?.[key]) && legacy.hidden[key].length > 0);
}
export function normalizeLegacyHistory(events, legacy = {}) {
  if (!hasLegacyContext(legacy)) return { events: clone(events), turnMap: {}, displayTurns: {},
    hiddenPrompts: [...new Set(legacy.hidden?.prompts ?? [])] };
  const turns = contextTurns(events);
  const byTurn = new Map(turns.map(turn => [turn.turn, turn]));
  const folded = new Map();
  for (const [root, group] of Object.entries(legacy.runs ?? {})) {
    for (const member of group.turns ?? []) if (member !== Number(root)) folded.set(member, Number(root));
  }
  const goneTurns = new Set(legacy.hidden?.turns ?? []), goneAnswers = new Set(legacy.hidden?.answers ?? []);
  const hiddenPromptTurns = new Set(legacy.hidden?.prompts ?? []);
  // Keep the source sequence beside each copied event. Legacy selection can
  // copy a different real turn into the original slot, so array position is
  // not enough to decide whether a replacement summary still describes the
  // copied history.
  const out = [];
  const push = (event, sourceSeq = event.seq) => out.push({ event: clone(event), sourceSeq });
  events.slice(0, turns[0]?.startSeq ?? events.length).forEach(event => push(event));
  for (let index = 0; index < turns.length; index++) {
    const original = turns[index];
    const copyGap = () => {
      if (original.endSeq !== undefined) {
        events.slice(original.endSeq + 1, turns[index + 1]?.startSeq ?? events.length).forEach(event => push(event));
      }
    };
    // Replay ownership outlives the group. A lone survivor was still shown at
    // its own turn, sometimes with only its duplicate prompt hidden.
    const hiddenReplay = legacy.replays?.[original.turn] !== undefined
      && goneAnswers.has(original.turn) && hiddenPromptTurns.has(original.turn);
    if (folded.has(original.turn) || goneTurns.has(original.turn) || hiddenReplay) {
      // Old hide removed a card, not the rest of the visible conversation.
      // Inter-turn entries still belong here, including manual compactions.
      copyGap();
      continue;
    }
    const group = legacy.runs?.[String(original.turn)];
    const selected = group?.active ?? original.turn;
    const source = byTurn.get(selected) ?? original;
    if (source.endSeq === undefined) throw new Error('请等待旧回答完成后再迁移上下文。');
    let segment = clone(events.slice(source.startSeq, source.endSeq + 1));
    for (const event of segment) {
      if (event.data?.turn === source.turn && source.turn !== original.turn) event.data.turn = original.turn;
    }
    const user = segment.find(event => event.type === 'user/message' && event.data?.source?.kind === 'user');
    if (!user) throw new Error('旧回答缺少原始问题，无法安全迁移。');
    user.data = clone(original.user.data);
    if (source.turn !== original.turn) delete user.sourceEventSeqs;
    const prompt = legacy.prompts?.[String(original.turn)];
    if (typeof prompt?.text === 'string') user.data = replaceText(user.data, prompt.text);
    if (Array.isArray(prompt?.files)) user.data.content = [
      ...user.data.content.filter(block => block.type === 'text'), ...clone(prompt.files),
    ];
    const slot = legacy.answers?.[String(selected)] ?? legacy.answers?.[String(original.turn)];
    const variant = slot?.items?.find(item => item.id === slot.active);
    if (goneAnswers.has(selected) && !variant) {
      segment = segment.slice(0, segment.indexOf(user) + 1);
      segment.push(...closePromptOnlyTurn(segment, original.turn));
    } else if (variant) {
      segment = segment.slice(0, segment.indexOf(user) + 1);
      const lastStep = segment.findLast(event => event.type === 'step/start' || event.type === 'step/end');
      const step = lastStep?.type === 'step/start' ? lastStep.data.step : (lastStep?.data.step ?? 0) + 1;
      const time = user.time ?? source.user.time ?? Date.now();
      if (lastStep?.type !== 'step/start') segment.push({ type: 'step/start', time, data: { turn: original.turn, step } });
      const message = { id: variant.id, role: 'assistant',
        content: [{ type: 'text', text: variant.text }],
        source: { kind: 'model', provider: variant.provider ?? 'unknown', model: variant.model ?? 'unknown' } };
      segment.push({ type: 'assistant/message', surfaceOp: 'append', time,
        data: { turn: original.turn, step, message, stream: [] } });
      segment.push(...closePromptOnlyTurn(segment, original.turn));
    } else if (typeof slot?.override?.text === 'string') {
      const answer = segment.findLast(event => event.type === 'assistant/message');
      if (answer) { answer.data.message = replaceText(answer.data.message, slot.override.text); answer.data.stream = []; }
    }
    segment.forEach(event => push(event, event.seq));
    // Non-turn metadata belongs to the original position, never to the replay
    // position (whose queued prompt is explicitly cleared at child setup).
    copyGap();
  }

  const systemHead = events.find(event => event.type === 'system/message' && event.surfaceOp === 'append');
  if (systemHead && !out.some(record => record.sourceSeq === systemHead.seq)) {
    // The first native turn contributed the protected system head. A later
    // replay doesn't append it again; restore it before any visible messages.
    const firstSurface = out.findIndex(({ event }) => event.surfaceOp === 'append');
    if (firstSurface >= 0) out.splice(firstSurface, 0, { event: clone(systemHead), sourceSeq: systemHead.seq });
  }
  const result = rebuildLegacyProjection(events, out);
  // Native V4 counts every real turn, including turns with no human message.
  // The marker's context uses the same turn numbers as the seed.
  const displayTurns = {}, nativeTurns = new Map();
  for (const event of result) {
    if (event.type !== 'turn/start') continue;
    const native = nativeTurns.size + 1;
    nativeTurns.set(event.data.turn, native);
    displayTurns[native] = event.data.turn;
  }
  for (const { type, data } of result) {
    if (data?.turn > 0 && nativeTurns.has(data.turn)) data.turn = nativeTurns.get(data.turn);
    if (VERSION_MARKERS.has(type)) {
      if (data.context) data.context = Object.fromEntries(Object.entries(data.context)
        .filter(([turn]) => nativeTurns.has(Number(turn))).map(([turn, value]) => [nativeTurns.get(Number(turn)), value]));
      if (nativeTurns.has(data.effect?.targetTurn)) data.effect.targetTurn = nativeTurns.get(data.effect.targetTurn);
    }
  }
  const turnMap = Object.fromEntries([...nativeTurns].filter(([old, next]) => old !== next));
  for (const [member, root] of folded) if (nativeTurns.has(root)) turnMap[member] = nativeTurns.get(root);
  const normalizedTurns = new Set(contextTurns(result).map(turn => turn.turn));
  const hiddenPrompts = [...hiddenPromptTurns].map(turn => nativeTurns.get(turn)).filter(turn => normalizedTurns.has(turn));
  return { events: result, turnMap, displayTurns, hiddenPrompts };
}

export function contextTurns(events) {
  const turns = [];
  let current;
  for (const event of events) {
    if (event.type === 'turn/start') {
      current = { turn: event.data.turn, startSeq: event.seq, events: [], answers: [] };
      turns.push(current);
      continue;
    }
    if (current === undefined) continue;
    current.events.push(event);
    if (event.type === 'user/message' && current.user === undefined && event.data?.source?.kind === 'user') current.user = event;
    if (event.type === 'assistant/message' && event.data?.turn === current.turn
      && (event.surfaceOp === undefined || event.surfaceOp === 'append')) current.answers.push(event);
    if (event.type === 'turn/end' && event.data?.turn === current.turn) current.endSeq = event.seq;
  }
  return turns.filter(turn => turn.user !== undefined);
}

function messageText(message) {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

function replaceText(message, text) {
  const content = [];
  let replaced = false;
  for (const block of message.content ?? []) {
    if (block.type !== 'text') { content.push(clone(block)); continue; }
    if (!replaced) { content.push({ ...clone(block), text }); replaced = true; }
  }
  if (!replaced && text.length > 0) content.unshift({ type: 'text', text });
  const result = { ...clone(message), content };
  // Opaque provider replay data may still contain the old assistant text.
  // Providers must reconstruct edited messages from their visible blocks.
  if (result.source?.kind === 'model') delete result.source.replayState;
  return result;
}

function closePromptOnlyTurn(events, turn) {
  let openTurn;
  let openStep;
  for (const event of events) {
    if (event.type === 'turn/start') { openTurn = event.data.turn; openStep = undefined; }
    if (event.type === 'step/start') openStep = event.data.step;
    if (event.type === 'step/end') openStep = undefined;
    if (event.type === 'turn/end') { openTurn = undefined; openStep = undefined; }
  }
  if (openTurn === undefined) return [];
  if (openTurn !== turn) throw new Error('拒绝闭合非目标回合。');
  const time = events.at(-1)?.time ?? Date.now();
  const tail = [];
  if (openStep !== undefined) tail.push({ type: 'step/end', time, data: { turn, step: openStep } });
  tail.push({ type: 'turn/end', time, data: { turn, reason: { kind: 'forked' } } });
  return tail;
}

export function contextFrom(events) {
  const context = {};
  for (const event of events) {
    if (VERSION_MARKERS.has(event.type) && event.data?.context && typeof event.data.context === 'object') {
      // Each marker contains a complete snapshot; merging would resurrect
      // identities deliberately dropped by a delete or a rewind.
      for (const key of Object.keys(context)) delete context[key];
      for (const [key, value] of Object.entries(event.data.context)) {
        if (/^[1-9]\d*$/.test(key)) context[key] = clone(value);
      }
    }
  }
  return context;
}

export function contextIdentities(events, turns = contextTurns(events), context = contextFrom(events)) {
  // Produce the same JSON hash as { prefix, question }, reusing the digest
  // state so long histories don't serialize the full prefix for each turn.
  const prefix = crypto.createHash('sha256').update('{"prefix":[');
  let cursor = 0, separator = '';
  return turns.map(target => {
    while (cursor < target.startSeq) {
      const { type, data, surfaceOp } = events[cursor++];
      if (!IDENTITY_MESSAGE_TYPES.has(type)) continue;
      prefix.update(separator).update(JSON.stringify({ type, data: data.message ?? data, surfaceOp }));
      separator = ',';
    }
    const previous = context[String(target.turn)];
    const questionId = previous?.questionId ?? target.user.data.id;
    const question = JSON.stringify(target.user.data.content);
    const prefixHash = prefix.copy().update(question === undefined ? ']}' : `],"question":${question}}`).digest('hex');
    return { questionId, questionKey: `${questionId}:${prefixHash}`,
      answerId: target.answers.length === 0 ? null
        : previous && Object.hasOwn(previous, 'answerId') ? previous.answerId : target.answers.at(-1)?.data.message.id ?? null };
  });
}

export function questionIdentity(events, turn, context = contextFrom(events)) {
  const target = contextTurns(events).find(candidate => candidate.turn === turn);
  return target && contextIdentities(events, [target], context)[0];
}

function truncateContext(context, turn) {
  for (const key of Object.keys(context)) if (Number(key) >= turn) delete context[key];
}

function setContext(context, turn, value) { context[String(turn)] = value; }

function targetEvent(events, target) {
  const event = events.find(candidate => candidate.seq === target.seq && candidate.type === target.type);
  if (event === undefined) throw new Error('无法在分支副本中定位目标事件。');
  return event;
}

function markerEvents(events, sourceId, target, context, operation, childId, sourceIdentity) {
  const lastEventTime = events.reduce((latest, event) => Number.isFinite(event.time) ? Math.max(latest, event.time) : latest, 0);
  const time = lastMarkerTime = Math.max(Date.now(), lastEventTime + 1, lastMarkerTime + 1);
  events.push({
    type: 'message-toolbar/version',
    seq: events.length,
    time,
    ignorable: true,
    data: {
      sessionId: childId,
      schemaVersion: 2,
      effect: {
        id: crypto.randomUUID(),
        operation: operation.operation,
        targetTurn: target.turn,
        targetEventSeq: target.user.seq,
        questionId: sourceIdentity?.questionId ?? context[String(target.turn)]?.questionId ?? null,
        answerId: sourceIdentity?.answerId ?? context[String(target.turn)]?.answerId ?? null,
        ...operation.text === undefined ? {} : { after: operation.text },
        ...operation.model === undefined ? {} : { model: clone(operation.model) },
      },
      inverse: { kind: 'restore-version', sessionId: sourceId },
      context: clone(context),
      ...(operation.operation === 'delete-answer' ? { deletedAnswer: operation.deletedAnswer } : {}),
    },
  });
}

/** Build a public `agents.create({seed})` payload; source events remain immutable. */
export function buildContextBranch(sourceEvents, operation) {
  if (!Array.isArray(sourceEvents) || !operation || typeof operation.operation !== 'string'
    || !Number.isSafeInteger(operation.turn) || operation.turn < 1) {
    throw new TypeError('上下文分支参数无效。');
  }
  const turns = contextTurns(sourceEvents);
  if (operation.operation === 'adopt-all') {
    if (turns.some(turn => turn.endSeq === undefined)) throw new Error('请等待当前回答结束后再同步上下文。');
    const sessionId = `session-${crypto.randomUUID()}`, seed = clone(sourceEvents);
    const context = contextFrom(sourceEvents);
    const target = turns.at(-1) ?? { turn: 1, user: { seq: -1 } };
    markerEvents(seed, operation.sessionId, target, context, operation, sessionId);
    return { sessionId, seed, inheritedEventCount: seed.length, tail: [], turn: target.turn };
  }
  const target = turns.find(turn => turn.turn === operation.turn);
  if (target?.user === undefined) throw new TypeError(`第 ${operation.turn} 轮没有可分支的问题。`);

  const childId = `session-${crypto.randomUUID()}`;
  const context = contextFrom(sourceEvents);
  const previous = context[String(target.turn)] ?? {};
  const questionId = previous.questionId ?? target.user.data.id ?? crypto.randomUUID();
  let answerId;
  let boundary;
  let queuedUser;
  let tail = [];
  // Later compaction cannot affect a historical fork: its events are past the
  // cut. Revalidate projections inside the fork when a message changes.
  let copied = clone(sourceEvents);
  const copiedTurn = contextTurns(copied).find(turn => turn.turn === target.turn);
  if (copiedTurn === undefined) throw new Error('复制目标回合失败。');

  if (operation.operation === 'retry') {
    boundary = copiedTurn.startSeq - 1;
    const question = messageText(copiedTurn.user.data);
    const text = typeof operation.text === 'string' ? operation.text : previous.questionText ?? question;
    const originalFiles = copiedTurn.user.data.content.filter(block => block.type === 'file' || block.type === 'image');
    const files = Array.isArray(operation.files) ? clone(operation.files) : originalFiles;
    const content = [...(text.length > 0 ? [{ type: 'text', text }] : []), ...files];
    queuedUser = { id: crypto.randomUUID(), role: 'user', source: { kind: 'user' }, content };
    truncateContext(context, target.turn);
    answerId = crypto.randomUUID();
    setContext(context, target.turn, { questionId, answerId, questionText: text });
  } else if (operation.operation === 'edit-prompt' || operation.operation === 'adopt') {
    if (!Number.isSafeInteger(copiedTurn.endSeq)) throw new Error('无法保存尚未完成的问题。');
    boundary = copiedTurn.endSeq;
    const event = targetEvent(copied, copiedTurn.user);
    if (operation.operation === 'edit-prompt') event.data = replaceText(event.data, typeof operation.text === 'string' ? operation.text : '');
    if (Array.isArray(operation.files)) {
      const texts = event.data.content.filter(block => block.type === 'text');
      event.data = { ...event.data, content: [...texts, ...clone(operation.files)] };
    }
    answerId = previous.answerId ?? copiedTurn.answers.at(-1)?.data.message.id ?? null;
    truncateContext(context, target.turn);
    setContext(context, target.turn, { ...previous, questionId, answerId, questionText: messageText(event.data) });
  } else if (operation.operation === 'edit-answer') {
    if (!Number.isSafeInteger(copiedTurn.endSeq)) throw new Error('无法编辑尚未完成的回答。');
    const answer = copiedTurn.answers.at(-1);
    if (answer === undefined) throw new Error('所选轮次没有已落定的回答。');
    boundary = copiedTurn.endSeq;
    const event = targetEvent(copied, answer);
    event.data = { ...event.data, message: replaceText(event.data.message, operation.text), stream: [] };
    answerId = previous.answerId ?? event.data.message.id;
    truncateContext(context, target.turn);
    setContext(context, target.turn, { ...previous, questionId, answerId, answerText: operation.text });
  } else if (operation.operation === 'delete-answer') {
    boundary = copiedTurn.user.seq;
    copied.splice(boundary + 1);
    tail = closePromptOnlyTurn(copied, target.turn);
    answerId = null;
    truncateContext(context, target.turn);
    setContext(context, target.turn, { questionId, answerId: null });
  } else if (operation.operation === 'delete-question') {
    boundary = copiedTurn.startSeq - 1;
    copied.splice(boundary + 1);
    truncateContext(context, target.turn);
    answerId = null;
  } else {
    throw new TypeError(`不支持的上下文操作：${operation.operation}`);
  }

  if (operation.operation !== 'delete-answer') copied.splice(boundary + 1);
  if (!Number.isSafeInteger(boundary) || boundary < -1) throw new Error('无法构造连续的历史边界。');
  if (copied.some((event, index) => event.seq !== index)) throw new Error('分支前缀的事件序号不连续。');
  const editsSurface = operation.operation === 'edit-prompt' || operation.operation === 'edit-answer'
    || (operation.operation === 'adopt' && Array.isArray(operation.files));
  if (editsSurface && copied.some(event => event.surfaceOp?.op === 'replace' || event.type === 'image/offload')) {
    copied = rebuildLegacyProjection(sourceEvents.slice(0, boundary + 1), copied.map(event => ({ event, sourceSeq: event.seq })));
  }
  const identity = questionIdentity(sourceEvents, target.turn, contextFrom(sourceEvents));
  markerEvents(copied, operation.sessionId, target, context, {
    ...operation, ...(operation.operation === 'delete-answer' ? { deletedAnswer: identity } : {}),
  }, childId, operation.operation === 'delete-question' ? identity : undefined);
  return { sessionId: childId, seed: copied, inheritedEventCount: copied.length, tail, turn: target.turn, queuedUser,
    operation: operation.operation, questionId, answerId, context, boundary };
}
