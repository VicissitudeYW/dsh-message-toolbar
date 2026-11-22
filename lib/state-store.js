
import path from 'node:path';
import os from 'node:os';
import { createDurableState } from './durable-state.js';
import { inSessionRevision } from './in-session-context.js';
import { validCompactionId, validCompactionSource } from './context-compaction.js';

/**
 * Plugin-owned durable state, kept OUTSIDE session logs (which are
 * append-only). Main records:
 *
 *  - deleted: version cards the user removed in the UI, keyed by sessionId.
 *  - translations: cached translations, keyed by sessionId, event seq, language.
 *  - answers: legacy text alternatives and display edits, keyed by turn.
 *  - runs/replays/prompts/hidden: legacy display state, retained for migration.
 *  - context: the active paths of conversations edited with this toolbar.
 *  - navigation: durable, token-checked handoffs for previously created sessions.
 *
 * Background writes are debounced; successful mutations flush before HTTP ack.
 * Every flush takes a cross-process lock, merges against the newest state and
 * then uses an exclusive temp file + fsync + rename.
 */

const STATE_DIR = path.join(os.homedir(), '.dsh', 'message-toolbar');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SCHEMA = 1;

function emptyState() {
  return { schema: SCHEMA, deleted: {}, translations: {}, shown: {}, origins: {}, answers: {}, prompts: {}, hidden: {}, runs: {}, replays: {}, navigation: {}, migrations: {}, context: {} };
}

function stateObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是状态对象。`);
  return value;
}

function validateSessions(kind, sessions) {
  for (const [id, raw] of Object.entries(sessions)) {
    if (id === 'prototype' || Object.hasOwn(Object.prototype, id)) throw new Error(`${kind} 包含无效会话标识。`);
    const session = stateObject(raw, `${kind}.${id}`);
    if (kind === 'deleted') continue;
    if (kind === 'context') {
      if (typeof session.selection !== 'string' || !inSessionRevision(JSON.parse(session.selection))) {
        throw new Error(`context.${id} 的回答历史无效。`);
      }
      continue;
    }
    if (kind === 'navigation') {
      if (['token', 'root', 'source', 'target'].some(key => typeof session[key] !== 'string' || session[key].trim() === '')
        || session.root !== id || typeof session.completed !== 'boolean' || typeof session.archived !== 'boolean'
        || (session.cancelled !== undefined && typeof session.cancelled !== 'boolean')
        || (session.sourceArchived !== undefined && typeof session.sourceArchived !== 'boolean')) {
        throw new Error(`navigation.${id} 必须包含有效的导航标识、会话与完成状态。`);
      }
      continue;
    }
    if (kind === 'migrations') {
      if (typeof session.targetSessionId !== 'string' || session.targetSessionId.trim() === '' || session.targetSessionId === id
        || (session.sourceSeq !== undefined && (!Number.isSafeInteger(session.sourceSeq) || session.sourceSeq < -1))) {
        throw new Error(`migrations.${id} 必须包含有效的目标会话标识。`);
      }
      continue;
    }
    if (kind === 'hidden') {
      for (const key of ['turns', 'answers', 'prompts']) {
        if (session[key] !== undefined && (!Array.isArray(session[key])
          || session[key].some((turn) => !Number.isSafeInteger(turn) || turn < 1))) throw new Error(`hidden.${id}.${key} 必须是轮号数组。`);
      }
      continue;
    }
    for (const [key, value] of Object.entries(session)) {
      if (kind === 'shown' || kind === 'origins') {
        if (typeof value !== 'string') throw new Error(`${kind}.${id}.${key} 必须是字符串。`);
      } else if (kind === 'replays') {
        if (!Number.isSafeInteger(Number(key)) || Number(key) < 1 || !Number.isSafeInteger(value) || value < 1) throw new Error('replays 必须映射有效轮号。');
      } else {
        const slot = stateObject(value, `${kind}.${id}.${key}`);
        if (kind === 'translations') {
          for (const [lang, entry] of Object.entries(slot)) stateObject(entry, `translations.${id}.${key}.${lang}`);
        }
        if (kind === 'answers') {
          if (slot.items !== undefined && !Array.isArray(slot.items)) throw new Error('answers.items 必须是数组。');
          if (slot.override != null) stateObject(slot.override, 'answers.override');
        }
        if (kind === 'runs' && slot.turns !== undefined && !Array.isArray(slot.turns)) throw new Error('runs.turns 必须是数组。');
      }
    }
  }
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('状态必须是 JSON 对象。');
  if (raw.schema !== undefined && raw.schema !== SCHEMA) throw new Error(`不支持状态版本 ${raw.schema}。`);
  const state = emptyState();
  for (const key of Object.keys(state)) {
    if (key === 'schema' || raw[key] === undefined) continue;
    if (!raw[key] || typeof raw[key] !== 'object' || Array.isArray(raw[key])) {
      throw new Error(`${key} 必须是状态映射。`);
    }
    validateSessions(key, raw[key]);
    state[key] = raw[key];
  }
  // Group membership can disappear when only one answer remains, but the
  // surviving replay must still resolve to the question the reader edited.
  for (const [sessionId, groups] of Object.entries(state.runs)) {
    if (!groups || typeof groups !== 'object' || Array.isArray(groups)) continue;
    for (const [root, group] of Object.entries(groups)) {
      if (!Number.isSafeInteger(Number(root)) || !Array.isArray(group?.turns)) continue;
      for (const member of group.turns) {
        if (Number.isSafeInteger(member) && member !== Number(root)) rememberReplayIn(state, sessionId, Number(root), member);
      }
    }
  }
  return state;
}

const durable = createDurableState(STATE_FILE, { empty: emptyState, normalize, reconcile: reconcileMergedRuns });
export const readState = durable.read;
export const flushState = durable.flush;
/** Test/explicit recovery hook: discard the cache and pending writes. */
export const reloadState = durable.reload;
export const mutateState = durable.mutate;

const contextRevisions = new WeakMap();
export function contextFor(sessionId) {
  const entry = readState().context[sessionId];
  if (!entry) return undefined;
  if (!contextRevisions.has(entry)) contextRevisions.set(entry, JSON.parse(entry.selection));
  return contextRevisions.get(entry);
}

export function writeContext(sessionId, revision, clearTranslationTurn) {
  if (revision !== undefined && !inSessionRevision(revision)) throw new Error('无法保存工具栏的当前回答历史。');
  durable.commit(state => {
    // One atomic field keeps revision, nodes and active selection together
    // when the state store merges updates from independent profiles.
    if (revision === undefined) delete state.context[sessionId];
    else state.context[sessionId] = { selection: JSON.stringify(revision) };
    if (clearTranslationTurn !== undefined) clearTranslationIn(state, sessionId, clearTranslationTurn);
  });
  if (clearTranslationTurn !== undefined) cancelTranslation(sessionId, clearTranslationTurn);
}

// An older plugin in another profile can rewrite state.json without fields it
// doesn't know. Keep the proof separate so that cannot reclassify a summary.
const compactionState = createDurableState(path.join(STATE_DIR, 'compactions.json'), {
  empty: () => ({}),
  normalize(raw) {
    for (const [id, source] of Object.entries(stateObject(raw, 'compactions'))) {
      if (!validCompactionId(id) || !validCompactionSource(source)) throw new Error(`${id} 的摘要来源无效。`);
    }
    return raw;
  },
});
export const compactionSources = compactionState.read;

export function writeCompactionSource(id, source) {
  if (!validCompactionId(id) || !validCompactionSource(source)) throw new Error('无法保存工具栏的摘要来源。');
  compactionState.commit(state => { state[id] = source; });
}

export function navigationFor(rootId) { return readState().navigation[rootId]; }
export function pendingNavigationFor(sessionId) {
  return Object.values(readState().navigation).find(job => job.target === sessionId && job.completed !== true);
}
export function recordNavigation(rootId, job, removal) {
  durable.commit(state => {
    if (removal) {
      if (removal.requireAvailableTarget && Object.hasOwn(state.deleted, job.target)) {
        throw new Error('目标版本已不可打开，请先从版本树选择其他版本。');
      }
      state.deleted[removal.sessionId] = { parent: removal.parent, turn: removal.turn, at: Date.now() };
    }
    state.navigation[rootId] = { ...job };
  });
}

export function migrationFor(sourceSessionId) { return readState().migrations[sourceSessionId]; }

export function forgetMigration(sourceSessionId) {
  mutateState(state => { delete state.migrations[sourceSessionId]; });
}

/** Persist a legacy migration target and its view-only prompt visibility together. */
export function recordMigration(sourceSessionId, targetSessionId, hiddenPrompts = [], sourceSeq) {
  if (typeof sourceSessionId !== 'string' || sourceSessionId.trim() === ''
    || typeof targetSessionId !== 'string' || targetSessionId.trim() === '' || sourceSessionId === targetSessionId
    || (sourceSeq !== undefined && (!Number.isSafeInteger(sourceSeq) || sourceSeq < -1))
    || !Array.isArray(hiddenPrompts)
    || hiddenPrompts.some(turn => !Number.isSafeInteger(turn) || turn < 1)) {
    throw new TypeError('旧会话迁移记录无效。');
  }
  mutateState(state => {
    state.migrations[sourceSessionId] = { targetSessionId, ...(sourceSeq === undefined ? {} : { sourceSeq }) };
    if (hiddenPrompts.length === 0) return;
    const hidden = hiddenRecord(state, targetSessionId);
    hidden.prompts = [...new Set([...hidden.prompts, ...hiddenPrompts])].sort((a, b) => a - b);
  });
  return migrationFor(sourceSessionId);
}

process.once('exit', () => {
  try { flushState(); } catch (error) { console.error('[dsh-message-toolbar] unsaved state:', error.message); }
});

/* ------------------------------------------------------------------ API -- */

// Process-local controllers both cancel the provider and prevent a late response
// from resurrecting a translation after its answer or selection has changed.
const translationTasks = new Map();
const translationLookups = new Map();
const taskKey = (sessionId, turn) => `${sessionId}\u0000${turn}`;

// Some requests only name an event. Keep arrival order while asynchronous reads
// resolve those events to the same turn, even if a newer request already finished.
export function reserveTranslation(sessionId) {
  let lookups = translationLookups.get(sessionId);
  if (lookups === undefined) {
    lookups = { order: 0, pending: 0, latestByTurn: new Map() };
    translationLookups.set(sessionId, lookups);
  }
  lookups.pending++;
  return {
    order: ++lookups.order,
    release() {
      if (--lookups.pending === 0) translationLookups.delete(sessionId);
    },
  };
}

export function beginTranslation(sessionId, turn, order) {
  const lookups = translationLookups.get(sessionId);
  if (lookups !== undefined) {
    const requested = order ?? ++lookups.order;
    if (requested < (lookups.latestByTurn.get(turn) ?? 0)) {
      throw new Error('回答或翻译选择已改变，旧翻译已取消。');
    }
    lookups.latestByTurn.set(turn, requested);
  }
  const key = taskKey(sessionId, turn);
  const previous = translationTasks.get(key);
  const token = new AbortController();
  translationTasks.set(key, token);
  previous?.abort();
  return token;
}
export function currentTranslation(sessionId, turn, token) {
  return translationTasks.get(taskKey(sessionId, turn)) === token;
}
export function cancelTranslation(sessionId, turn) {
  const lookups = translationLookups.get(sessionId);
  if (lookups !== undefined) lookups.latestByTurn.set(turn, ++lookups.order);
  const key = taskKey(sessionId, turn);
  const token = translationTasks.get(key);
  translationTasks.delete(key);
  token?.abort();
}
export function finishTranslation(sessionId, turn, token) {
  if (currentTranslation(sessionId, turn, token)) translationTasks.delete(taskKey(sessionId, turn));
}

export function deletedVersionIds() {
  return new Set(Object.keys(readState().deleted));
}

export function markDeleted(sessionId, info) {
  mutateState((state) => {
    state.deleted[sessionId] = { ...(info ?? {}), at: Date.now() };
  });
}

export function unmarkDeleted(sessionId) {
  durable.commit(state => {
    delete state.deleted[sessionId];
  });
}

/** translations[sessionId][eventSeq][lang] = { text, provider, model, turn, role, at } */
export function translationFor(sessionId, seq, lang) {
  return readState().translations[sessionId]?.[String(seq)]?.[lang];
}

export function storeTranslation(sessionId, seq, lang, value) {
  mutateState((state) => {
    const session = state.translations[sessionId] ?? (state.translations[sessionId] = {});
    const seqMap = session[String(seq)] ?? (session[String(seq)] = {});
    seqMap[lang] = { ...value, at: Date.now() };
  });
}

/** All translations of one session: { eventSeq: { lang: entry } } */
export function translationsForSession(sessionId) {
  return readState().translations[sessionId] ?? {};
}

/**
 * shown[sessionId][turn] = <lang>: which translation is on screen for that turn.
 * A translation is drawn beside the answer, not instead of it, so the reader also
 * needs the original: `origins[sessionId][turn]` remembers the text that was on
 * screen when the translation was asked for. That matters when the answer on
 * screen is not the logged one (a variant or an edit), because the log cannot
 * tell us what the reader was looking at.
 */
export function shownForSession(sessionId) {
  return readState().shown[sessionId] ?? {};
}

export function originTextsForSession(sessionId) {
  return readState().origins[sessionId] ?? {};
}

export function setShown(sessionId, turn, lang, origin) {
  mutateState((state) => {
    const session = state.shown[sessionId] ?? (state.shown[sessionId] = {});
    const key = String(turn);
    if (typeof lang === 'string' && lang.length > 0) {
      session[key] = lang;
      const origins = state.origins[sessionId] ?? (state.origins[sessionId] = {});
      if (typeof origin === 'string' && origin.length > 0) origins[key] = origin;
      else delete origins[key];
      if (Object.keys(origins).length === 0) delete state.origins[sessionId];
    } else {
      delete session[key];
      const origins = state.origins[sessionId];
      if (origins !== undefined) {
        delete origins[key];
        if (Object.keys(origins).length === 0) delete state.origins[sessionId];
      }
    }
    if (Object.keys(session).length === 0) delete state.shown[sessionId];
  });
  return shownForSession(sessionId);
}

/**
 * The answer on screen changed — another variant, a rewrite, a deletion — so any
 * translation of it describes text that is no longer there. Forget the turn's
 * "shown" flag and its cached translation, otherwise the reader is served an old
 * translation beside a new answer.
 */
export function clearTranslationForTurn(sessionId, turn) {
  cancelTranslation(sessionId, turn);
  mutateState(state => clearTranslationIn(state, sessionId, turn));
}

function clearTranslationIn(state, sessionId, turn) {
  for (const [map, key] of [[state.shown, String(turn)], [state.origins, String(turn)], [state.translations, `turn:${turn}`]]) {
    const entries = map[sessionId];
    if (entries === undefined) continue;
    delete entries[key];
    if (Object.keys(entries).length === 0) delete map[sessionId];
  }
}

/* ------------------------------------------------- answer alternatives -- */

/**
 * answers[sessionId][turn] = {
 *   active: 'native' | <item id>,
 *   items: [{ id, kind: 'model' | 'edit', provider?, model?, name?, text, at }],
 * }
 */

function answerSlot(state, sessionId, turn) {
  const session = state.answers[sessionId] ?? (state.answers[sessionId] = {});
  const key = String(turn);
  return session[key] ?? (session[key] = { active: 'native', items: [] });
}

/** Every alternative-answer record of one session, keyed by turn. */
export function answersForSession(sessionId) {
  return readState().answers[sessionId] ?? {};
}

/** One turn's record: { active, items } or undefined. */
export function answerEntry(sessionId, turn) {
  return readState().answers[sessionId]?.[String(turn)];
}

/** Append one alternative and make it the visible answer. */
export function storeAnswer(sessionId, turn, item) {
  mutateState((state) => {
    const slot = answerSlot(state, sessionId, turn);
    slot.items.push(item);
    slot.active = item.id;
  });
  return answerEntry(sessionId, turn);
}

/**
 * Rewrite one alternative in place. Saving an edit does not add a second answer:
 * the reader edited what was on screen, so that is what changes.
 */
export function updateAnswer(sessionId, turn, id, text) {
  mutateState((state) => {
    const slot = answerSlot(state, sessionId, turn);
    const item = slot.items.find((entry) => entry.id === id);
    if (!item) throw new TypeError('找不到这个回答备选。');
    item.text = text;
    item.edited = true;
    item.at = Date.now();
  });
  return answerEntry(sessionId, turn);
}

/**
 * Overwrite the logged answer for display. The session log cannot be rewritten,
 * so the edit rides along as this override: no alternative is added, therefore
 * the ring keeps saying `1/1` and stays out of the way, and clearing the override
 * gives the model's own text back.
 */
export function setAnswerOverride(sessionId, turn, text) {
  mutateState((state) => {
    const slot = answerSlot(state, sessionId, turn);
    slot.override = { text, at: Date.now() };
  });
  return answerEntry(sessionId, turn);
}

/** Drop the override, so the logged answer shows again. */
export function clearAnswerOverride(sessionId, turn) {
  mutateState((state) => {
    const slot = answerSlot(state, sessionId, turn);
    delete slot.override;
  });
  return answerEntry(sessionId, turn);
}

/**
 * Rewrite the question for display. Same trade as an answer override: the log
 * keeps the text that was actually sent, this only changes what the row shows —
 * and, because a later regenerate replays the prompt, what the next answer is
 * asked. Nothing is regenerated by saving an edit.
 */
export function setPromptOverride(sessionId, turn, text, files) {
  mutateState((state) => {
    const slot = promptSlot(state, sessionId);
    const key = String(turn);
    const previous = slot[key] === undefined ? {} : slot[key];
    // `files` left out means "only the wording changed": the attachments the
    // reader added earlier stay exactly where they were.
    const kept = files === undefined ? previous.files : files;
    slot[key] = {
      ...previous,
      text,
      at: Date.now(),
      ...Array.isArray(kept) && kept.length > 0 ? { files: kept } : {},
    };
    if (!Array.isArray(kept) || kept.length === 0) delete slot[key].files;
  });
  return promptOverridesForSession(sessionId);
}

/**
 * The attachments dropped into one question, in the order the reader added them.
 *
 * They live here rather than in the log because the row that shows them is the
 * row this plugin draws: the replayed prompt does carry them into the log, but a
 * question that was edited and not re-sent has no log entry to read them from.
 */
export function promptFiles(sessionId, turn) {
  const entry = promptOverridesForSession(sessionId)[String(turn)];
  return entry !== undefined && Array.isArray(entry.files) ? entry.files.slice() : [];
}

/** Replace the attachment list of one question, keeping its wording. */
export function setPromptFiles(sessionId, turn, files) {
  mutateState((state) => {
    const slot = promptSlot(state, sessionId);
    const key = String(turn);
    const previous = slot[key] === undefined ? {} : slot[key];
    const next = { ...previous };
    if (Array.isArray(files) && files.length > 0) next.files = files;
    else delete next.files;
    // An entry with neither wording nor attachments is no entry at all: a bare
    // `{at}` would read back as an empty override in the tree payload.
    if (typeof next.text !== 'string' && next.files === undefined) delete slot[key];
    else slot[key] = { ...next, at: Date.now() };
  });
  return promptOverridesForSession(sessionId);
}

function promptSlot(state, sessionId) {
  if (!state.prompts[sessionId] || typeof state.prompts[sessionId] !== 'object') state.prompts[sessionId] = {};
  return state.prompts[sessionId];
}

/** Drop the question override, so the text that was sent shows again. */
export function clearPromptOverride(sessionId, turn) {
  mutateState((state) => {
    const slot = state.prompts[sessionId];
    if (!slot || typeof slot !== 'object') return;
    const key = String(turn);
    const previous = slot[key];
    if (previous === undefined) return;
    // Dropping the wording must not drop the attachments the reader added: they
    // are what the row above the bubble is drawn from.
    const next = { ...previous };
    delete next.text;
    if (next.files === undefined) delete slot[key];
    else slot[key] = next;
  });
  return promptOverridesForSession(sessionId);
}

export function promptOverridesForSession(sessionId) {
  const slot = readState().prompts[sessionId];
  return slot && typeof slot === 'object' ? slot : {};
}

export function promptOverrideFor(sessionId, turn) {
  const entry = promptOverridesForSession(sessionId)[String(turn)];
  return entry && typeof entry === 'object' && typeof entry.text === 'string' ? entry : null;
}

/** Show `id`, or 'native' to fall back to the logged answer. */
export function selectAnswer(sessionId, turn, id) {
  mutateState((state) => {
    const slot = answerSlot(state, sessionId, turn);
    if (id === 'native') {
      slot.active = 'native';
      return;
    }
    if (!slot.items.some((item) => item.id === id)) throw new TypeError('找不到这个回答备选。');
    slot.active = id;
  });
  return answerEntry(sessionId, turn);
}

/**
 * Drop one alternative. When it was the visible one, the answer just before it
 * in the ring takes over — the one the reader was looking at one click earlier —
 * so deleting the second of three answers lands on the first instead of jumping
 * all the way back to the logged one.
 */
export function removeAnswer(sessionId, turn, id) {
  mutateState((state) => {
    const slot = answerSlot(state, sessionId, turn);
    const order = ['native', ...slot.items.map((item) => item.id)];
    const at = order.indexOf(id);
    if (at < 0) throw new TypeError('找不到这个回答备选。');
    slot.items = slot.items.filter((item) => item.id !== id);
    if (slot.active === id) {
      const previous = order[at - 1] ?? 'native';
      slot.active = previous === 'native' || slot.items.some((item) => item.id === previous)
        ? previous
        : 'native';
    }
  });
  return answerEntry(sessionId, turn);
}

/* ---------------------------------------------------- hidden transcript -- */

/**
 * hidden[sessionId] = { turns: number[], answers: number[], prompts: number[] }
 *
 * `turns` hides a whole turn (user message, answer, tool cards), `answers`
 * hides only the assistant answer of a turn, and `prompts` hides the user row
 * of a turn whose prompt was replayed to get a real answer (the answer itself
 * stays). All are view-only: the session log keeps every event, so nothing the
 * model later reads changes.
 */

function hiddenRecord(state, sessionId) {
  const entry = state.hidden[sessionId] ?? (state.hidden[sessionId] = { turns: [], answers: [], prompts: [] });
  if (!Array.isArray(entry.turns)) entry.turns = [];
  if (!Array.isArray(entry.answers)) entry.answers = [];
  if (!Array.isArray(entry.prompts)) entry.prompts = [];
  return entry;
}

/** One session's hidden turns, answers and replayed prompts. */
export function hiddenForSession(sessionId) {
  const entry = readState().hidden[sessionId];
  return {
    turns: Array.isArray(entry?.turns) ? entry.turns.slice() : [],
    answers: Array.isArray(entry?.answers) ? entry.answers.slice() : [],
    prompts: Array.isArray(entry?.prompts) ? entry.prompts.slice() : [],
  };
}

/** Hide or restore one turn / one answer / one replayed prompt. */
export function setHidden(sessionId, scope, turn, hidden) {
  const list = scope === 'answer' ? 'answers' : scope === 'prompt' ? 'prompts' : 'turns';
  mutateState((state) => {
    const record = hiddenRecord(state, sessionId);
    const rest = record[list].filter((value) => value !== turn);
    record[list] = hidden ? [...rest, turn].sort((a, b) => a - b) : rest;
  });
  return hiddenForSession(sessionId);
}

/* ------------------------------------------------------------- answer runs -- */
//
// Answering a question again is a real agent turn appended to the same session,
// so the log ends up holding several turns that answer one question: the first
// one, then one per regenerate / model switch. They are alternatives of the same
// answer, and this is the only place that knows it — the log cannot say so.
//
// `runs[sessionId][turn]` groups them: `turns` lists the turn numbers in the
// order they were produced (the original first), `active` names the one on
// screen, and `models[<turn>]` remembers which model produced it so the ring can
// label an answer even after the session moved on to another model.

function runsRecord(state, sessionId) {
  const entry = state.runs[sessionId] ?? (state.runs[sessionId] = {});
  return entry;
}

function rememberReplayIn(state, sessionId, root, added) {
  const session = state.replays[sessionId] ?? (state.replays[sessionId] = {});
  if (added !== root) session[String(added)] = root;
}

/** Keep question identity independently of the optional multi-answer ring. */
export function rememberReplay(sessionId, root, added) {
  mutateState((state) => rememberReplayIn(state, sessionId, root, added));
}

function normalizeGroup(raw, fallbackTurn) {
  const group = { active: fallbackTurn, turns: [fallbackTurn], models: {} };
  if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.turns)) {
      const seen = new Set();
      const turns = [];
      for (const value of raw.turns) {
        if (!Number.isSafeInteger(value) || value < 1 || seen.has(value)) continue;
        seen.add(value);
        turns.push(value);
      }
      if (turns.length > 0) group.turns = turns.sort((a, b) => a - b);
    }
    if (typeof raw.active === 'number' && group.turns.includes(raw.active)) group.active = raw.active;
    else group.active = group.turns[group.turns.length - 1];
    if (raw.models && typeof raw.models === 'object') group.models = { ...raw.models };
  }
  return group;
}

/** Restore run invariants after generic deltas have merged concurrent edits. */
function reconcileMergedRuns(state) {
  for (const [sessionId, groups] of Object.entries(state.runs)) {
    const flags = state.hidden[sessionId];
    const gone = new Set([...(flags?.turns ?? []), ...(flags?.answers ?? [])]);
    const history = state.replays[sessionId] ?? {};
    // Only repair groups that survived the merge. Replay identity alone must
    // never recreate a deliberately dropped group.
    for (const key of Object.keys(groups)) {
      const root = Number(key);
      if (!Number.isSafeInteger(root) || root < 1) continue;
      const group = normalizeGroup(groups[key], root);
      group.turns = [...new Set([
        root, ...group.turns,
        ...Object.keys(history).filter((member) => history[member] === root).map(Number),
      ])].filter((turn) => !gone.has(turn)).sort((a, b) => a - b);
      if (group.turns.length <= 1) {
        delete groups[key];
        continue;
      }
      if (!group.turns.includes(group.active)) group.active = group.turns[group.turns.length - 1];
      for (const turn of Object.keys(group.models)) {
        if (!group.turns.includes(Number(turn))) delete group.models[turn];
      }
      groups[key] = group;
    }
  }
  return state;
}


/** Every answer group of one session, keyed by the turn the question was asked in. */
export function runsForSession(sessionId) {
  const entry = readState().runs[sessionId];
  if (entry === undefined || entry === null || typeof entry !== 'object') return {};
  const out = {};
  for (const key of Object.keys(entry)) {
    const turn = Number(key);
    if (!Number.isInteger(turn)) continue;
    out[key] = normalizeGroup(entry[key], turn);
  }
  return out;
}

/**
 * Record one more turn that answers an existing question, and show it.
 *
 * @param sessionId - session the question lives in.
 * @param turn - turn the question was asked in (the group key).
 * @param added - turn number of the fresh answer.
 * @param model - provider/model that produced it, when one was chosen.
 */
export function recordRun(sessionId, turn, added, model) {
  let group;
  mutateState((state) => {
    const entry = runsRecord(state, sessionId);
    const key = String(turn);
    group = normalizeGroup(entry[key], turn);
    rememberReplayIn(state, sessionId, turn, added);
    const hidden = hiddenRecord(state, sessionId);
    const gone = new Set([...hidden.turns, ...hidden.answers]);
    const history = state.replays[sessionId] ?? {};
    group.turns = [...new Set([
      ...group.turns,
      ...Object.keys(history).filter((member) => history[member] === turn).map(Number),
    ])].filter((member) => !gone.has(member));
    if (!group.turns.includes(added)) group.turns.push(added);
    group.turns.sort((a, b) => a - b);
    group.active = added;
    if (model !== undefined && model !== null) {
      group.models[String(added)] = { provider: model.provider, model: model.model };
    }
    entry[key] = group;
  });
  return group;
}

/**
 * The turn a question was asked in, given any answer of it.
 *
 * Answering again can be asked for from any answer on screen — including one
 * produced by an earlier regenerate — and all of them belong to the same group,
 * keyed by the turn that holds the question.
 */
export function runKeyFor(sessionId, turn) {
  const remembered = readState().replays[sessionId]?.[String(turn)];
  if (Number.isSafeInteger(remembered)) return remembered;
  const groups = runsForSession(sessionId);
  const keys = Object.keys(groups);
  for (const key of keys) {
    if (groups[key].turns.includes(turn)) return Number(key);
  }
  return turn;
}

/** Replay identity survives a run group shrinking to a single visible answer. */
export function replaysForSession(sessionId) {
  return { ...(readState().replays[sessionId] ?? {}) };
}

/** Every real turn belonging to a logical question, including deleted members. */
export function questionTurns(sessionId, turn) {
  const root = runKeyFor(sessionId, turn);
  const members = new Set([root, turn]);
  for (const [member, owner] of Object.entries(replaysForSession(sessionId))) {
    if (owner === root && Number.isSafeInteger(Number(member)) && Number(member) > 0) members.add(Number(member));
  }
  for (const member of runsForSession(sessionId)[String(root)]?.turns ?? []) members.add(member);
  return [...members].sort((a, b) => a - b);
}

/** Show another answer of the same question. */
export function selectRun(sessionId, turn, active) {
  let group;
  mutateState((state) => {
    const entry = runsRecord(state, sessionId);
    const key = String(turn);
    if (!Object.hasOwn(entry, key)) throw new TypeError('找不到这个回答组。');
    group = normalizeGroup(entry[key], turn);
    if (!group.turns.includes(active)) throw new TypeError('找不到这个回答。');
    group.active = active;
    entry[key] = group;
  });
  return group;
}

/** Forget a group whose answers no longer exist (the question was deleted). */
export function dropRun(sessionId, turn) {
  mutateState((state) => {
    const entry = runsRecord(state, sessionId);
    delete entry[String(turn)];
  });
}

/**
 * Take one answer out of its group, because the reader deleted it.
 *
 * Deleting an answer is a view decision — the log keeps that turn — so the group
 * has to forget the member as well. Leaving it in `turns` is exactly what kept
 * the ring counting a deleted answer and kept `run-select` switching back to it.
 * A group down to one answer is no group at all: it is dropped, so the survivor
 * becomes a plain turn and the ring disappears.
 *
 * @returns {{ runs: object, group: object|null }} the session's remaining groups
 *   and the group the answer belonged to, or null when nothing was left of it.
 */
export function removeRunMember(sessionId, turn) {
  let group = null;
  let found = false;
  mutateState((state) => {
    const entry = runsRecord(state, sessionId);
    const keys = Object.keys(entry);
    for (const key of keys) {
      const candidate = normalizeGroup(entry[key], Number(key));
      if (!candidate.turns.includes(turn)) continue;
      found = true;
      const at = candidate.turns.indexOf(turn);
      const remaining = candidate.turns.filter(function (value) { return value !== turn; });
      delete candidate.models[String(turn)];
      if (remaining.length <= 1) {
        delete entry[key];
        group = null;
        return;
      }
      candidate.turns = remaining;
      if (!remaining.includes(candidate.active)) {
        // The answer on screen was the one deleted: step back to the answer
        // before it, which is where the ring's "previous" would have gone.
        const before = at > 0 ? candidate.turns[at - 1] : undefined;
        candidate.active = before !== undefined ? before : remaining[remaining.length - 1];
      }
      entry[key] = candidate;
      group = candidate;
      return;
    }
  });
  return { runs: runsForSession(sessionId), group, found };
}

/**
 * Drop deleted answers from the groups that still count them.
 *
 * Deletions are view flags, so a group can outlive the answers it lists — most
 * visibly when the failed answers of one question were deleted one by one from
 * the bottom up. `active` could then name a turn nobody can see any more, and
 * the group's *surviving* card stands down (`return null`) for every turn that
 * is not the active one, so that answer lost its toolbar while its rows were
 * still on screen. Deleting now repairs the group at the same time; this heals
 * state written before that, every time the client asks for the payload.
 *
 * @returns {boolean} whether anything had to change.
 */
export function reconcileRuns(sessionId) {
  const current = readState();
  const listed = current.runs[sessionId];
  if (!listed || typeof listed !== 'object') return false;
  const flags = hiddenRecord(current, sessionId);
  const gone = new Set([...flags.turns, ...flags.answers]);
  if (gone.size === 0) return false;
  const stale = Object.keys(listed).some((key) =>
    normalizeGroup(listed[key], Number(key)).turns.some((turn) => gone.has(turn)));
  // Nothing stale means nothing to write: the payload is read on every refresh,
  // and a save per read would keep rewriting the file for no reason.
  if (!stale) return false;
  let changed = false;
  mutateState((state) => {
    const entry = state.runs[sessionId];
    if (!entry || typeof entry !== 'object') return;
    const marked = hiddenRecord(state, sessionId);
    const deleted = new Set([...marked.turns, ...marked.answers]);
    for (const key of Object.keys(entry)) {
      const group = normalizeGroup(entry[key], Number(key));
      const alive = group.turns.filter((turn) => !deleted.has(turn));
      if (alive.length === group.turns.length) continue;
      changed = true;
      for (const turn of group.turns) {
        if (!alive.includes(turn)) delete group.models[String(turn)];
      }
      // A group down to one answer is no group at all: the survivor becomes a
      // plain turn whose card is always on screen.
      if (alive.length <= 1) {
        delete entry[key];
        continue;
      }
      group.turns = alive;
      if (!alive.includes(group.active)) group.active = alive[alive.length - 1];
      entry[key] = group;
    }
  });
  return changed;
}

