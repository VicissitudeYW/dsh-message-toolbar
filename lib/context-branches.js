import crypto from 'node:crypto';

const VERSION_MARKERS = new Set(['message-toolbar/version', 'message-tree/version']);
let lastMarkerTime = 0;

function clone(value) { return structuredClone(value); }

export function hasLegacyContext(legacy) {
  return ['runs', 'replays', 'prompts', 'answers'].some(key => Object.keys(legacy[key] ?? {}).length > 0)
    || ['turns', 'answers'].some(key => (legacy.hidden?.[key] ?? []).length > 0);
}
export function normalizeLegacyHistory(events, legacy = {}) {
  if (!hasLegacyContext(legacy)) return { events: clone(events), turnMap: {} };
  if (events.some(event => typeof event.surfaceOp === 'object')) {
    throw new Error('旧显示状态涉及已经压缩或替换的历史，无法安全迁移；请先打开压缩前的版本。');
  }
  const turns = contextTurns(events);
  const byTurn = new Map(turns.map(turn => [turn.turn, turn]));
  const turnMap = { ...legacy.replays };
  for (const [root, group] of Object.entries(legacy.runs ?? {})) {
    for (const member of group.turns ?? []) if (member !== Number(root)) turnMap[String(member)] = Number(root);
  }
  const goneTurns = new Set(legacy.hidden?.turns ?? []), goneAnswers = new Set(legacy.hidden?.answers ?? []);
  const out = [];
  const push = event => out.push(clone(event));
  if (turns.length) events.slice(0, turns[0].startSeq).forEach(push);
  for (let index = 0; index < turns.length; index++) {
    const original = turns[index];
    if (turnMap[String(original.turn)] !== undefined) continue;
    if (goneTurns.has(original.turn)) break;
    const group = legacy.runs?.[String(original.turn)];
    const selected = group?.active ?? original.turn;
    const source = byTurn.get(selected) ?? original;
    if (source.endSeq === undefined) throw new Error('请等待旧回答完成后再迁移上下文。');
    let segment = clone(events.slice(source.startSeq, source.endSeq + 1));
    for (const event of segment) if (event.data?.turn === source.turn) event.data.turn = original.turn;
    const user = segment.find(event => event.type === 'user/message' && event.data?.source?.kind === 'user');
    if (!user) throw new Error('旧回答缺少原始问题，无法安全迁移。');
    user.data = clone(original.user.data);
    delete user.sourceEventSeqs;
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
      const template = segment.findLast(event => event.type === 'assistant/message');
      if (!template) throw new Error('旧文本备选缺少原生回答模板，无法安全迁移。');
      const answer = clone(template);
      answer.data.message = { ...answer.data.message, id: variant.id,
        content: [{ type: 'text', text: variant.text }],
        source: { kind: 'model', provider: variant.provider ?? 'unknown', model: variant.model ?? 'unknown' } };
      answer.data.stream = [];
      delete answer.sourceEventSeqs;
      segment = segment.slice(0, segment.indexOf(user) + 1);
      answer.data.step = segment.findLast(event => event.type === 'step/start')?.data.step ?? 1;
      segment.push(answer, ...closePromptOnlyTurn(segment, original.turn));
    } else if (typeof slot?.override?.text === 'string') {
      const answer = segment.findLast(event => event.type === 'assistant/message');
      if (answer) { answer.data.message = replaceText(answer.data.message, slot.override.text); answer.data.stream = []; }
    }
    segment.forEach(push);
    // Non-turn metadata belongs to the original position, never to the replay
    // position (whose queued prompt is explicitly cleared at child setup).
    const nextStart = turns[index + 1]?.startSeq ?? events.length;
    events.slice(original.endSeq + 1, nextStart).forEach(push);
  }
  const seqMap = new Map(out.map((event, seq) => [event.seq, seq]).filter(([old]) => Number.isSafeInteger(old)));
  out.forEach((event, seq) => {
    event.seq = seq;
    if (event.sourceEventSeqs !== undefined) {
      event.sourceEventSeqs = event.sourceEventSeqs.map(old => {
        const next = seqMap.get(old);
        if (next === undefined || next >= seq) throw new Error('旧历史存在跨回答的事件引用，无法安全迁移。');
        return next;
      });
    }
  });
  return { events: out, turnMap };
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

export function questionIdentity(events, turn, context = contextFrom(events)) {
  const target = contextTurns(events).find(candidate => candidate.turn === turn);
  if (!target) return undefined;
  const previous = context[String(turn)];
  const questionId = previous?.questionId ?? target.user.data.id;
  const prefix = events.slice(0, target.startSeq).filter(event =>
    ['user/message', 'assistant/message', 'tool/result', 'developer/message', 'system/message'].includes(event.type))
    .map(event => ({ type: event.type, data: event.data.message ?? event.data, surfaceOp: event.surfaceOp }));
  const prefixHash = crypto.createHash('sha256').update(JSON.stringify({ prefix, question: target.user.data.content })).digest('hex');
  return { questionId, questionKey: `${questionId}:${prefixHash}`,
    answerId: target.answers.length === 0 ? null
      : previous && Object.hasOwn(previous, 'answerId') ? previous.answerId : target.answers.at(-1)?.data.message.id ?? null };
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
  if (sourceEvents.some(event => typeof event.surfaceOp === 'object'
    && event.surfaceOp.startSeq <= target.user.seq && event.surfaceOp.endSeq >= target.user.seq)) {
    throw new Error('所选问题已经被压缩或替换，请从压缩前的版本操作。');
  }

  const childId = `session-${crypto.randomUUID()}`;
  const context = contextFrom(sourceEvents);
  const previous = context[String(target.turn)] ?? {};
  const questionId = previous.questionId ?? target.user.data.id ?? crypto.randomUUID();
  let answerId;
  let boundary;
  let queuedUser;
  let tail = [];
  const copied = clone(sourceEvents);
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
  const identity = questionIdentity(sourceEvents, target.turn, contextFrom(sourceEvents));
  markerEvents(copied, operation.sessionId, target, context, {
    ...operation, ...(operation.operation === 'delete-answer' ? { deletedAnswer: identity } : {}),
  }, childId, operation.operation === 'delete-question' ? identity : undefined);
  return { sessionId: childId, seed: copied, inheritedEventCount: copied.length, tail, turn: target.turn, queuedUser,
    operation: operation.operation, questionId, answerId, context, boundary };
}
