
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Plugin-owned durable state, kept OUTSIDE session logs (which are
 * append-only). Three records live here:
 *
 *  - deleted: version cards the user removed in the UI, keyed by sessionId.
 *  - translations: cached translations, keyed by sessionId, event seq, language.
 *  - answers: in-session answer alternatives, keyed by sessionId and turn.
 *    A session log cannot gain a second answer for a closed turn (the session
 *    invariants forbid it), so an alternative answer — another model's reply,
 *    or the user's own rewrite — lives here and the client substitutes it for
 *    the native answer in place, inside the same conversation.
 *  - hidden: turns or answers the user deleted from the transcript view.
 *    Deleting cannot rewrite the log, so the client hides those rows and
 *    offers an inline restore; the model's context is not affected.
 *
 * Writes are debounced and atomic (write temp file, rename over).
 */

const STATE_DIR = path.join(os.homedir(), '.dsh', 'message-toolbar');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SCHEMA = 1;

let cache;
let timer;

function emptyState() {
  return { schema: SCHEMA, deleted: {}, translations: {}, shown: {}, origins: {}, answers: {}, hidden: {} };
}

function normalize(raw) {
  const state = emptyState();
  if (raw && typeof raw === 'object') {
    if (raw.deleted && typeof raw.deleted === 'object') state.deleted = raw.deleted;
    if (raw.translations && typeof raw.translations === 'object') state.translations = raw.translations;
    if (raw.shown && typeof raw.shown === 'object') state.shown = raw.shown;
  if (raw.origins && typeof raw.origins === 'object') state.origins = raw.origins;
    if (raw.answers && typeof raw.answers === 'object') state.answers = raw.answers;
    if (raw.hidden && typeof raw.hidden === 'object') state.hidden = raw.hidden;
  }
  return state;
}

export function readState() {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
  } catch {
    cache = emptyState();
  }
  return cache;
}

function persist() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    // State is a convenience layer; never fail an operation on it.
    console.error('[dsh-message-toolbar] failed to persist state:', error);
  }
}

export function flushState() {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
    persist();
  }
}

/**
 * Test hook: forget the in-memory cache (and any pending write) so the next
 * read observes whatever the state file currently holds.
 */
export function reloadState() {
  if (timer !== undefined) {
    clearTimeout(timer);
    timer = undefined;
  }
  cache = undefined;
}

export function mutateState(mutator) {
  const state = readState();
  mutator(state);
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    persist();
  }, 200);
  return state;
}

/* ------------------------------------------------------------------ API -- */

export function deletedVersionIds() {
  return new Set(Object.keys(readState().deleted));
}

export function markDeleted(sessionId, info) {
  mutateState((state) => {
    state.deleted[sessionId] = { ...(info ?? {}), at: Date.now() };
  });
}

export function unmarkDeleted(sessionId) {
  mutateState((state) => {
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
