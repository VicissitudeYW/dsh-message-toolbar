
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Plugin-owned durable state, kept OUTSIDE session logs (which are
 * append-only). Two records live here:
 *
 *  - deleted: version cards the user removed in the UI, keyed by sessionId.
 *  - translations: cached translations, keyed by sessionId, event seq, language.
 *
 * Writes are debounced and atomic (write temp file, rename over).
 */

const STATE_DIR = path.join(os.homedir(), '.dsh', 'message-toolbar');
const STATE_FILE = path.join(STATE_DIR, 'state.json');
const SCHEMA = 1;

let cache;
let timer;

function emptyState() {
  return { schema: SCHEMA, deleted: {}, translations: {} };
}

function normalize(raw) {
  const state = emptyState();
  if (raw && typeof raw === 'object') {
    if (raw.deleted && typeof raw.deleted === 'object') state.deleted = raw.deleted;
    if (raw.translations && typeof raw.translations === 'object') state.translations = raw.translations;
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
