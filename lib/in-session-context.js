import { isDeepStrictEqual } from 'node:util';
import { contextTurns, hasLegacyContext } from './context-history.js';

const nativeId = turn => `turn-${turn}`;
const isTurn = turn => Number.isSafeInteger(turn) && turn > 0;
const isId = id => typeof id === 'string' && /^[\w-]{1,120}$/.test(id);
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;

/** Validate stored references before the same history can drive a model request. */
export function inSessionRevision(state) {
  const dictionary = value => value && typeof value === 'object' && !Array.isArray(value);
  if (state?.version !== 1 || !Number.isSafeInteger(state.through) || state.through < 0
    || !dictionary(state.nodes) || !dictionary(state.tails) || !Array.isArray(state.removed)) return false;
  const { nodes, head, pending } = state;
  const hasNode = id => isId(id) && own(nodes, id) !== undefined;
  const parent = id => id === null || hasNode(id);
  return parent(head) && state.removed.every(hasNode) && Object.entries(nodes).every(([id, node]) =>
    isId(id) && dictionary(node) && isTurn(node.turn) && isTurn(node.group) && parent(node.parent)
    && (node.prompt === undefined || Array.isArray(node.prompt))
    && (node.answer === undefined || node.answer === null || typeof node.answer === 'string')
    && (node.hidePrompt === undefined || typeof node.hidePrompt === 'boolean')
    && (node.textOnly === undefined || typeof node.textOnly === 'boolean'))
    && Object.entries(state.tails).every(([id, tail]) => hasNode(id) && hasNode(tail))
    && (pending === null || (dictionary(pending) && isId(pending.messageId) && isTurn(pending.group) && parent(pending.parent)));
}

function pathTo(nodes, head) {
  const path = [], seen = new Set();
  for (let id = head; id !== null;) {
    const node = own(nodes, id);
    if (node === undefined || seen.has(id)) throw new Error('无法读取工具栏的当前回答历史。');
    path.push({ id, ...node });
    seen.add(id);
    id = node.parent;
  }
  return path.reverse();
}

function initialRevision(turns, legacy) {
  const state = { version: 1, through: 0, nodes: {}, head: null, tails: {}, removed: [], pending: null };
  const hiddenPrompts = new Set(legacy.hidden?.prompts);
  if (!hasLegacyContext(legacy) && hiddenPrompts.size === 0) return state;

  const byTurn = new Map(turns.map(turn => [turn.turn, turn]));
  const hiddenTurns = new Set(legacy.hidden?.turns), hiddenAnswers = new Set(legacy.hidden?.answers);
  const replayMembers = new Set();
  for (const [group, run] of Object.entries(legacy.runs ?? {})) {
    if (!byTurn.has(Number(group))) continue;
    for (const turn of run?.turns ?? []) if (turn !== Number(group)) replayMembers.add(turn);
  }
  for (const question of turns) {
    const group = question.turn;
    state.through = group;
    const deletedReplay = legacy.replays?.[group] !== undefined && hiddenAnswers.has(group) && hiddenPrompts.has(group);
    if (replayMembers.has(group) || hiddenTurns.has(group) || deletedReplay) continue;
    if (question.user === undefined) {
      const id = nativeId(group);
      state.nodes[id] = { turn: group, group, parent: state.head };
      state.head = id;
      continue;
    }
    const run = legacy.runs?.[group];
    const candidates = [group, ...(run?.turns ?? [])];
    const parent = state.head;
    const prompt = legacy.prompts?.[group];
    const content = prompt && (typeof prompt.text === 'string' || Array.isArray(prompt.files))
      ? promptWith(question.user.data.content, prompt.text, prompt.files) : question.user.data.content;
    let active, fallback;
    for (const member of new Set(candidates)) {
      const current = byTurn.get(member);
      if (!current?.user || hiddenTurns.has(member)) continue;
      const native = nativeId(member);
      const slot = legacy.answers?.[member] ?? legacy.answers?.[group];
      const model = run?.models?.[member];
      const common = { turn: member, group, parent,
        ...(run === undefined && hiddenPrompts.has(member) ? { hidePrompt: true } : {}),
        ...(isDeepStrictEqual(content, current.user.data.content) ? {} : { prompt: content }) };
      state.nodes[native] = { ...common,
        ...(typeof model?.model === 'string' ? { model: model.model } : {}),
        ...(typeof model?.provider === 'string' ? { provider: model.provider } : {}),
        ...(hiddenAnswers.has(member) ? { answer: null } :
          typeof slot?.override?.text === 'string' ? { answer: slot.override.text } : {}) };
      let selected = native;
      for (const [index, item] of (slot?.items ?? []).entries()) {
        if (typeof item?.text !== 'string') continue;
        const id = `${native}-legacy-${index}`;
        state.nodes[id] = { ...common, answer: item.text, textOnly: true,
          ...(typeof item.model === 'string' ? { model: item.model } : {}),
          ...(typeof item.provider === 'string' ? { provider: item.provider } : {}) };
        if (slot.active === item.id) selected = id;
      }
      fallback ??= selected;
      if (member === (run?.active ?? group)) active = selected;
    }
    state.head = active ?? fallback ?? state.head;
  }
  return state;
}

export function promptWith(original, text, files) {
  if (text === undefined && files === undefined) return original;
  const attachment = block => block.type === 'image' || block.type === 'file';
  return [
    ...(text === undefined ? original.filter(block => block.type === 'text') : text ? [{ type: 'text', text }] : []),
    ...original.filter(block => block.type !== 'text' && !attachment(block)),
    ...(files ?? original.filter(attachment)),
  ];
}

function hasAnswerContent(turn) {
  return turn.answers.some(({ data }) => data.message?.content?.some(block => {
    if (block.type === 'text' || block.type === 'reasoning') return Boolean(block.text?.trim());
    return true;
  }));
}

/** Extend the saved choice using admitted prompts and their actual turn outcomes. */
export function inSessionView(events, saved, legacy = {}, { includeOpenRetry = false } = {}) {
  const turns = contextTurns(events, { includeUnprompted: true });
  const state = saved === undefined ? initialRevision(turns, legacy) : {
    ...saved, nodes: { ...saved.nodes }, tails: { ...saved.tails }, removed: [...saved.removed],
  };
  for (const turn of turns) {
    if (turn.turn <= state.through) continue;
    const id = nativeId(turn.turn);
    const retry = state.pending && turn.user?.data.id === state.pending.messageId ? state.pending : undefined;
    state.through = turn.turn;
    if (retry) {
      state.pending = null;
      // Only the live tail can be previewed. A stopped or failed retry leaves
      // both the previous selection and its later turns intact on replay.
      if (turn.end === undefined) {
        if (!includeOpenRetry || turn !== turns.at(-1)) continue;
      } else if (turn.end.data.reason?.kind !== 'completed' || !hasAnswerContent(turn)) continue;
    }
    state.nodes[id] = { turn: turn.turn, group: retry?.group ?? turn.turn,
      parent: retry === undefined ? state.head : retry.parent,
      ...(retry?.model ? { model: retry.model.model, provider: retry.model.provider } : {}) };
    state.head = id;
  }
  const replays = legacy.replays ?? {};
  if (Object.keys(replays).length > 0) {
    const deleted = new Set(legacy.hidden?.turns?.filter(turn => questionRoot(replays, turn) === turn));
    if (state.removed.length > 0) {
      const removed = new Set(state.removed);
      const remainingGroups = new Set(Object.entries(state.nodes).filter(([id]) => !removed.has(id)).map(([, node]) => node.group));
      // Older selections used `removed` for both one answer and an entire question.
      for (const id of removed) {
        const { group } = state.nodes[id];
        if (!remainingGroups.has(group)) deleted.add(questionRoot(replays, group));
      }
    }
    if (deleted.size > 0) removeQuestions(state, node => deleted.has(questionRoot(replays, node.group)));
  }
  const path = pathTo(state.nodes, state.head);
  return { state, path, turns, replays, modified: saved !== undefined || hasLegacyContext(legacy) };
}

export function selectPath(view, turn, id) {
  const { path, state } = view;
  const current = path.find(node => node.turn === turn);
  const picked = own(state.nodes, id);
  if (!current || !picked || current.group !== picked.group || state.removed.includes(id) || picked.answer === null) {
    throw new TypeError('这个回答已不可选，请刷新后重试。');
  }
  if (current.id === id) return;
  rememberContinuation(view);
  const tail = own(state.tails, id);
  const continuation = tail ? pathTo(state.nodes, tail) : [];
  state.head = continuation.some(node => node.id === id)
    && continuation.every(node => !state.removed.includes(node.id)) ? tail : id;
}

export function rememberContinuation({ path, state }) {
  for (const node of path) state.tails[node.id] = state.head;
  state.pending = null;
}

export function editTurn({ state }, node, changes) {
  // This version keeps its identity so its later questions and their
  // alternate answers still point to it.
  state.nodes[node.id] = { ...state.nodes[node.id], ...changes };
  state.pending = null;
}

function questionRoot(replays, group) {
  // Every replay was appended after the turn it answers. Ignore stale or
  // malformed forward references rather than conflating unrelated questions.
  let parent;
  while (isTurn(parent = own(replays, group)) && parent < group) group = parent;
  return group;
}

export function deleteQuestion({ state, replays }, node) {
  const root = questionRoot(replays, node.group);
  removeQuestions(state, candidate => questionRoot(replays, candidate.group) === root);
  state.pending = null;
}

function removeQuestions(state, includes) {
  const nodes = Object.entries(state.nodes);
  const deleted = new Set(nodes.filter(([, node]) => includes(node)).map(([id]) => id));
  const nearestParent = start => {
    const seen = new Set();
    let id = start;
    while (deleted.has(id)) {
      if (seen.has(id)) throw new Error('无法读取工具栏的当前回答历史。');
      seen.add(id);
      id = state.nodes[id].parent;
    }
    return id;
  };
  // Keep every unrelated continuation, including tails on inactive paths.
  for (const [id, candidate] of nodes) {
    if (!deleted.has(id) && deleted.has(candidate.parent)) {
      state.nodes[id] = { ...candidate, parent: nearestParent(candidate.parent) };
    }
  }
  state.removed = [...new Set([...state.removed, ...deleted])];
  state.head = nearestParent(state.head);
  for (const [id, tail] of Object.entries(state.tails)) {
    const kept = nearestParent(tail);
    if (deleted.has(id) || kept === null) delete state.tails[id];
    else state.tails[id] = kept;
  }
}

function assistantEdit(message, text, textOnly) {
  const { replayState: _replayState, ...source } = message?.source ?? { kind: 'model', provider: '', model: '' };
  const content = textOnly ? [] : message.content.filter(block => block.type !== 'text');
  return { ...message, role: 'assistant', source, content: [...content, { type: 'text', text }] };
}

function textOf(message) {
  return (message?.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n');
}

export function inSessionDisplay(view, sessionId) {
  const turnOrder = view.path.map(node => node.turn);
  const contextOrder = turnOrder.some((turn, index) => index > 0 && turn < turnOrder[index - 1]) ? turnOrder : undefined;
  const active = new Set(turnOrder);
  const byTurn = new Map(view.turns.map(turn => [turn.turn, turn]));
  const gone = new Set(view.state.removed);
  const hidden = { turns: view.turns.filter(turn => !active.has(turn.turn)).map(turn => turn.turn), answers: [], prompts: [] };
  const answers = {}, prompts = {}, contextChoices = {}, promptAttachments = {};
  const groups = new Map();
  for (const [id, node] of Object.entries(view.state.nodes)) {
    const turn = byTurn.get(node.turn);
    if (!turn?.user || gone.has(id) || node.answer === null) continue;
    const model = turn.answers.at(-1)?.data.message?.source;
    const preview = node.answer ?? textOf(turn.answers.at(-1)?.data.message);
    if (!groups.has(node.group)) groups.set(node.group, []);
    groups.get(node.group).push({ id, turn: node.turn, sessionId, preview: preview.slice(0, 120),
      model: node.model ?? model?.model, provider: node.provider ?? model?.provider });
  }
  for (const node of view.path) {
    const turn = byTurn.get(node.turn);
    if (!turn?.user) continue;
    const content = node.prompt ?? turn.user.data.content;
    const files = content.filter(block => block.type === 'file' || block.type === 'image');
    promptAttachments[node.turn] = files;
    if (node.prompt) prompts[node.turn] = { text: textOf({ content }), files };
    if (node.hidePrompt) hidden.prompts.push(node.turn);
    if (node.answer === null) hidden.answers.push(node.turn);
    if (typeof node.answer === 'string') answers[node.turn] = { active: 'native', items: [], override: { text: node.answer } };
    contextChoices[node.turn] = { active: node.id, items: groups.get(node.group) ?? [] };
  }
  return { hidden, answers, prompts, contextChoices, promptAttachments, contextOrder };
}

/** Select only the current answer path, using DSH's immutable render of each event. */
export function projectModelHistory(session, events, view) {
  const history = [];
  const project = event => session.deriveEventMessage(event);
  const push = (event, message = project(event), sourceSeq = event.seq) => {
    if (message != null) history.push({ seq: event.seq, sourceSeq, message, unchanged: message === project(event) });
  };
  const surface = session.surface.nodes;
  // The native system head is always first. An in-history update from an
  // inactive turn is omitted below. Keep the current effective instructions.
  const systemHead = events[surface[0]]?.type === 'system/message' ? events[surface[0]] : undefined;
  const originalHead = events.find(event => event.type === 'system/message' && event.surfaceOp === 'append');
  if (systemHead) push(systemHead);

  const allTurns = new Map(view.turns.map(turn => [turn.turn, turn]));
  const firstTurn = events.find(event => event.type === 'turn/start')?.seq ?? events.length;
  const systemUpdate = event => event.type === 'system/message' && event !== originalHead && event !== systemHead;
  const ordinaryUser = event => event.type === 'user/message' && event.data.source?.kind !== 'compact-checkpoint';
  for (const event of events.slice(0, firstTurn)) {
    if (event.surfaceOp === 'append' && (ordinaryUser(event) || systemUpdate(event))) push(event);
  }
  const replacements = new Map();
  const covered = new Map();
  for (const event of events) {
    const op = event.surfaceOp;
    if (op?.op !== 'replace') continue;
    if (event.type === 'tool/result' && op.startSeq === op.endSeq) {
      const original = covered.get(op.startSeq) ?? op.startSeq;
      replacements.set(original, event);
      covered.set(event.seq, original);
    }
  }
  for (const node of view.path) {
    const turn = allTurns.get(node.turn);
    if (!turn) throw new Error('工具栏当前回答引用了缺失的会话消息。');
    const final = turn.answers.at(-1);
    for (const event of turn.events) {
      if (event.surfaceOp !== 'append') continue;
      if (ordinaryUser(event)) {
        push(event, event === turn.user && node.prompt !== undefined ? { ...project(event), content: node.prompt } : project(event));
      } else if (systemUpdate(event) || (event.type === 'developer/message' && node.answer !== null && !node.textOnly)) {
        push(event);
      } else if (event.type === 'assistant/message' && node.answer !== null && !node.textOnly) {
        if (event === final && typeof node.answer === 'string') push(event, assistantEdit(project(event) ?? event.data.message, node.answer, false));
        else push(event);
      } else if (event.type === 'tool/result' && node.answer !== null && !node.textOnly) {
        push(replacements.get(event.seq) ?? event, undefined, event.seq);
      }
    }
    if (typeof node.answer === 'string' && (node.textOnly || final === undefined)) {
      const message = final?.data.message ?? { id: `${node.id}-assistant`, source: { kind: 'model', provider: '', model: '' } };
      if (final) push(final, assistantEdit(message, node.answer, true));
      else history.push({ seq: -1, message: assistantEdit(message, node.answer, true), unchanged: false });
    }
  }
  return history;
}
