window.__ModuleLoader__.load({
  id: 'dsh-message-toolbar',
  factory: (require) => {
    const React = require('react');
    const styles = {
      insert(css) {
        if (typeof document === 'undefined') return function () {};
        const prev = document.querySelector('style[data-plugin="dsh-message-toolbar"]');
        if (prev) {
          prev.textContent = css;
          return function () { prev.remove(); };
        }
        const tag = document.createElement('style');
        tag.dataset.plugin = 'dsh-message-toolbar';
        tag.textContent = css;
        document.head.appendChild(tag);
        return function () { tag.remove(); };
      }
    };
    return (function () {

// dsh-message-toolbar — client half.
//
// - Replaces the plain user bubble with an editable one: hover actions
//   (copy / edit / regenerate / delete), a version ring (‹ 2/3 ›) and a true
//   rewind-branch editor.
// - Adds an assistant action row: regenerate, switch model (keeping a
//   per-model answer card), translate (bilingual) and delete.
// - Renders translations as an in-flow bilingual card under the answer
//   (conversation.chat.turnTail).
// - Adds a Versions view listing the whole branch family with model chips
//   and restore controls.
//
// There is deliberately no settings panel: translating asks for the target
// language in the same dropdown the model picker uses, at the moment you press
// the button, so nothing has to be configured up front.

const ROUTE = '/message-toolbar';
const VIEW_ORDER = 17;
const PREFS_KEY = 'dsh-message-toolbar:prefs';
const I18N_NS = 'dsh-message-toolbar';

const LANGS = [
  { id: 'zh', label: '简体中文' },
  { id: 'zh-TW', label: '繁體中文' },
  { id: 'en', label: 'English' },
  { id: 'ja', label: '日本語' },
  { id: 'ko', label: '한국어' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'es', label: 'Español' },
  { id: 'ru', label: 'Русский' },
];

const DEFAULT_PREFS = {
  // The last target language picked, so the menu can tick it next time.
  lang: 'zh',
  stopPrevious: true,
};

function realGlobal() {
  try { if (typeof window !== 'undefined' && window) return window; } catch (e) {}
  try { if (typeof globalThis !== 'undefined' && globalThis) return globalThis; } catch (e) {}
  return null;
}

/* ----------------------------------------------------------------- prefs -- */

const prefsStore = {
  value: null,
  listeners: [],

  read() {
    if (this.value) return this.value;
    const g = realGlobal();
    let stored = null;
    try {
      const raw = g && g.localStorage && g.localStorage.getItem(PREFS_KEY);
      if (raw) stored = JSON.parse(raw);
    } catch (e) {}
    this.value = Object.assign({}, DEFAULT_PREFS, stored || {});
    return this.value;
  },

  get() {
    return this.read();
  },

  set(patch) {
    this.value = Object.assign({}, this.read(), patch);
    const g = realGlobal();
    try {
      if (g && g.localStorage) g.localStorage.setItem(PREFS_KEY, JSON.stringify(this.value));
    } catch (e) {}
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) {}
    }
  },

  subscribe(fn) {
    const listeners = this.listeners;
    listeners.push(fn);
    return function () {
      const at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  },
};

function usePrefs() {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return prefsStore.subscribe(force); }, []);
  return prefsStore.get();
}

/* ----------------------------------------------------------- toolbar store -- */

const MAX_CACHED = 200;

const store = {
  bySession: new Map(),
  inflight: new Map(),
  listeners: [],
  /** Answers being written right now: `${sessionId}|${turn}` → { text, ... }. */
  live: new Map(),
  /**
   * Translations being written right now: `${sessionId}|${turn}` → { lang, text }.
   * A translation can stream while nothing else about the turn changes, so it gets
   * its own cell instead of sharing the answer's.
   */
  liveTranslations: new Map(),
  /** Answers being edited in place: `${sessionId}|${turn}` → the editor's cell. */
  edits: new Map(),
  /**
   * Bumped on every notification. The turn rail memoizes its patched snapshot
   * per (chat snapshot, rail version), so one counter is enough to invalidate
   * every memo that depended on this store.
   */
  railVersion: 0,

  get(sessionId) {
    if (!sessionId) return null;
    return this.bySession.get(sessionId) || null;
  },

  notify() {
    this.railVersion += 1;
    for (let i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) {}
    }
  },

  subscribe(fn) {
    const listeners = this.listeners;
    listeners.push(fn);
    return function () {
      const at = listeners.indexOf(fn);
      if (at !== -1) listeners.splice(at, 1);
    };
  },

  _prune() {
    while (this.bySession.size > MAX_CACHED) {
      const oldestKey = this.bySession.keys().next().value;
      this.bySession.delete(oldestKey);
    }
  },

  set(sessionId, state, timestamp) {
    const updatedAt = typeof timestamp === 'number' ? timestamp : Date.now();
    const existing = this.bySession.get(sessionId);
    if (existing && (existing.updatedAt || 0) > updatedAt) return;
    this.bySession.set(sessionId, { state: state, loading: false, error: null, updatedAt: updatedAt });
    this._prune();
    this.notify();
  },

  /** Merge one translation into the cached payload without a round trip. */
  patchTranslation(sessionId, seq, lang, value) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state) return;
    const translations = entry.state.translations || (entry.state.translations = {});
    const seqMap = translations[String(seq)] || (translations[String(seq)] = {});
    seqMap[lang] = value;
    entry.updatedAt = Date.now();
    this.notify();
  },

  /** Merge one turn's answer variants into the cached payload. */
  patchAnswer(sessionId, turn, payload) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state || !payload) return;
    const answers = entry.state.answers || (entry.state.answers = {});
    answers[String(turn)] = {
      active: payload.active,
      items: payload.items || [],
      override: payload.override ?? null,
    };
    entry.updatedAt = Date.now();
    this.notify();
  },

  /** Merge the hidden turn/answer lists into the cached payload. */
  patchHidden(sessionId, hidden) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state || !hidden) return;
    entry.state.hidden = {
      turns: Array.isArray(hidden.turns) ? hidden.turns : [],
      answers: Array.isArray(hidden.answers) ? hidden.answers : [],
      // Prompts replayed to get a real answer: their turn's user row is hidden
      // while the answer it produced stays visible.
      prompts: Array.isArray(hidden.prompts) ? hidden.prompts : [],
    };
    entry.updatedAt = Date.now();
    this.notify();
  },

  /** Which language a turn shows right now (a translation replaces the answer). */
  patchShown(sessionId, turn, lang) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state || typeof turn !== 'number') return;
    const shown = entry.state.shown || (entry.state.shown = {});
    const key = String(turn);
    if (typeof lang === 'string' && lang.length > 0) shown[key] = lang;
    else delete shown[key];
    entry.updatedAt = Date.now();
    this.notify();
  },

  /** The answer currently being written for one turn, if there is one. */
  getLive(sessionId, turn) {
    if (!sessionId || typeof turn !== 'number') return null;
    return this.live.get(sessionId + '|' + turn) || null;
  },

  setLive(sessionId, turn, value) {
    if (!sessionId || typeof turn !== 'number') return;
    const key = sessionId + '|' + turn;
    if (value === null || value === undefined) this.live.delete(key);
    else this.live.set(key, value);
    this.notify();
  },

  /** The translation currently being written for one turn, if there is one. */
  getLiveTranslation(sessionId, turn) {
    if (!sessionId || typeof turn !== 'number') return null;
    return this.liveTranslations.get(sessionId + '|' + turn) || null;
  },

  setLiveTranslation(sessionId, turn, value) {
    if (!sessionId || typeof turn !== 'number') return;
    const key = sessionId + '|' + turn;
    if (value === null || value === undefined) this.liveTranslations.delete(key);
    else this.liveTranslations.set(key, value);
    this.notify();
  },

  /**
   * Editing one answer in place. The editor lives in the answer area while the
   * pencil lives in the action row, so the two halves of one interaction are
   * different slot components and share this cell instead of React state.
   */
  getEdit(sessionId, turn) {
    if (!sessionId || typeof turn !== 'number') return null;
    return this.edits.get(sessionId + '|' + turn) || null;
  },

  setEdit(sessionId, turn, value) {
    if (!sessionId || typeof turn !== 'number') return;
    const key = sessionId + '|' + turn;
    if (value === null || value === undefined) this.edits.delete(key);
    else this.edits.set(key, value);
    this.notify();
  },

  async load(sessionId) {
    if (!sessionId) return;
    const g = realGlobal();
    if (!g || typeof g.fetch !== 'function') return;
    if (this.inflight.has(sessionId)) return this.inflight.get(sessionId);

    const existing = this.bySession.get(sessionId);
    if (existing) {
      this.bySession.set(sessionId, Object.assign({}, existing, { loading: true }));
    } else {
      this.bySession.set(sessionId, { state: null, loading: true, error: null, updatedAt: 0 });
    }

    const self = this;
    const reqTime = Date.now();
    const promise = (async function () {
      try {
        const res = await g.fetch(ROUTE + '?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        self.set(sessionId, data, reqTime);
      } catch (e) {
        const errStr = String((e && e.message) || e);
        const prev = self.bySession.get(sessionId);
        self.bySession.set(sessionId, {
          state: prev ? prev.state : null,
          loading: false,
          error: errStr,
          updatedAt: prev ? prev.updatedAt : 0,
        });
        self.notify();
      } finally {
        self.inflight.delete(sessionId);
      }
    })();

    this.inflight.set(sessionId, promise);
    return promise;
  },

  ensure(sessionId) {
    if (!sessionId) return;
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state) {
      this.load(sessionId);
    } else if (Date.now() - (entry.updatedAt || 0) > 8000 && !entry.loading) {
      this.load(sessionId);
    }
  },

  invalidate(sessionId) {
    if (!sessionId) {
      this.bySession.forEach(function (e) { if (e) e.updatedAt = 0; });
      this.notify();
      return;
    }
    const entry = this.bySession.get(sessionId);
    if (entry) entry.updatedAt = 0;
    this.load(sessionId);
  },
};

function useToolbar(sessionId) {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return store.subscribe(force); }, []);
  React.useEffect(function () { if (sessionId) store.ensure(sessionId); }, [sessionId]);
  return sessionId ? store.get(sessionId) : null;
}

/** Subscribes to the "answer being written" channel of one turn. */
function useLiveAnswer(sessionId, turn) {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return store.subscribe(force); }, []);
  return store.getLive(sessionId, turn);
}

/** Subscribes to the "this answer is being edited in place" channel. */
function useAnswerEdit(sessionId, turn) {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return store.subscribe(force); }, []);
  return store.getEdit(sessionId, turn);
}

/** Subscribes to the "a translation is being written" channel of one turn. */
function useLiveTranslation(sessionId, turn) {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return store.subscribe(force); }, []);
  return store.getLiveTranslation(sessionId, turn);
}

/* module-level navigation/session services, bound in apply() */
let navigation = null;
let sessionsService = null;

function useSessionList() {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () {
    if (!sessionsService || typeof sessionsService.list.subscribe !== 'function') return undefined;
    return sessionsService.list.subscribe(force);
  }, []);
  return sessionsService && typeof sessionsService.list.getSnapshot === 'function'
    ? sessionsService.list.getSnapshot()
    : { byId: {} };
}

/* ----------------------------------------------------------------- utils -- */

function contentText(content) {
  if (!Array.isArray(content)) return '';
  let out = '';
  for (let i = 0; i < content.length; i++) {
    const block = content[i];
    if (block && block.type === 'text' && typeof block.text === 'string') {
      out += (out ? '\n' : '') + block.text;
    }
  }
  return out;
}

function firstTextBlockIndex(content) {
  if (!Array.isArray(content)) return -1;
  for (let i = 0; i < content.length; i++) {
    if (content[i] && content[i].type === 'text') return i;
  }
  return -1;
}

function imageParts(content) {
  if (!Array.isArray(content)) return [];
  return content.filter(function (block) { return block && block.type === 'image'; });
}

function imageCount(content) {
  return imageParts(content).length;
}

function clip(text, max) {
  const value = String(text || '');
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

function timeLabel(ms) {
  if (typeof ms !== 'number') return '';
  try {
    return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return '';
  }
}

function modelLabel(model) {
  if (!model) return '';
  if (model.name) return model.name;
  return model.model || model.provider || '';
}

/**
 * A turn number from whatever the slot handed us: the turnTail owner passes a
 * TurnLocation (`{ turn, status, steps, data }`), chat nodes pass the same
 * record, while the message index and most call sites pass a plain number.
 */
function turnNumberOf(value) {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && typeof value.turn === 'number') return value.turn;
  return undefined;
}

/** Turn-scoped translation entries: [{ seq, role, langs: { id: entry } }] */
function translationsForTurn(translations, turn) {
  if (!translations || typeof turn !== 'number') return [];
  const out = [];
  for (const seqKey in translations) {
    const langs = translations[seqKey];
    if (!langs) continue;
    let entryTurn;
    for (const lang in langs) {
      if (langs[lang] && typeof langs[lang].turn === 'number') { entryTurn = langs[lang].turn; break; }
    }
    if (entryTurn !== turn) continue;
    let role = 'assistant';
    for (const lang in langs) {
      if (langs[lang] && langs[lang].role) { role = langs[lang].role; break; }
    }
    out.push({ key: seqKey, seq: Number(seqKey), role: role, langs: langs });
  }
  out.sort(function (a, b) {
    const left = Number.isFinite(a.seq) ? a.seq : 0;
    const right = Number.isFinite(b.seq) ? b.seq : 0;
    return left - right;
  });
  return out;
}

/** The language on screen for this turn, if a translation is being shown. */
function shownLangOf(state, turn) {
  const shown = state ? state.shown : null;
  if (!shown || typeof turn !== 'number') return null;
  const lang = shown[String(turn)];
  return typeof lang === 'string' && lang.length > 0 ? lang : null;
}

/**
 * What "translate in place" draws: the cached translation of this turn in the
 * language on screen. Translation replaces the answer, so the turn renders this
 * through the very same markdown body instead of growing a second panel.
 */
function translationOf(state, turn) {
  const lang = shownLangOf(state, turn);
  if (lang === null) return null;
  const entries = translationsForTurn(state.translations, turn);
  let best = null;
  for (let i = 0; i < entries.length; i++) {
    const value = entries[i].langs[lang];
    if (!value || typeof value.text !== 'string' || value.text.length === 0) continue;
    if (best === null || (value.at || 0) >= (best.at || 0)) best = value;
  }
  if (best === null) return null;
  return {
    lang: lang,
    text: best.text,
    model: best.model,
    provider: best.provider,
    // The model ran out of room: say so rather than pass half a page off as one.
    truncated: best.truncated === true,
  };
}

/**
 * Markdown split into blank-line separated blocks, with fenced code kept whole:
 * the unit of a side-by-side translation is the paragraph, not the line.
 */
function textBlocks(text) {
  const out = [];
  if (typeof text !== 'string' || text.length === 0) return out;
  const lines = text.split('\n');
  let buffer = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && line.trim().length === 0) {
      if (buffer.length > 0) { out.push(buffer.join('\n')); buffer = []; }
      continue;
    }
    buffer.push(line);
  }
  if (buffer.length > 0) out.push(buffer.join('\n'));
  return out;
}

/**
 * Immersive-translation layout: every paragraph of the original keeps its place
 * and the translation follows it, so the reader never has to look elsewhere for
 * the other language. When the two sides disagree on block count — models do
 * merge and split paragraphs — the whole translation goes under the whole
 * original rather than pairing the wrong halves.
 */
function pairParagraphs(source, translated) {
  const left = textBlocks(source);
  const right = textBlocks(translated);
  if (left.length === 0 || right.length === 0 || left.length !== right.length) {
    return [{ source: source, translation: translated }];
  }
  const pairs = [];
  for (let i = 0; i < left.length; i++) pairs.push({ source: left[i], translation: right[i] });
  return pairs;
}

/**
 * Whether both sides say the same thing. A sentence that was already in the target
 * language comes back untouched, and drawing it twice would read as a duplicate.
 */
function sameText(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const norm = function (text) { return text.replace(/\s+/g, ' ').trim(); };
  const a = norm(left);
  return a.length > 0 && a === norm(right);
}

/** The text this turn would show with the translation switched off. */
function originOf(state, turn) {
  const origins = state ? state.origins : null;
  if (!origins || typeof turn !== 'number') return '';
  const text = origins[String(turn)];
  return typeof text === 'string' ? text : '';
}

function langLabel(id) {
  for (let i = 0; i < LANGS.length; i++) if (LANGS[i].id === id) return LANGS[i].label;
  return id;
}

/* ------------------------------------------------------ answer variants -- */

/**
 * One turn's variant record: { turn, active, items[] }, where `active` is
 * either 'native' (show the logged answer) or the id of a variant. The ring
 * index 0 is always the native answer, so a user can always get back to what
 * the model actually said.
 */
function answerRing(answers, turn) {
  if (!answers || typeof turn !== 'number') return null;
  const entry = answers[String(turn)];
  if (!entry || !Array.isArray(entry.items) || entry.items.length === 0) return null;
  const alternatives = [{ id: 'native', kind: 'native' }].concat(entry.items);
  let index = alternatives.findIndex(function (item) { return item.id === entry.active; });
  if (index < 0) index = 0;
  return { turn: turn, alternatives: alternatives, index: index, active: alternatives[index], items: entry.items };
}

/**
 * The user's own rewrite of the logged answer, if there is one. It is not a
 * variant: editing overwrites what is displayed, so the ring stays at `1/1` and
 * nothing has to be switched through.
 */
function answerOverride(answers, turn) {
  if (!answers || typeof turn !== 'number') return null;
  const entry = answers[String(turn)];
  return entry && entry.override && typeof entry.override.text === 'string' ? entry.override : null;
}

/**
 * Which rows of one turn the user deleted: the whole turn, or just the answer.
 * Both are view-only flags, so the reminder row can always put them back.
 */
function hiddenOf(state, turn) {
  const hidden = state ? state.hidden : null;
  const turns = hidden && Array.isArray(hidden.turns) ? hidden.turns : [];
  const answers = hidden && Array.isArray(hidden.answers) ? hidden.answers : [];
  const prompts = hidden && Array.isArray(hidden.prompts) ? hidden.prompts : [];
  return {
    turn: typeof turn === 'number' && turns.indexOf(turn) !== -1,
    answer: typeof turn === 'number' && answers.indexOf(turn) !== -1,
    prompt: typeof turn === 'number' && prompts.indexOf(turn) !== -1,
  };
}

/** POST an answer-variant operation and fold the reply into the cache. */
async function answerMutate(operation) {
  const result = await mutate(operation);
  if (result && typeof result.turn === 'number') {
    store.patchAnswer(operation.sessionId, result.turn, result);
  }
  return result;
}

/**
 * Run one streaming operation against the plugin route and hand every frame to
 * the caller: `onStart` when the model is known, `onDelta` per token batch,
 * `onReasoning` for thinking models, and the stored payload at the end. Every
 * writer — an answer or a translation — goes through here, so both look alive
 * while they are being produced instead of after the round trip.
 */
async function streamOperation(operation, handlers) {
  const g = realGlobal();
  const callbacks = handlers || {};
  const res = await g.fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(Object.assign({}, operation, { stream: true })),
  });
  if (!res.ok) {
    const body = await res.json().catch(function () { return {}; });
    throw new Error(body.error || ('HTTP ' + res.status));
  }

  let payload = null;
  let failure = null;

  function frame(line) {
    const text = line.trim();
    if (text.length === 0) return;
    let value;
    try { value = JSON.parse(text); } catch (e) { return; }
    if (value.type === 'start') {
      if (callbacks.onStart) callbacks.onStart(value);
    } else if (value.type === 'delta') {
      if (callbacks.onDelta) callbacks.onDelta(value.text || '');
    } else if (value.type === 'reasoning') {
      if (callbacks.onReasoning) callbacks.onReasoning(value.text || '');
    } else if (value.type === 'done') {
      payload = value.payload || null;
    } else if (value.type === 'error') {
      failure = value.message || '重答失败。';
    }
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const step = await reader.read();
      if (step.done) break;
      buffer += decoder.decode(step.value, { stream: true });
      let at = buffer.indexOf('\n');
      while (at !== -1) {
        frame(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        at = buffer.indexOf('\n');
      }
    }
    buffer += decoder.decode();
    frame(buffer);
  } else {
    const text = await res.text();
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) frame(lines[i]);
  }

  if (failure !== null) throw new Error(failure);
  if (!payload) throw new Error('连接提前结束，没有拿到结果。');
  return payload;
}

/** The answer path: the same stream, folded into the turn's variant cache. */
async function answerGenerateStream(operation, handlers) {
  const payload = await streamOperation(operation, handlers);
  if (typeof payload.turn === 'number') store.patchAnswer(operation.sessionId, payload.turn, payload);
  return payload;
}

/**
 * One entry point for "regenerate" and "switch model": mark the turn as busy so
 * the answer area switches to a clean, writing answer immediately, stream the
 * text into it, then hand the finished variant to the cache.
 */
async function generateInto(sessionId, turn, model) {
  // One write at a time: a second click while the answer is still arriving would
  // otherwise interleave two streams into the same turn.
  if (store.getLive(sessionId, turn) !== null) return null;
  const seed = {
    text: '',
    reasoning: '',
    provider: model && model.provider,
    model: model && model.model,
    name: model && model.name,
    startedAt: Date.now(),
  };
  store.setLive(sessionId, turn, seed);
  try {
    const payload = await answerGenerateStream({
      action: 'answer-generate',
      sessionId: sessionId,
      turn: turn,
      ...model === undefined ? {} : { model: model },
    }, {
      onStart: function (frameValue) {
        store.setLive(sessionId, turn, Object.assign({}, seed, {
          provider: frameValue.provider,
          model: frameValue.model,
          name: frameValue.name,
        }));
      },
      onDelta: function (text) {
        const live = store.getLive(sessionId, turn) || seed;
        store.setLive(sessionId, turn, Object.assign({}, live, { text: (live.text || '') + text }));
      },
      onReasoning: function (text) {
        const live = store.getLive(sessionId, turn) || seed;
        store.setLive(sessionId, turn, Object.assign({}, live, { reasoning: (live.reasoning || '') + text }));
      },
    });
    store.setLive(sessionId, turn, null);
    return payload;
  } catch (error) {
    store.setLive(sessionId, turn, null);
    throw error;
  }
}

/**
 * Translate one turn in place while it is being written. The translation has its
 * own live cell, because nothing else about the turn is changing: the card swaps
 * the answer for the paired page as soon as the first token lands, and the
 * waiting dots live in the translation column.
 *
 * The body is whichever text is on screen — the logged answer (by event seq) or a
 * variant / an edit, which only exists on the client and travels as text.
 */
async function translateInto(sessionId, turn, body) {
  if (store.getLiveTranslation(sessionId, turn) !== null) return null;
  const seed = { lang: body.lang, text: '' };
  store.setLiveTranslation(sessionId, turn, seed);
  try {
    const payload = await streamOperation(Object.assign({ action: 'translate', sessionId: sessionId }, body), {
      onDelta: function (text) {
        const live = store.getLiveTranslation(sessionId, turn) || seed;
        store.setLiveTranslation(sessionId, turn, { lang: live.lang, text: (live.text || '') + text });
      },
    });
    store.setLiveTranslation(sessionId, turn, null);
    store.patchTranslation(sessionId, payload.seq, payload.lang, {
      text: payload.text, provider: payload.provider, model: payload.model,
      turn: payload.turn, role: payload.role, truncated: payload.truncated === true,
    });
    store.patchShown(sessionId, typeof payload.turn === 'number' ? payload.turn : turn, payload.lang);
    return payload;
  } catch (error) {
    store.setLiveTranslation(sessionId, turn, null);
    throw error;
  }
}

/** POST a hide/restore operation and fold the new lists into the cache. */
async function hideMutate(operation) {
  const result = await mutate(operation);
  if (result && result.hidden) store.patchHidden(operation.sessionId, result.hidden);
  return result;
}

/**
 * Hide rows of the transcript that the user deleted, and logged answers whose
 * visible replacement is a variant. The chat frame labels every flow row with
 * `data-chat-flow-kind` and `data-chat-turn`, so one generated stylesheet is
 * enough; if that contract ever changes the rules simply stop matching and the
 * original rows render again — no error, no breakage.
 *
 * Several components want to hide the same turn (the answer card for a
 * variant, the toolbar for a deleted answer, the tail row for a deleted turn),
 * so every caller registers under its own owner name and the sheet is rebuilt
 * from all marks: a whole-turn mark wins over an answer-only mark.
 */
/**
 * Every flow row an answer can own. A deleted answer hides all of them, because
 * an answer that is gone must not leave its process card, its tool cards, its
 * error banner or its action row behind. The user row is not in this list: the
 * turn keeps its prompt (and the toolbar on it) unless the whole turn is deleted.
 */
const DELETED_ANSWER_KINDS = [
  'assistant-step',
  'turn-process',
  'tool',
  'turn-error',
  'turn-max-tokens',
  'model-retry',
  'turn-tail',
];

const nativeHideStyle = {
  node: null,
  key: '',
  marks: new Map(),

  ensure() {
    if (this.node) return this.node;
    if (typeof document === 'undefined') return null;
    const node = document.createElement('style');
    node.dataset.plugin = 'dsh-message-toolbar-dyn';
    document.head.appendChild(node);
    this.node = node;
    return node;
  },

  render() {
    const node = this.ensure();
    if (!node) return;
    const turns = new Map();
    this.marks.forEach(function (mark) {
      const previous = turns.get(mark.turn);
      if (previous !== undefined && previous.mode === 'turn') return;
      turns.set(mark.turn, { mode: mark.mode });
    });
    const numbers = Array.from(turns.keys()).sort(function (a, b) { return a - b; });
    const key = numbers.map(function (turn) {
      const mark = turns.get(turn);
      return turn + ':' + mark.mode;
    }).join(',');
    if (key === this.key) return;
    this.key = key;
    const css = [];
    for (let i = 0; i < numbers.length; i++) {
      const turn = numbers[i];
      const mark = turns.get(turn);
      if (mark.mode === 'turn') {
        // Gone means gone: the whole turn leaves the flow, its own tail row
        // included — deleting is a view-level removal with nothing left behind.
        // The rail is handled by the navigation patch, not here: a mark carries
        // only its position (`data-index`) in the ladder, so hiding by position
        // would hit the wrong turn as soon as one is removed.
        css.push('[data-chat-turn="' + turn + '"]{display:none}');
      } else if (mark.mode === 'deleted') {
        // "Delete this answer" has to leave nothing of that answer behind: not the
        // body, not the process card, not the tool cards — and not the tail row
        // either, because the tail row is what still carries the action row (and
        // the file-change card) of an answer that no longer exists. The user row
        // keeps its own toolbar, so the turn can still be answered again.
        for (let k = 0; k < DELETED_ANSWER_KINDS.length; k++) {
          css.push('[data-chat-flow-kind="' + DELETED_ANSWER_KINDS[k] + '"][data-chat-turn="' + turn + '"]{display:none}');
        }
      } else if (mark.mode === 'translate') {
        // A translation is drawn beside the answer, so only the logged body makes
        // way for it — the process card and the tool cards of that answer are
        // still this turn's own record and stay visible.
        css.push('[data-chat-flow-kind="assistant-step"][data-chat-turn="' + turn + '"]{display:none}');
      } else {
        // An answer of our own stands where the logged one stood, so the logged
        // one goes — and with it everything that answer produced: its process
        // card ("已完成 · Xs") and its tool-call cards. What is left reads as a
        // turn that was never answered and is being answered now, which is what
        // a switch means. File changes live in the tail row another plugin owns,
        // so they stay where they were.
        css.push('[data-chat-flow-kind="assistant-step"][data-chat-turn="' + turn + '"]{display:none}');
        css.push('[data-chat-flow-kind="turn-process"][data-chat-turn="' + turn + '"]{display:none}');
        css.push('[data-chat-flow-kind="tool"][data-chat-turn="' + turn + '"]{display:none}');
      }
    }
    node.textContent = css.join('\n');
  },

  /** Register (mode) or clear (null) one owner's mark. */
  set(owner, turn, mode) {
    if (typeof turn !== 'number' || mode === null || mode === undefined) this.marks.delete(owner);
    else {
      this.marks.set(owner, { turn: turn, mode: mode });
    }
    this.render();
  },
};

/* ---------------------------------------------------------------- store API -- */

async function mutate(operation) {
  const g = realGlobal();
  const res = await g.fetch(ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(operation),
  });
  const body = await res.json().catch(function () { return {}; });
  if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
  return body;
}

async function fetchModels() {
  const g = realGlobal();
  const res = await g.fetch(ROUTE + '?models=1', { cache: 'no-store' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* -------------------------------------------------------------- navigation -- */

async function openVersionTarget(nav, v) {
  if (!v || v.deleted || !nav) return;
  if (v.archived) {
    try {
      await mutate({ action: 'activate', sessionId: v.sessionId });
      store.invalidate();
    } catch (e) {}
  }
  openWhenListed(nav, v.sessionId);
}

function openWhenListed(nav, sessionId) {
  const list = nav.list;
  const open = nav.openVersion;
  if (!list || typeof list.getSnapshot !== 'function') { open(sessionId); return; }
  if (list.getSnapshot().byId[sessionId] !== undefined) { open(sessionId); return; }
  const stop = list.subscribe(function () {
    if (list.getSnapshot().byId[sessionId] !== undefined) {
      stop();
      open(sessionId);
    }
  });
}

/* ------------------------------------------------------- one visible branch -- */

// A model answer can only live in its own session: the log refuses a second
// answer for a turn that is already closed. To keep the conversation list free
// of near-identical siblings, every switch hides the other members — but only
// once navigation has committed, because archiving the session that is still
// open closes the main view. The first toolbar that mounts inside the target
// session is that signal.
let pendingFocus = null;

function switchToVersion(nav, v, currentSessionId) {
  if (!v || v.deleted || !nav) return;
  if (v.sessionId === currentSessionId) return;
  pendingFocus = { target: v.sessionId };
  openVersionTarget(nav, v);
}

function useFocusPending(sessionId) {
  React.useEffect(function () {
    const job = pendingFocus;
    if (job === null || job.target !== sessionId) return;
    pendingFocus = null;
    mutate({ action: 'focus', sessionId: job.target })
      .then(function () { store.invalidate(); })
      .catch(function () {});
  }, [sessionId]);
}

/* ------------------------------------------------------------ version math -- */

function ringFor(versions, sessionId, turn) {
  if (!versions) return null;
  const byId = new Map(versions.map(function (v) { return [v.sessionId, v]; }));
  let cursor = byId.get(sessionId);
  if (!cursor) return null;
  while (cursor.parentSessionId && typeof cursor.targetTurn === 'number' && cursor.targetTurn > turn) {
    const parent = byId.get(cursor.parentSessionId);
    if (!parent) break;
    cursor = parent;
  }
  let fork = cursor;
  while (fork.parentSessionId && typeof fork.targetTurn === 'number' && fork.targetTurn === turn) {
    const parent = byId.get(fork.parentSessionId);
    if (!parent) break;
    fork = parent;
  }
  function walksToFork(start) {
    let x = start;
    const seen = new Set();
    while (x && !seen.has(x.sessionId)) {
      seen.add(x.sessionId);
      if (x.sessionId === fork.sessionId) return true;
      if (typeof x.targetTurn !== 'number' || x.targetTurn !== turn) return false;
      x = x.parentSessionId ? byId.get(x.parentSessionId) : null;
    }
    return false;
  }
  const alternatives = versions
    .filter(function (v) {
      return !v.deleted && (v.sessionId === fork.sessionId || (v.targetTurn === turn && walksToFork(v)));
    })
    .sort(function (a, b) {
      return a.createdAt - b.createdAt || String(a.sessionId).localeCompare(String(b.sessionId));
    });
  if (alternatives.length < 2) return null;
  let index = alternatives.findIndex(function (v) { return v.sessionId === cursor.sessionId; });
  if (index === -1) index = alternatives.findIndex(function (v) { return v.sessionId === sessionId; });
  if (index === -1) index = 0;
  return { alternatives: alternatives, index: index };
}

/** Flatten one conversation family into turn-level nodes (indented list). */
function buildTurnTree(versions, currentSessionId) {
  if (!versions || versions.length === 0) return [];
  const byId = new Map(versions.map(function (v) { return [v.sessionId, v]; }));

  let rootVersion = versions.find(function (v) { return !v.parentSessionId; });
  if (!rootVersion) {
    let cursor = byId.get(currentSessionId);
    const seen = new Set();
    while (cursor && cursor.parentSessionId && !seen.has(cursor.sessionId)) {
      seen.add(cursor.sessionId);
      const parent = byId.get(cursor.parentSessionId);
      if (!parent) break;
      cursor = parent;
    }
    rootVersion = cursor || versions[0];
  }
  const rootSessionId = rootVersion.sessionId;

  const nodes = [];
  const rootNodeId = rootSessionId + '#root';
  const nodeMap = new Map();

  const rootNode = {
    id: rootNodeId, sessionId: rootSessionId, turn: 0, isRoot: true,
    time: rootVersion.createdAt || 0,
    current: currentSessionId === rootSessionId && (!rootVersion.turns || rootVersion.turns.length === 0),
    onCurrentPath: true, depth: 0,
    deleted: !!rootVersion.deleted, archived: !!rootVersion.archived,
  };
  nodes.push(rootNode);
  nodeMap.set(rootNodeId, rootNode);

  function parentTurnNodeId(v, turn) {
    if (!v.parentSessionId) {
      if (turn === 1) return rootNodeId;
      return v.sessionId + '#t' + (turn - 1);
    }
    if (turn === v.targetTurn) {
      if (v.targetTurn === 1) return rootNodeId;
      return v.parentSessionId + '#t' + (v.targetTurn - 1);
    }
    return v.sessionId + '#t' + (turn - 1);
  }

  for (let index = 0; index < versions.length; index++) {
    const v = versions[index];
    const isCurrentSession = v.sessionId === currentSessionId;
    const turns = Array.isArray(v.turns) && v.turns.length > 0 ? v.turns : [];
    const depth = (v.depth || 0) + 1;

    if (!v.parentSessionId) {
      for (let i = 0; i < turns.length; i++) {
        const item = turns[i];
        const id = v.sessionId + '#t' + item.turn;
        nodeMap.set(id, {
          id: id, sessionId: v.sessionId, turn: item.turn, depth: depth,
          parentId: parentTurnNodeId(v, item.turn),
          time: item.time || v.createdAt, text: item.text || '',
          current: isCurrentSession, onCurrentPath: false,
          deleted: !!v.deleted, archived: !!v.archived,
        });
        nodes.push(nodeMap.get(id));
      }
    } else {
      const targetTurn = typeof v.targetTurn === 'number' ? v.targetTurn : 1;
      const ownTurns = turns.filter(function (t) { return t.turn >= targetTurn; });
      if (ownTurns.length === 0) {
        const id = v.sessionId + '#t' + targetTurn;
        nodeMap.set(id, {
          id: id, sessionId: v.sessionId, turn: targetTurn, depth: depth,
          parentId: parentTurnNodeId(v, targetTurn),
          operation: v.operation || 'edit',
          text: v.after || v.before || '',
          time: v.createdAt || 0,
          current: isCurrentSession, onCurrentPath: false,
          deleted: !!v.deleted, archived: !!v.archived,
          model: v.model,
        });
        nodes.push(nodeMap.get(id));
      } else {
        for (let i = 0; i < ownTurns.length; i++) {
          const item = ownTurns[i];
          const isForkTurn = item.turn === targetTurn;
          const id = v.sessionId + '#t' + item.turn;
          nodeMap.set(id, {
            id: id, sessionId: v.sessionId, turn: item.turn, depth: depth,
            parentId: parentTurnNodeId(v, item.turn),
            operation: isForkTurn ? (v.operation || 'edit') : undefined,
            text: item.text || (isForkTurn ? (v.after || v.before || '') : ''),
            time: item.time || v.createdAt,
            current: isCurrentSession, onCurrentPath: false,
            deleted: !!v.deleted, archived: !!v.archived,
            model: v.model,
          });
          nodes.push(nodeMap.get(id));
        }
      }
    }
  }

  const allIds = new Set(nodes.map(function (n) { return n.id; }));
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].parentId && !allIds.has(nodes[i].parentId)) nodes[i].parentId = rootNodeId;
  }

  return nodes;
}

/* --------------------------------------------------------------- icons -- */

const h = React.createElement;

// Icons are DSH's own artwork, not lookalikes: the path data below is copied
// verbatim from @deepseek-ai/dsh-client-ui-primitives (the *OutlineArtwork
// components), which share one 16-unit grid, `fill:none` and the regular 1px
// stroke. Inlining the vectors instead of requiring the primitives package
// keeps the bundle independent of shell seed modules while still matching the
// built-in action row pixel for pixel.
const ICON = 16;
const ICON_STROKE = 1;

/** One 16-unit glyph viewport, exactly like the primitives artwork wrapper. */
function glyph(children) {
  return h('svg', {
    width: ICON,
    height: ICON,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    strokeWidth: ICON_STROKE,
    'aria-hidden': true,
  }, children);
}

function CopyIcon() {
  return glyph([
    h('rect', {
      key: 'frame', x: 1.52075, y: 4.07373, width: 10.3932, height: 10.3932, rx: 2, stroke: 'currentColor',
    }),
    h('path', {
      key: 'sheet',
      fill: 'currentColor',
      d: 'M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z',
    }),
  ]);
}

function PencilIcon() {
  return glyph([
    h('path', {
      key: 'sheet',
      fill: 'currentColor',
      d: 'M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z',
    }),
    h('path', { key: 'pen', d: 'M7.7849 8.23878L13.888 2.13574', stroke: 'currentColor' }),
  ]);
}

function RetryIcon() {
  return glyph([
    h('path', {
      key: 'arc',
      stroke: 'currentColor',
      d: 'M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1',
    }),
    h('path', { key: 'head', d: 'M14.4999 1.5V5.1H10.8999', stroke: 'currentColor' }),
  ]);
}

// DSH ships no translate glyph, so this one glyph stays hand-drawn — but on the
// same 16-unit grid and the same regular 1px stroke as the official set: a
// 文-style stroke group (source language) plus an A (target language). A globe
// would read as "web / browse" in this row.
function TranslateIcon() {
  return glyph([
    h('path', {
      key: 'wen',
      stroke: 'currentColor',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      d: 'M2 4.6h7M5.6 2.4v2.2M2.9 6.9c.9 2.4 2.4 4.4 4.4 6.1M8.2 6.9c-1 2.6-2.8 4.9-5.6 6.7',
    }),
    h('path', {
      key: 'a',
      stroke: 'currentColor',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      d: 'M12.4 3.1L10.3 13.6h4.4L12.4 3.1M11.1 10.4h2.9',
    }),
  ]);
}

/**
 * The app's own loading arc, turning. Used wherever an action is running and the
 * button has to say so without a second label: the icon becomes the progress bar.
 */
function LoadingIcon() {
  return h('svg', {
    width: ICON,
    height: ICON,
    viewBox: '0 0 16 16',
    fill: 'none',
    xmlns: 'http://www.w3.org/2000/svg',
    strokeWidth: ICON_STROKE,
    'aria-hidden': true,
    className: 'mtt-spin',
  }, h('path', {
    stroke: 'currentColor',
    d: 'M12.596 12.596C11.687 13.5049 10.5288 14.1239 9.26798 14.3747C8.00716 14.6255 6.70028 14.4968 5.51261 14.0048C4.32494 13.5129 3.30981 12.6798 2.59557 11.611C1.88134 10.5421 1.50008 9.2855 1.5 7.99998C1.50008 6.71446 1.88134 5.45783 2.59557 4.38898C3.30981 3.32013 4.32494 2.48707 5.51261 1.99513C6.70028 1.50319 8.00716 1.37447 9.26798 1.62524C10.5288 1.87602 11.687 2.49502 12.596 3.40398',
  }));
}

function TrashIcon() {  return glyph([
    h('path', { key: 'lid', d: 'M1.28149 3.88831H14.7187', stroke: 'currentColor' }),
    h('path', {
      key: 'handle',
      stroke: 'currentColor',
      d: 'M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833',
    }),
    h('path', {
      key: 'can',
      stroke: 'currentColor',
      d: 'M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831',
    }),
    h('path', { key: 'rib1', d: 'M6.44946 6.98926V11.1238', stroke: 'currentColor' }),
    h('path', { key: 'rib2', d: 'M9.55054 6.98926V11.1238', stroke: 'currentColor' }),
  ]);
}

/**
 * Swapping the answering model: DSH's two-slider outline glyph
 * (`IconSlidersTwoOutline`). The official artwork paints both lines and both
 * knobs from a *svg-level* `stroke="currentColor"` + round caps, so every child
 * here carries that paint itself — a bare `path` inside `fill:none` inherits
 * nothing and renders as empty space (that is exactly how this button once
 * became invisible).
 */
function CpuIcon() {
  const line = { stroke: 'currentColor', strokeLinecap: 'round' };
  return glyph([
    h('path', { key: 'l1', d: 'M2.3 5h5.85M12.05 5h1.65', ...line }),
    h('circle', { key: 'c1', cx: 9.95, cy: 5, r: 1.45, ...line }),
    h('path', { key: 'l2', d: 'M2.3 11h1.65M7.85 11h5.85', ...line }),
    h('circle', { key: 'c2', cx: 5.75, cy: 11, r: 1.45, ...line }),
  ]);
}

function CheckIcon() {
  return glyph(h('path', {
    d: 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4',
    stroke: 'currentColor',
  }));
}

/** Leaving the editor: DSH's own two-stroke close glyph (`IconCloseOutline`). */
function CloseIcon() {
  return glyph([
    h('path', { key: 'a', d: 'M2.5 2.5L13.5 13.5', stroke: 'currentColor' }),
    h('path', { key: 'b', d: 'M13.5 2.5L2.5 13.5', stroke: 'currentColor' }),
  ]);
}

function ChevronLeftIcon() {
  return glyph(h('path', {
    d: 'M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12',
    stroke: 'currentColor',
  }));
}

function ChevronRightIcon() {
  return glyph(h('path', {
    d: 'M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4',
    stroke: 'currentColor',
  }));
}

/** "Back to the model's own answer": DSH's archive-off style arrow-down glyph. */
function RestoreIcon() {
  return glyph(h('path', {
    d: 'M8 2.2V10M8 10L4.9 6.9M8 10L11.1 6.9M2.6 13.4h10.8',
    stroke: 'currentColor',
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
  }));
}

/* -------------------------------------------------------------------- UI -- */

// Which dictionary the reader gets. DSH's locale service is one signal, not the
// only one: the value it reports is provisional and browser-derived, so a row can
// render while it still says `en` — that is how "Answer deleted" once appeared
// under a Chinese reader. A Chinese browser or a Chinese document therefore wins
// outright; the service decides only when neither speaks Chinese. A locale switch
// drops the cache.
let localeService = null;
let langCache = null;

function invalidateLang() {
  langCache = null;
}

function uiLang() {
  if (langCache !== null) return langCache;
  let active = '';
  try {
    if (localeService && typeof localeService.getLocale === 'function') {
      active = String((localeService.getLocale() || {}).active || '');
    }
  } catch (e) {}
  let page = '';
  try {
    if (typeof document !== 'undefined' && document.documentElement) {
      page = String(document.documentElement.lang || '');
    }
  } catch (e) {}
  let nav = '';
  try {
    const g = realGlobal();
    if (g && g.navigator) {
      nav = String(g.navigator.language || (g.navigator.languages && g.navigator.languages[0]) || '');
    }
  } catch (e) {}
  const chinese = /^zh/i.test(nav) || /^zh/i.test(page) || /^zh/i.test(active);
  langCache = chinese ? 'zh' : 'en';
  return langCache;
}

let t = function (key, params) {
  const dict = I18N[uiLang()] || I18N.zh;
  let out = dict[key];
  if (out === undefined) out = I18N.zh[key];
  if (out === undefined) out = key;
  if (params) for (const name in params) out = out.replace('{' + name + '}', String(params[name]));
  return out;
};

function ActionButton(props) {
  return h('button', {
    type: 'button',
    className: 'mtt-act' + (props.active ? ' mtt-act-on' : ''),
    // A stable hook for tests and for telling one delete from another: several
    // rows carry a trash button and they do very different things.
    'data-mtt': props.act,
    title: props.title,
    disabled: props.disabled,
    onClick: props.onClick,
  }, props.children);
}

// Popovers open below their button. On the last message that is exactly where
// the composer floats, so measure the button's wrapper first and flip the
// popover above the button when there is not enough room underneath.
function popupOpensUp(event) {
  const button = event && event.currentTarget;
  const wrap = button && button.parentElement;
  if (!wrap || typeof wrap.getBoundingClientRect !== 'function' || typeof window === 'undefined') return false;
  const rect = wrap.getBoundingClientRect();
  const wanted = Math.min(360, Math.max(180, window.innerHeight * 0.45));
  const below = window.innerHeight - rect.bottom;
  if (below >= wanted) return false;
  // Not enough room underneath: take the larger side, so the popover stays
  // inside the window even when neither side fits the full height.
  return rect.top >= below;
}

// A popover that is anchored to its button but lives outside the conversation
// flow. DSH's rows paint over absolutely positioned children and clip them at
// their bounds, which is why a confirm box used to appear half-covered; a
// portal to `document.body` with fixed coordinates cannot be covered or
// clipped by anything the row does.
let reactDomCache;
function clientReactDom() {
  if (reactDomCache !== undefined) return reactDomCache;
  try {
    reactDomCache = require('react-dom');
  } catch (e) {
    reactDomCache = null;
  }
  return reactDomCache;
}

function Popover(props) {
  const anchor = props.anchor;
  const [place, setPlace] = React.useState(null);
  React.useEffect(function () {
    if (!props.open) {
      setPlace(null);
      return undefined;
    }
    const g = realGlobal();
    function measure() {
      const el = anchor && anchor.current;
      if (!el || typeof el.getBoundingClientRect !== 'function' || !g) return;
      const rect = el.getBoundingClientRect();
      const width = 260;
      const vw = g.innerWidth || 1200;
      const vh = g.innerHeight || 800;
      const left = Math.max(8, Math.min(rect.right - width, vw - width - 8));
      const up = props.up === true;
      setPlace({
        left: left,
        top: up ? undefined : rect.bottom + 6,
        bottom: up ? vh - rect.top + 6 : undefined,
        maxHeight: up ? rect.top - 16 : vh - rect.bottom - 16,
      });
    }
    measure();
    if (g && typeof g.addEventListener === 'function') {
      g.addEventListener('resize', measure);
      g.addEventListener('scroll', measure, true);
    }
    return function () {
      if (g && typeof g.removeEventListener === 'function') {
        g.removeEventListener('resize', measure);
        g.removeEventListener('scroll', measure, true);
      }
    };
  }, [props.open, anchor, props.up]);
  if (!props.open || place === null) return null;
  const node = h('div', {
    className: 'mtt-pop mtt-pop-float' + (props.className === undefined ? '' : ' ' + props.className),
    style: {
      position: 'fixed',
      left: place.left + 'px',
      top: place.top === undefined ? 'auto' : place.top + 'px',
      bottom: place.bottom === undefined ? 'auto' : place.bottom + 'px',
      width: '260px',
      zIndex: 1200,
      maxHeight: Math.max(120, place.maxHeight) + 'px',
    },
  }, props.children);
  const dom = clientReactDom();
  if (dom !== null && typeof dom.createPortal === 'function'
    && typeof document !== 'undefined' && document.body) {
    return dom.createPortal(node, document.body);
  }
  // No portal available: `position:fixed` still keeps the box out of the row's
  // stacking context, but it can be off if an ancestor transforms the page.
  if (!popoverWarned) {
    popoverWarned = true;
    console.warn('[dsh-message-toolbar] react-dom is unavailable; popovers render without a portal.');
  }
  return node;
}
let popoverWarned = false;

// A menu must not outlive the user's attention: close it as soon as a pointer
// goes down outside any menu wrapper, or on Escape. The captured `close` only
// calls a state setter, so it stays valid for the lifetime of the listener.
//
// A pointer that lands *inside* one of our own surfaces must not dismiss it —
// and that includes the portalled ones: a confirm box lives in `document.body`,
// so a click on its "delete" button is "outside" the row that opened it. Closing
// on that pointerdown unmounted the box before its click could be dispatched,
// which read as "the button does nothing".
const OWN_SURFACE = '.mtt-menu-wrap, .mtt-pop, .mtt-pop-float';

function useDismiss(open, close) {
  React.useEffect(function () {
    if (!open) return undefined;
    function onPointer(event) {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest(OWN_SURFACE) !== null) return;
      close();
    }
    function onKey(event) {
      if (event.key === 'Escape') close();
    }
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return function () {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
}

function ModelChip(props) {
  const label = modelLabel(props.model);
  if (!label) return null;
  return h('span', { className: 'mtt-chip', title: props.title || label }, label);
}

function ErrorChip(props) {
  if (!props.error) return null;
  return h('div', { className: 'mtt-error' }, String(props.error));
}

function VersionRing(props) {
  const ring = props.ring;
  if (!ring) return null;
  const current = ring.alternatives[ring.index];
  const go = function (delta) {
    const next = ring.alternatives[ring.index + delta];
    if (next) switchToVersion(navigation, next, current && current.sessionId);
  };
  return h('span', { className: 'mtt-ring' },
    h('button', {
      type: 'button', className: 'mtt-ring-btn', disabled: ring.index <= 0,
      title: t('prevVersion'), onClick: function () { go(-1); },
    }, '‹'),
    h('span', {
      className: 'mtt-ring-count',
      title: current && current.operation ? t('versionHint') : '',
    }, (ring.index + 1) + '/' + ring.alternatives.length),
    h('button', {
      type: 'button', className: 'mtt-ring-btn', disabled: ring.index >= ring.alternatives.length - 1,
      title: t('nextVersion'), onClick: function () { go(1); },
    }, '›'));
}

function LanguageMenu(props) {
  return h('div', { className: 'mtt-pop' },
    h('div', { className: 'mtt-pop-title' }, props.title),
    props.original === true
      ? h('button', {
        type: 'button',
        className: 'mtt-pop-item',
        onClick: function () { props.onOriginal(); },
      }, props.originalLabel)
      : null,
    LANGS.map(function (lang) {
      return h('button', {
        key: lang.id, type: 'button',
        className: 'mtt-pop-item',
        onClick: function () { props.onPick(lang.id); },
      }, lang.label);
    }));
}

const ORIGINAL_ROW = 'message-toolbar/original';

/**
 * The "translate" action: a menu of target languages, nothing else. It is the
 * same native dropdown the model picker uses, so both toolbars share one
 * interaction, and it replaces the old settings fields — the language is picked
 * at the moment of translating instead of being configured up front.
 */
function LanguageMenuHost(props) {
  const primitives = clientPrimitives();
  // While a translation is on its way the button stops being a menu and becomes a
  // progress indicator: the icon spins, the menu cannot be opened, and it turns
  // back into the translate glyph the moment the answer arrives.
  const trigger = h(ActionButton, {
    title: props.busy === true ? props.busyTitle : props.title,
    active: props.open || props.active === true,
    disabled: props.disabled || props.busy === true,
    onClick: props.onToggle,
  }, props.busy === true ? h(LoadingIcon) : h(TranslateIcon));

  if (!primitives) {
    return h('span', { className: 'mtt-menu-wrap' + (props.up ? ' mtt-up' : '') },
      trigger,
      props.open
        ? h(LanguageMenu, {
          title: props.pickTitle,
          current: props.current,
          original: props.original === true,
          originalLabel: props.originalLabel,
          onOriginal: props.onOriginal,
          onPick: props.onPick,
        })
        : null);
  }

  // A translation replaces the answer, so the same menu has to offer the way
  // back: "Show the original" is the first row whenever one is on screen.
  const rows = (props.original === true
    ? [{ id: ORIGINAL_ROW, label: props.originalLabel }]
    : []).concat(LANGS.map(function (lang) { return { id: lang.id, label: lang.label }; }));

  // Picking a language is a command, not a setting: the reader is about to
  // choose one, so nothing in this list is "currently selected" and nothing is
  // ticked — the only stateful row is the way to hide the translation again.
  return h(primitives.Menu, {
    open: props.open,
    anchor: trigger,
    items: rows,
    align: 'end',
    side: props.up ? 'top' : 'bottom',
    portal: true,
    closeOnPointerLeave: true,
    onSelect: function (id) {
      if (id === ORIGINAL_ROW) { props.onOriginal(); return; }
      const picked = LANGS.find(function (lang) { return lang.id === id; });
      if (picked) props.onPick(picked.id);
    },
    onClose: props.onClose,
  });
}

// The composer's model picker is a `Menu` from this package, so reusing it gives
// the toolbar exactly the dropdown DSH itself shows under the composer instead
// of a look-alike. `dsh-client-ui-primitives` is a shell seed module, so it
// resolves through the module loader without being declared in
// `dsh.client.inject`; if a host ever ships without it we fall back to our own
// markup rather than failing to compose.
let primitivesCache;
function clientPrimitives() {
  if (primitivesCache !== undefined) return primitivesCache;
  try {
    const api = require('@deepseek-ai/dsh-client-ui-primitives');
    primitivesCache = api && typeof api.Menu === 'function' ? api : null;
  } catch (e) {
    primitivesCache = null;
  }
  return primitivesCache;
}

/** Data rows for the native menu: one heading per provider, one row per model. */
function modelMenuEntries(catalog) {
  const items = [];
  const lookup = Object.create(null);
  const providers = catalog && Array.isArray(catalog.providers) ? catalog.providers : [];
  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const models = Array.isArray(provider.models) ? provider.models : [];
    if (models.length === 0) continue;
    items.push({ type: 'label', id: 'p-' + provider.id, text: provider.name || provider.id });
    for (let j = 0; j < models.length; j++) {
      const model = models[j];
      const id = provider.id + '/' + model.id;
      lookup[id] = { provider: provider.id, model: model.id, name: model.name || model.id };
      const label = model.name && model.name !== model.id ? model.name + ' · ' + model.id : (model.name || model.id);
      items.push({ id: id, label: label });
    }
  }
  return { items: items, lookup: lookup };
}

const BRANCH_ROW = 'message-toolbar/branch';

/**
 * The "switch model" action: the native dropdown when the primitives package is
 * around, our own popover otherwise. Both only collect a choice — the caller
 * answers the turn in place with it.
 */
function ModelMenuHost(props) {
  const primitives = clientPrimitives();
  const trigger = h(ActionButton, {
    title: props.title,
    active: props.open,
    disabled: props.disabled,
    onClick: props.onToggle,
  }, h(CpuIcon));

  if (!primitives) {
    return h('span', { className: 'mtt-menu-wrap' + (props.up ? ' mtt-up' : '') },
      trigger,
      props.open
        ? h(ModelMenu, {
          title: t('switchModelPick'),
          loading: props.loading,
          catalog: props.catalog,
          onPick: props.onPick,
          branchLabel: props.branchLabel,
          onBranch: props.onBranch,
        })
        : null);
  }

  const entries = modelMenuEntries(props.catalog);
  const items = entries.items.length > 0
    ? entries.items
    : [{ id: 'message-toolbar/empty', label: props.loading ? t('loading') : t('noModels'), disabled: true }];
  const footer = props.branchLabel ? [{ id: BRANCH_ROW, label: props.branchLabel }] : undefined;
  const selectedId = props.selected && props.selected.provider && props.selected.model
    ? props.selected.provider + '/' + props.selected.model
    : undefined;

  return h(primitives.Menu, {
    open: props.open,
    anchor: trigger,
    items: items,
    selectedId: selectedId,
    selection: 'check',
    align: 'end',
    side: props.up ? 'top' : 'bottom',
    portal: true,
    closeOnPointerLeave: true,
    footer: footer,
    onSelect: function (id) {
      if (id === BRANCH_ROW) { props.onBranch(); return; }
      const picked = entries.lookup[id];
      if (picked) props.onPick(picked);
    },
    onClose: props.onClose,
  });
}

function ModelMenu(props) {
  const catalog = props.catalog;
  if (props.loading) {
    return h('div', { className: 'mtt-pop' },
      h('div', { className: 'mtt-pop-title' }, props.title),
      h('div', { className: 'mtt-pop-note' }, t('loading')));
  }
  if (!catalog || !Array.isArray(catalog.providers) || catalog.providers.length === 0) {
    return h('div', { className: 'mtt-pop' },
      h('div', { className: 'mtt-pop-title' }, props.title),
      h('div', { className: 'mtt-pop-note' }, t('noModels')));
  }
  const rows = [];
  for (let i = 0; i < catalog.providers.length; i++) {
    const provider = catalog.providers[i];
    rows.push(h('div', { key: 'p-' + provider.id, className: 'mtt-pop-group' }, provider.name + ' · ' + provider.id));
    const models = provider.models || [];
    for (let j = 0; j < models.length; j++) {
      const model = models[j];
      rows.push(h('button', {
        key: 'm-' + provider.id + '-' + model.id, type: 'button', className: 'mtt-pop-item',
        onClick: function () { props.onPick({ provider: provider.id, model: model.id, name: model.name }); },
      }, model.name + (model.name !== model.id ? ' · ' + model.id : '')));
    }
    if (models.length === 0) {
      rows.push(h('div', { key: 'e-' + provider.id, className: 'mtt-pop-note' }, t('noModels')));
    }
  }
  return h('div', { className: 'mtt-pop mtt-pop-wide' },
    h('div', { className: 'mtt-pop-title' }, props.title), rows,
    props.onBranch
      ? h('div', { className: 'mtt-pop-foot' },
        h('button', {
          type: 'button', className: 'mtt-pop-item mtt-pop-item-sub',
          onClick: function () { props.onBranch(); },
        }, props.branchLabel || '…'))
      : null);
}

/* -------------------------------------------------------- answer variants -- */

// The official Markdown renderer lives in dsh-client-ui-primitives, which the
// web shell exposes as a static seed module. Requiring it is optional by
// design: without it answers degrade to pre-wrapped text instead of failing.
let markdownBridge;

function markdownRenderer() {
  if (markdownBridge !== undefined) return markdownBridge;
  markdownBridge = null;
  try {
    const primitives = typeof require === 'function' ? require('@deepseek-ai/dsh-client-ui-primitives') : null;
    // `MarkdownText` (like most of the shell's components) is a `memo()` object,
    // not a bare function — a `typeof === 'function'` test would silently send
    // every answer down the plain-text fallback.
    const candidate = primitives ? primitives.MarkdownText : null;
    if (typeof candidate === 'function' || (candidate !== null && typeof candidate === 'object')) {
      markdownBridge = candidate;
    }
  } catch (e) {
    markdownBridge = null;
  }
  return markdownBridge;
}

const markdownLabelCache = new Map();

/** Locale labels for the renderer, memoized per bound translator identity. */
function markdownLabels() {
  const cached = markdownLabelCache.get(t);
  if (cached) return cached;
  const labels = {
    code: { copyLabel: t('copy'), copiedLabel: t('copied') },
    footnotes: t('footnotes'),
  };
  markdownLabelCache.set(t, labels);
  return labels;
}

/**
 * A variant answer body: the official Markdown renderer when the primitives
 * package is available (the same component the chat view uses, so a variant and
 * a logged answer are typographically identical), plain text otherwise.
 * `streaming` is forwarded so a growing answer reuses the native streaming arms
 * (incremental code highlighting, unfinished fences).
 */
function AnswerBody(props) {
  const Markdown = markdownRenderer();
  if (Markdown !== null) {
    return h(Markdown, {
      text: props.text,
      labels: markdownLabels(),
      variant: 'body',
      ...props.streaming === true ? { streaming: true } : {},
    });
  }
  return h('div', { className: 'mtt-alt-text' }, props.text);
}

/**
 * The "an answer is being written" line: DSH's own shimmer text, so a variant
 * being generated looks like the app is generating, not like a plugin widget.
 * Falls back to a plain muted line when the primitives package is missing.
 */
function isComponent(value) {
  return typeof value === 'function' || (value !== null && typeof value === 'object');
}

function WaitLine(props) {
  const api = clientPrimitives();
  const Shimmer = api !== null && isComponent(api.TextShimmer) ? api.TextShimmer : null;
  if (Shimmer !== null) return h(Shimmer, { active: true }, props.label);
  return h('span', { className: 'mtt-wait-text' }, props.label);
}

/**
 * A translation that has not said anything yet says it by moving: three dots
 * bobbing in the translation column, where the text is about to be.
 */
function Dots() {
  return h('span', { className: 'mtt-dots', 'aria-hidden': 'true' },
    h('i', { key: 0 }), h('i', { key: 1 }), h('i', { key: 2 }));
}

/**
 * Keep one owner's mark on the generated stylesheet while mounted, so several
 * components can ask for the same turn to be hidden without fighting.
 */
function useHideRule(owner, turn, mode) {
  React.useEffect(function () {
    nativeHideStyle.set(owner, turn, mode);
    return function () { nativeHideStyle.set(owner, turn, null); };
  }, [owner, turn, mode]);
}

/**
 * Confirmations are banners, not row text: the row stays a row of icons, and a
 * short-lived toast at the top of the window says what just happened. DSH's own
 * `Toast` is used when the primitives package is there — it slides in, holds,
 * fades, and reports when it is done so the node can be unmounted.
 */
function nativeToast() {
  const api = clientPrimitives();
  return api && typeof api.Toast === 'function' ? api.Toast : null;
}

// A banner reports the outcome of an action that closed its own popover, so
// "did it work" needs no second look at the row. Success borrows the design's
// check; a failure keeps the warning seat the component draws by default —
// that is the only other tone the app's Toast offers.
function useToast() {
  const [message, setMessage] = React.useState(null);
  function show(text, tone) {
    if (text === null || text === undefined || text === '') return;
    setMessage({ text: text, tone: tone || 'success', id: (message ? message.id : 0) + 1 });
  }
  const Toast = nativeToast();
  const success = message !== null && message.tone === 'success';
  const node = message === null ? null
    : Toast !== null
      ? h(Toast, {
        key: message.id,
        text: message.text,
        ...success ? { tone: 'success' } : {},
        holdMs: success ? 2200 : 4200,
        onDone: function () { setMessage(null); },
      })
      : h('div', { key: message.id, className: 'mtt-toast' + (success ? ' mtt-toast-ok' : ' mtt-toast-bad') }, message.text);
  return [node, show];
}

// A failure keeps the sentence the host produced (it names the action and the
// reason); an unexpected throw still has to say something readable.
function failureText(error) {
  return String((error && error.message) || error || 'unknown error');
}

/** Editor for one answer: the model's own text, or a variant being rewritten. */
function AnswerEditBox(props) {
  const edit = props.edit;
  const [text, setText] = React.useState(edit.initial || '');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [toastNode, showToast] = useToast();

  function close() {
    store.setEdit(props.sessionId, props.turn, null);
  }

  async function save() {
    if (busy || text.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await answerMutate({
        action: 'answer-save', sessionId: props.sessionId, turn: props.turn, text: text,
      });
      store.setEdit(props.sessionId, props.turn, null);
      showToast(t('answerEdited'));
    } catch (e) {
      setError(failureText(e));
    }
    setBusy(false);
  }

  return h('div', { className: 'mtt-answer-edit' },
    h('div', { className: 'mtt-answer-edit-head' },
      h('span', { className: 'mtt-answer-edit-label' }, t('editing')),
      h('span', { className: 'mtt-answer-edit-tools' },
        h('button', {
          type: 'button', className: 'mtt-act', title: t('exitEdit'), onClick: close,
        }, h(CloseIcon)),
        h('button', {
          type: 'button',
          className: 'mtt-btn mtt-btn-small mtt-btn-primary',
          disabled: busy || text.trim().length === 0,
          onClick: save,
        }, t('save')))),
    h('textarea', {
      className: 'mtt-answer-edit-input',
      placeholder: t('answerEditHint'),
      value: text,
      spellCheck: false,
      onChange: function (event) { setText(event.target.value); },
      onKeyDown: function (event) {
        if (event.key === 'Escape') { event.preventDefault(); close(); return; }
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          save();
        }
      },
    }),
    error ? h('div', { className: 'mtt-error-inline' }, error) : null,
    toastNode);
}

/**
 * The answer card for one turn: the visible variant plus a ‹ 1/3 › ring whose
 * slot 0 is the model's own answer. Rendered through turnTail, so it sits in
 * the conversation flow exactly where the native answer would be — while the
 * native answer of that turn is hidden through the generated stylesheet above.
 */
/**
 * The answer of one finished turn, rendered in the flow like a normal answer:
 * either the variant the user selected, or the one still being written. The
 * logged answer is hidden by the stylesheet while this renders, so a switch of
 * model reads as "this turn now has a different answer", not as a second card.
 */
function AnswerCard(props) {
  const sessionId = props.sessionId;
  const turn = turnNumberOf(props.turn);
  const toolbar = useToolbar(sessionId);
  const state = toolbar && toolbar.state ? toolbar.state : null;
  const ring = answerRing(state ? state.answers : null, turn);
  const live = useLiveAnswer(sessionId, turn);
  const edit = useAnswerEdit(sessionId, turn);
  const hidden = hiddenOf(state, turn);
  const override = answerOverride(state ? state.answers : null, turn);
  // A translation does not replace the answer: it is drawn beside it, paragraph
  // by paragraph, the way an immersive translator lays a page out. So it is not a
  // variant — nothing is hidden for it except the logged body, which our paired
  // view re-draws itself.
  const translation = translationOf(state, turn);
  // A translation being written right now. It streams into its own column of the
  // paired page, so the reader watches the page arrive instead of a spinner.
  const liveTranslation = useLiveTranslation(sessionId, turn);
  const isNative = ring === null || ring.active.id === 'native';
  // A live stream shows even before the first variant exists: that is the point
  // of switching — the old answer goes away at once, the new one starts empty.
  // An open editor occupies the same place, so it hides the logged answer too,
  // and so does an edit of that logged answer (the override).
  const showingVariant = live !== null || !isNative || edit !== null || override !== null;
  // ...but a translation is drawn by this card as well, so it counts as "we are
  // painting the answer". Without it the early return below would fire while the
  // logged body is hidden for the translation: the answer area would be blank.
  const drawing = showingVariant || translation !== null || liveTranslation !== null;
  // A deleted answer takes its whole side with it — but only while nothing of ours
  // stands in its place. The moment an answer exists again (a variant chosen, a
  // stream running, an edit saved), the answer area belongs to that answer, so the
  // tail row this card lives in must stay: otherwise the fresh answer would be
  // hidden by the hole it is filling.
  const answerGone = hidden.answer && !showingVariant;

  // A translation only hides the logged body (our paired view draws the original
  // itself); a variant hides the body and everything that answer produced.
  useHideRule(
    'tail:' + turn,
    turn,
    hidden.turn
      ? 'turn'
      : answerGone
        ? 'deleted'
        : showingVariant ? 'answer' : (translation !== null || liveTranslation !== null) ? 'translate' : null,
  );

  // Deleting leaves nothing behind — no placeholder, no "restore" row. A hidden
  // turn hides its own tail row too (see the stylesheet rule), so there is
  // nothing to draw here anyway.
  if (hidden.turn || answerGone) return null;

  if (!drawing) {
    // A turn that ended without an answer has no native action row (DSH renders
    // that row only for a turn with a closing message), so the failed answer
    // would have no toolbar at all. This is the one place that draws it, with
    // the actions that make sense on nothing: retry, retry with another model,
    // delete.
    const info = turnInfo(state, turn);
    if (info !== undefined && info.answered === false && info.open !== true) {
      return h('div', { className: 'mtt-tail-actions' },
        h(AssistantToolbar, { sessionId: sessionId, turn: turn, failed: true }));
    }
    return null;
  }

  const active = isNative ? null : ring.active;
  const streamingText = live === null ? '' : live.text;
  // What is on screen: the stream while one runs, the selected variant, else the
  // user's own rewrite of the logged answer, else the logged answer itself (which
  // the native row renders when nothing of ours shows).
  const shownText = live !== null
    ? streamingText
    : active !== null
      ? active.text
      : override !== null
        ? override.text
        : translation !== null ? translation.text : '';
  // A thinking model narrates before it answers. That narration is this run's
  // own process, so it is shown above the answer the way the app shows a logged
  // turn's thinking — and the logged turn's own process card is hidden by the
  // stylesheet rule, so nothing of the old answer is left around it.
  const reasoning = live !== null
    ? (typeof live.reasoning === 'string' ? live.reasoning : '')
    : active !== null && typeof active.reasoning === 'string' ? active.reasoning : '';

  // A translation on screen reads as one paired page: the original paragraph,
  // then its translation, then the next paragraph — exactly where the answer
  // already was, so the layout does not move and nothing is covered. While one is
  // still arriving the page keeps the whole original in one block and grows the
  // translation under it, so text never jumps between blocks mid-stream; the two
  // dots-free version with paragraph pairs is drawn as soon as it is complete.
  if ((translation !== null || liveTranslation !== null) && edit === null && live === null) {
    const source = active !== null
      ? active.text
      : override !== null ? override.text : originOf(state, turn);
    const streaming = liveTranslation !== null;
    const pairs = streaming
      ? [{ source: source, translation: liveTranslation.text || '' }]
      : pairParagraphs(source, translation.text);
    const waiting = streaming && (liveTranslation.text || '').trim().length === 0;
    return h('div', { className: 'mtt-answer' },
      h('div', { className: 'mtt-pair' },
        pairs.map(function (pair, index) {
          const last = index === pairs.length - 1;
          // A sentence that was already in the target language comes back verbatim:
          // drawing it twice would read as a duplicate, so it is drawn once.
          const unchanged = !streaming && sameText(pair.source, pair.translation);
          return h('div', { key: index, className: 'mtt-pair-block' },
            pair.source === undefined ? null
              : h('div', { className: 'mtt-pair-src' }, h(AnswerBody, { text: pair.source })),
            unchanged ? null
              : h('div', { className: 'mtt-pair-tr' },
                waiting && last ? null : h(AnswerBody, { text: pair.translation, streaming: streaming }),
                streaming && last ? h(Dots, null) : null));
        })),
      !streaming && translation.truncated === true
        ? h('div', { className: 'mtt-pair-note' }, t('translationTruncated'))
        : null);
  }

  // Nothing of our own on screen: while the answer is still empty the native
  // shimmer line stands in for it, and from the first token on this is the
  // ordinary Markdown body — the same renderer the chat view uses, so an edited
  // answer keeps exactly the styling of a generated one. Editing takes that
  // place over: the source sits where the rendered text was.
  return h('div', { className: 'mtt-answer' },
    edit !== null
      ? h(AnswerEditBox, { sessionId: sessionId, turn: turn, edit: edit })
      : h(React.Fragment, null,
        reasoning.length > 0 ? h(ThinkingBlock, { reasoning: reasoning, live: live !== null }) : null,
        live !== null && streamingText.length === 0
          ? h('div', { className: 'mtt-answer-wait' }, h(WaitLine, { label: t('generating') }))
          : h('div', { className: 'mtt-answer-body' },
            h(AnswerBody, { text: shownText, streaming: live !== null }))));
}

/**
 * The run's own thinking, folded above the answer. Open while it streams, and
 * the reader can fold it away afterwards — the same shape as the app's process
 * card, drawn by us because a variant is generated outside any turn.
 */
function ThinkingBlock(props) {
  const [open, setOpen] = React.useState(props.live === true);
  const previous = React.useRef(props.live === true);
  // Collapse once the stream ends, so a finished answer is not hidden behind a
  // wall of thinking the way it is not for a logged turn either.
  React.useEffect(function () {
    if (previous.current !== props.live) {
      previous.current = props.live;
      setOpen(props.live === true);
    }
  }, [props.live]);
  return h('div', { className: 'mtt-think' },
    h('button', {
      type: 'button',
      className: 'mtt-think-head' + (open ? ' mtt-think-open' : ''),
      onClick: function () { setOpen(!open); },
      'aria-expanded': open ? 'true' : 'false',
    }, h(ChevronRightIcon),
    props.live === true
      ? h(WaitLine, { label: t('thinking') })
      : h('span', null, t('thought'))),
    open ? h('div', { className: 'mtt-think-body' }, props.reasoning) : null);
}

/**
 * Per-turn facts the host derives from the log, keyed by turn number: `text` of
 * the user message, `open` for a turn that has not ended, `answered` once the
 * turn got a durable answer, and `reason` (the `turn/end` kind).
 */
function turnInfo(state, turn) {
  const turns = state && Array.isArray(state.turns) ? state.turns : null;
  if (turns === null || typeof turn !== 'number') return undefined;
  return turns.find(function (item) { return item.turn === turn; });
}

/* ----------------------------------------------------------------- turn rail -- */

/**
 * The rail on the right is fed from two places: the host's `turnOutline`
 * projection (every turn, loaded or not) and the chat view's own navigation
 * items, which win for a turn that is loaded. Both fold the session log — so
 * neither knows about an answer variant we never logged, nor about a row the
 * user deleted. Without help the rail keeps showing the logged answer and the
 * original prompt, and keeps listing a turn that is no longer on screen.
 *
 * This patches the second source: the chat target snapshot behind
 * `uiConversation`. Loaded entries are exactly the turns the user is looking at,
 * so rewriting them here keeps the rail in step with the transcript, and the
 * patch rides along with the app's own publishing instead of replacing it.
 *
 * Everything is guarded — an absent service, a missing `target('chat')`, or an
 * unfamiliar snapshot shape leaves the rail exactly as it was.
 */
const RAIL_PREVIEW_CAP = 120;

/**
 * The host's `turnOutline` projection for one session — one entry per
 * `turn/start`. Read-only: this plugin never writes a projection (registrants
 * sharing a key share one unit, so a second writer would fight the host's own
 * frames). `null` when the session controller does not expose it.
 */
function railOutline(sessionId) {
  const service = sessionsService;
  if (!service || typeof service.projectionStore !== 'function') return null;
  try {
    const store = service.projectionStore(sessionId);
    if (!store || typeof store.values !== 'function') return null;
    const values = store.values();
    const outline = values ? values.turnOutline : null;
    return Array.isArray(outline) ? outline : null;
  } catch (error) {
    return null;
  }
}

/** One rail line: whitespace collapsed, capped like the host's own preview. */
function railPreview(text) {
  if (typeof text !== 'string') return '';
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= RAIL_PREVIEW_CAP) return flat;
  return flat.slice(0, RAIL_PREVIEW_CAP - 1).replace(/[\s,;:]$/, '') + '…';
}

/**
 * What this turn actually shows: the answer being streamed right now, else the
 * selected variant, else the user's rewrite of the logged answer. `null` when
 * the logged answer is the one on screen (nothing to override).
 */
function railAnswerText(state, sessionId, turn) {
  const live = store.getLive(sessionId, turn);
  if (live !== null && typeof live.text === 'string' && live.text.trim() !== '') return live.text;
  const answers = state && state.answers;
  if (!answers) return null;
  const entry = answers[String(turn)];
  if (!entry) return null;
  const items = Array.isArray(entry.items) ? entry.items : [];
  if (typeof entry.active === 'string' && entry.active !== 'native') {
    const picked = items.find(function (item) { return item && item.id === entry.active; });
    if (picked && typeof picked.text === 'string') return picked.text;
  }
  if (entry.override && typeof entry.override.text === 'string') return entry.override.text;
  return null;
}

/** Rewrite or drop the rail entries that no longer match the transcript. */
function patchRailItems(items, state, sessionId) {
  const hidden = state && state.hidden ? state.hidden : {};
  // Only whole-turn deletions drop entries here. A replayed prompt is a turn that
  // exists in the projection from the moment it starts, so it is hidden by
  // position in the ladder instead (removing it from this list would shift every
  // later index).
  const gone = Array.isArray(hidden.turns) ? hidden.turns : [];
  const out = [];
  let changed = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item.turn !== 'number') { out.push(item); continue; }
    if (gone.indexOf(item.turn) !== -1) { changed = true; continue; }
    const text = railAnswerText(state, sessionId, item.turn);
    if (text === null) { out.push(item); continue; }
    const response = railPreview(text);
    if (response === '' || response === item.response) { out.push(item); continue; }
    changed = true;
    out.push(Object.assign({}, item, { response: response }));
  }
  return changed ? out : items;
}

/** The same navigation object with one patched entry point. */
function railNavigation(navigation, items) {
  const patched = Object.create(Object.getPrototypeOf(navigation) || Object.prototype);
  Object.assign(patched, navigation);
  patched.items = function () { return items; };
  return patched;
}

/**
 * Every turn the rail knows about, in ladder order. The rail merges the host's
 * `turnOutline` projection (one entry per `turn/start`, loaded or not) with the
 * chat view's loaded items, and a deleted turn cannot be removed from the
 * projection half — so its mark has to be hidden by position instead. The
 * position is its index in that merged ladder, which we rebuild here: the
 * projection is a fold of the same log, so its turns are the ladder.
 */
function railLadder(sessionId, state) {
  const outline = railOutline(sessionId);
  const turns = [];
  // The union of both folds of the log: the projection is pushed by the host and
  // can lag a frame behind a turn that was just created (a replayed prompt, for
  // one), while `state.turns` comes from the log we just read. Taking both keeps
  // the ladder — and therefore every hidden position — aligned with what the rail
  // actually draws.
  if (outline !== null) {
    for (let i = 0; i < outline.length; i++) {
      const entry = outline[i];
      if (entry && typeof entry.turn === 'number') turns.push(entry.turn);
    }
  }
  if (state && Array.isArray(state.turns)) {
    for (let i = 0; i < state.turns.length; i++) {
      const entry = state.turns[i];
      if (entry && typeof entry.turn === 'number') turns.push(entry.turn);
    }
  }
  const unique = [];
  turns.sort(function (a, b) { return a - b; });
  for (let i = 0; i < turns.length; i++) {
    if (i === 0 || turns[i] !== turns[i - 1]) unique.push(turns[i]);
  }
  return unique;
}

/**
 * Hide the rail marks of deleted turns. They cannot be dropped from the
 * projection half of the ladder, so the only lever is the mark's own position —
 * `data-index` is the index in the merged list we just rebuilt.
 */
const railHideStyle = {
  node: null,
  key: '',

  ensure() {
    if (this.node) return this.node;
    if (typeof document === 'undefined' || !document.head) return null;
    const node = document.createElement('style');
    node.dataset.plugin = 'dsh-message-toolbar-rail';
    document.head.appendChild(node);
    this.node = node;
    return node;
  },

  apply(indexes) {
    const node = this.ensure();
    if (!node) return;
    const key = indexes.join(',');
    if (key === this.key) return;
    this.key = key;
    node.textContent = indexes.map(function (index) {
      return 'nav button[data-index="' + index + '"]{display:none}';
    }).join('\n');
  },
};

/** A chat snapshot whose navigation items follow the transcript. */
function railSnapshot(snapshot, sessionId) {
  const cached = store.get(sessionId);
  const state = cached && cached.state;
  const hidden = state && state.hidden ? state.hidden : null;
  const goneTurns = hidden && Array.isArray(hidden.turns) ? hidden.turns : [];
  // A replayed prompt opens a turn of its own; that turn is real, so its rail
  // item would read as a second copy of the same question. Hide it too.
  const gonePrompts = hidden && Array.isArray(hidden.prompts) ? hidden.prompts : [];
  const gone = gonePrompts.length === 0 ? goneTurns : goneTurns.concat(gonePrompts);
  // Always write the sheet, empty included: switching to a session with nothing
  // hidden has to drop the previous session's marks, not keep them hidden.
  if (gone.length === 0) railHideStyle.apply([]);
  else {
    const ladder = railLadder(sessionId, state);
    const indexes = [];
    for (let i = 0; i < ladder.length; i++) {
      if (gone.indexOf(ladder[i]) !== -1) indexes.push(i);
    }
    railHideStyle.apply(indexes);
  }
  if (!state) return snapshot;
  const navigation = snapshot.navigation;
  if (!navigation || typeof navigation.items !== 'function') return snapshot;
  const items = navigation.items();
  if (!Array.isArray(items)) return snapshot;
  const patched = patchRailItems(items, state, sessionId);
  if (patched === items) return snapshot;
  return Object.assign({}, snapshot, { navigation: railNavigation(navigation, patched) });
}

// One patched snapshot per host snapshot, shared by every wrapper: the chat view
// subscribes to the target it asked for, and re-reading the same snapshot has to
// hand back the same list or the rail would rebuild on every render.
const railMemo = new WeakMap();

/** Wrap one chat target so its snapshot carries the rails patch. */
function railTarget(target, sessionId) {
  return {
    getSnapshot: function () {
      const snapshot = target.getSnapshot();
      if (!snapshot || typeof snapshot !== 'object') return snapshot;
      const version = store.railVersion;
      const hit = railMemo.get(snapshot);
      if (hit !== undefined && hit.version === version) return hit.value;
      const value = railSnapshot(snapshot, sessionId);
      railMemo.set(snapshot, { version: version, value: value });
      return value;
    },
    subscribe: function (listener) {
      const offInner = typeof target.subscribe === 'function' ? target.subscribe(listener) : function () {};
      // Our own state changes without a host frame, so the rail has to hear
      // about those from us: this is how a switch or a delete repaints it.
      const offOurs = store.subscribe(function () { listener(); });
      return function () { offInner(); offOurs(); };
    },
  };
}

/**
 * Install the rail patch by wrapping `uiConversation.binding`. The binding is
 * cached by the app, so the wrapper is cached here too — one proxy per binding,
 * one memo per snapshot.
 * @param ctx - the plugin's client context.
 * @returns the disposer that restores the untouched service.
 */
function installRailSync(ctx) {
  const conversation = ctx.get('uiConversation');
  if (!conversation || typeof conversation.binding !== 'function') return undefined;
  const original = conversation.binding;
  const cache = new WeakMap();
  const wrapped = function (source) {
    const real = original.call(conversation, source);
    if (real === null || typeof real !== 'object') return real;
    const existing = cache.get(real);
    if (existing !== undefined) return existing;
    const sessionId = typeof source === 'string' ? source : (source && source.sessionId);
    const proxy = new Proxy(real, {
      get: function (inner, prop) {
        if (prop === 'target') {
          return function (name) {
            const target = inner.target(name);
            if (name !== 'chat' || target === null || typeof target !== 'object') return target;
            return railTarget(target, sessionId);
          };
        }
        const value = Reflect.get(inner, prop, inner);
        return typeof value === 'function' ? value.bind(inner) : value;
      },
    });
    cache.set(real, proxy);
    return proxy;
  };
  try {
    conversation.binding = wrapped;
  } catch (error) {
    // A frozen service object means no rail sync; the stock rail still works.
    return undefined;
  }
  return function () { conversation.binding = original; };
}

/* --------------------------------------------------------------- components -- */

/**
 * The user bubble. Replaces the native renderer when no other plugin shadows
 * it (registered with priority -1; a collision degrades to "they win").
 */
function UserMessageView(props) {
  const node = props.node;
  const data = node.data || {};
  const text = contentText(data.content);
  const images = imageCount(data.content);
  const imageBlocks = imageParts(data.content);
  const sessionId = props.sessionId !== undefined ? props.sessionId : node.sessionId;
  const rawTurn = node.location ? node.location.turn : undefined;
  const turn = typeof rawTurn === 'number' ? rawTurn : (rawTurn && typeof rawTurn.turn === 'number' ? rawTurn.turn : undefined);

  const prefs = usePrefs();
  const list = useSessionList();
  useFocusPending(sessionId);
  const summary = sessionId !== undefined ? list.byId[sessionId] : undefined;
  const running = !!(summary && summary.running);
  const toolbar = useToolbar(sessionId);
  const state = toolbar && toolbar.state ? toolbar.state : null;
  const versions = state ? state.versions : null;
  const ring = typeof turn === 'number' ? ringFor(versions, sessionId, turn) : null;
  const self = versions && versions.find(function (v) { return v.sessionId === sessionId; });
  const isVersion = !!(self && self.parentSessionId);

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmHide, setConfirmHide] = React.useState(false);
  const [popUp, setPopUp] = React.useState(false);
  // Anchors for the portalled confirm boxes: the popover measures the button it
  // belongs to instead of sitting inside the row (where the row would cover it).
  const hideAnchor = React.useRef(null);
  const cardAnchor = React.useRef(null);
  const [toastNode, showToast] = useToast();

  useDismiss(confirmDelete || confirmHide, function () {
    setConfirmDelete(false);
    setConfirmHide(false);
  });

  const canEdit = !running && sessionId !== undefined && typeof turn === 'number' && text !== '' && !editing;

  function beginEdit() {
    setDraft(text);
    setError(null);
    setEditing(true);
  }

  async function submit() {
    const blockIndex = firstTextBlockIndex(data.content);
    // An unchanged draft is still a resend: it branches and regenerates.
    if (blockIndex === -1 || draft.trim() === '') { setEditing(false); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        action: 'edit',
        sessionId: sessionId,
        eventSeq: data.seq,
        blockIndex: blockIndex,
        text: draft,
        stopPrevious: prefs.stopPrevious,
      });
      store.invalidate();
      setEditing(false);
      switchToVersion(navigation, { sessionId: result.sessionId }, sessionId);
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  // "Regenerate" from a user bubble answers the same turn again **in place**,
  // exactly like the assistant toolbar's button: the new answer becomes a
  // variant of this turn, so no second conversation appears. Editing the prompt
  // is the branch path — the logged prompt itself cannot be rewritten.
  //
  // The one exception is a turn whose answer is gone (deleted, or never produced
  // because it failed): there the answer area holds nothing to replace, and an
  // in-place text answer would be a poor stand-in — the reader asked a question
  // that has no answer, and expects the app to answer it for real, with the
  // thinking chain and tool cards it shows for any new message.
  //
  // A closed turn cannot take a second assistant message (the log forbids it), so
  // the only way to get that live page is a fresh turn. We replay this prompt as
  // a new user message in the same session and mark that turn's prompt as hidden:
  // the question stays where it is, and under it DSH runs an ordinary turn —
  // thinking, tools, streaming, all native. The cost is one extra turn in the
  // log (invisible, and hidden from the rail too), which is the price of a real
  // answer rather than a text-only stand-in.
  async function retry() {
    if (typeof turn !== 'number') return;
    const info = turnInfo(state, turn);
    const rows = hiddenOf(state, turn);
    const gone = rows.answer || (info !== undefined && info.answered === false);
    if (gone) {
      setBusy(true);
      setError(null);
      try {
        const result = await mutate({
          action: 'answer-run', sessionId: sessionId, turn: turn, stopPrevious: prefs.stopPrevious,
        });
        if (result && typeof result.turn === 'number' && result.turn !== turn) {
          await mutate({
            action: 'hide', sessionId: sessionId, turn: result.turn, scope: 'prompt', hidden: true,
          });
        }
        store.invalidate();
      } catch (e) {
        showToast(failureText(e), 'error');
      }
      setBusy(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await generateInto(sessionId, turn, undefined);
      showToast(t('answerGenerated'));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  function copy() {
    const g = realGlobal();
    try {
      if (g && g.navigator && g.navigator.clipboard) g.navigator.clipboard.writeText(text);
    } catch (e) {}
    setCopied(true);
    setTimeout(function () { setCopied(false); }, 1200);
  }

  async function removeVersion() {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await mutate({ action: 'delete-version', sessionId: sessionId });
      store.invalidate();
      showToast(t('deletedCard'));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  // "Delete this message" removes the turn from the transcript view only: the
  // log is append-only, so the row is hidden here and the tail row offers the
  // undo. Handy right after a stalled turn left "continue" prompts behind.
  async function hideTurn() {
    setConfirmHide(false);
    if (typeof turn !== 'number') return;
    setBusy(true);
    setError(null);
    try {
      await hideMutate({
        action: 'hide', sessionId: sessionId, turn: turn, scope: 'turn', hidden: true,
      });
      showToast(t('turnHidden'));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  if (editing) {
    return h('div', { className: 'mtt-row mtt-editing' },
      h('div', { className: 'mtt-editor' },
        h('textarea', {
          className: 'mtt-textarea',
          value: draft,
          autoFocus: true,
          rows: Math.min(10, Math.max(3, draft.split('\n').length + 1)),
          onChange: function (e) { setDraft(e.target.value); },
          onKeyDown: function (e) {
            if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          },
        }),
        images > 0 ? h('div', { className: 'mtt-hint' }, t('imagesKept', { count: images })) : null,
        h(ErrorChip, { error: error }),
        h('div', { className: 'mtt-editor-actions' },
          h('button', { type: 'button', className: 'mtt-btn', disabled: busy, onClick: function () { setEditing(false); } }, t('cancel')),
          h('button', {
            type: 'button', className: 'mtt-btn mtt-btn-primary',
            disabled: busy || draft.trim() === '',
            onClick: submit,
          }, busy ? t('sending') : t('send')),
          h('span', { className: 'mtt-hint' }, t('shortcutHint')))));
  }

  // A prompt we replayed to get a real answer out of the agent stays in the log
  // (the log cannot rewrite itself) but never shows up as a second question: the
  // turn it opened is marked as a prompt to hide, and this row is that turn's
  // prompt, so it renders nothing at all.
  const rows = hiddenOf(state, turn);
  if (rows.prompt) return null;

  return h('div', { className: 'mtt-row', 'data-turn': turn, 'data-session': sessionId },
    h('div', { className: 'mtt-line' },
      h('div', { className: 'mtt-bubble' },
        h('div', { className: 'mtt-text' }, text),
        imageBlocks.length > 0 && typeof props.renderMessageImages === 'function'
          ? props.renderMessageImages({ images: imageBlocks, align: 'end' })
          : (images > 0 ? h('div', { className: 'mtt-hint' }, t('imagesKept', { count: images })) : null))),
    h('div', { className: 'mtt-actions' },
      h(VersionRing, { ring: ring }),
      isVersion && self && self.model ? h(ModelChip, { model: self.model, title: t('modelCard') }) : null,
      h(ActionButton, {
        title: copied ? t('copied') : t('copy'),
        onClick: copy,
      }, copied ? h(CheckIcon) : h(CopyIcon)),
      h(ActionButton, { title: t('edit'), disabled: !canEdit, onClick: beginEdit, act: 'edit' }, h(PencilIcon)),
      h(ActionButton, { title: t('regenerate'), disabled: !canEdit || busy, onClick: retry, act: 'retry' }, h(RetryIcon)),
      // Delete this turn from the transcript view (the log keeps every event).
      // A version card is an entry of the version family rather than a row of
      // this transcript, so it gets the card delete below instead of both: one
      // trash per row, never two.
      isVersion
        ? null
        : h('span', { className: 'mtt-menu-wrap' },
          h('span', { className: 'mtt-anchor', ref: hideAnchor },
            h(ActionButton, {
              title: t('deleteMessage'),
              disabled: busy || typeof turn !== 'number',
              active: confirmHide,
              act: 'delete-turn',
              onClick: function (event) {
                setPopUp(popupOpensUp(event));
                setConfirmHide(!confirmHide);
              },
            }, h(TrashIcon))),
          h(Popover, { open: confirmHide, anchor: hideAnchor, up: popUp },
            h('div', { className: 'mtt-pop-title' }, t('deleteMessageConfirm')),
            h('div', { className: 'mtt-pop-actions' },
              h('button', { type: 'button', className: 'mtt-btn', onClick: function () { setConfirmHide(false); } }, t('cancel')),
              h('button', { type: 'button', className: 'mtt-btn mtt-btn-danger', onClick: hideTurn }, t('delete'))))),
      // No translate action on user bubbles: the bubbled prompt is already the
      // language the user wrote in, and the useful direction to read is the
      // answer's. Translation lives on assistant cards only.
      isVersion
        ? h('span', { className: 'mtt-menu-wrap' },
          h('span', { className: 'mtt-anchor', ref: cardAnchor },
            h(ActionButton, {
              title: t('deleteCard'), disabled: busy, active: confirmDelete, act: 'delete-card',
              onClick: function (event) {
                setPopUp(popupOpensUp(event));
                setConfirmDelete(!confirmDelete);
              },
            }, h(TrashIcon))),
          h(Popover, { open: confirmDelete, anchor: cardAnchor, up: popUp },
            h('div', { className: 'mtt-pop-title' }, t('deleteCardConfirm')),
            h('div', { className: 'mtt-pop-actions' },
              h('button', { type: 'button', className: 'mtt-btn', onClick: function () { setConfirmDelete(false); } }, t('cancel')),
              h('button', { type: 'button', className: 'mtt-btn mtt-btn-danger', onClick: removeVersion }, t('delete')))))
        : null),
    h(ErrorChip, { error: error }),
    toastNode);
}

/**
 * Per-message toolbar entries on the assistant action row. The framework
 * hands us the durable `messageId`; inject(sessionId) adds the session scope.
 */
function AssistantToolbar(props) {
  const sessionId = props.sessionId;
  const messageId = props.messageId;
  const prefs = usePrefs();
  const toolbar = useToolbar(sessionId);
  useFocusPending(sessionId);
  const state = toolbar && toolbar.state ? toolbar.state : null;
  const messages = state ? state.messages : null;
  const versions = state ? state.versions : null;
  const message = messages && messages.find(function (m) { return m.id === messageId; });
  const self = versions && versions.find(function (v) { return v.sessionId === sessionId; });
  const isVersion = !!(self && self.parentSessionId);
  const turn = typeof props.turn === 'number' ? props.turn : (message ? message.turn : undefined);
  // A failed turn has no answer, so the row offers only what makes sense on
  // nothing: retry, retry with another model, delete. No edit, no translate —
  // there is no text to edit and nothing to translate.
  const failed = props.failed === true;
  const ring = answerRing(state ? state.answers : null, turn);
  const live = useLiveAnswer(sessionId, turn);
  // The trash deletes what is on screen: the selected variant when the answer
  // is a variant, the logged answer (a view-level hide) when it is the original.
  const deletingVariant = live === null && ring !== null && ring.active.id !== 'native';
  // The turn is showing a translation when the host says which language, and the
  // button then reads as "on" and its menu offers the way back.
  const shownLang = shownLangOf(state, turn);

  // Hiding the turn's rows is the answer card's job, not the toolbar's: the card
  // knows whether it is showing an answer of its own (in which case the deleted
  // mark must not hide the very row this toolbar lives in). One owner per turn
  // keeps the generated stylesheet free of conflicting marks.

  // The row the picker marks as current: the model the visible answer came
  // from, or the session's configured model when the logged answer is showing.
  function currentModel() {
    const answers = state ? state.answers : null;
    const slot = answers && typeof turn === 'number' ? answers[turn] : null;
    const items = slot && Array.isArray(slot.items) ? slot.items : [];
    const active = slot && slot.active && slot.active !== 'native'
      ? items.find(function (item) { return item.id === slot.active; })
      : null;
    if (active && active.provider && active.model) return { provider: active.provider, model: active.model };
    const base = state ? state.model : null;
    return base && base.provider && base.model ? { provider: base.provider, model: base.model } : null;
  }

  const [menu, setMenu] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  // Translating has a button of its own to report on, so it keeps its own flag:
  // the translate icon turns into a spinner while the answer is being fetched and
  // becomes the glyph again once it lands (or fails).
  const [translating, setTranslating] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [toastNode, showToast] = useToast();
  const [catalog, setCatalog] = React.useState(null);
  const [catalogError, setCatalogError] = React.useState(null);
  const edit = useAnswerEdit(sessionId, turn);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmAnswer, setConfirmAnswer] = React.useState(false);
  const [popUp, setPopUp] = React.useState(false);
  const answerAnchor = React.useRef(null);
  const cardAnchor = React.useRef(null);

  // Busy while a request of this row is in flight, and while an answer of this
  // turn is still being written by anyone (this row, the card, or a bubble).
  const working = busy || live !== null;

  // An answer being written already owns the last ring slot, so the control
  // reads 2/2 from the first click instead of popping in when the stream ends.
  const ringView = live !== null
    ? {
      count: (ring === null ? 1 : ring.alternatives.length) + 1,
      index: ring === null ? 0 : ring.alternatives.length,
    }
    : ring === null ? null : { count: ring.alternatives.length, index: ring.index };

  // The native dropdowns (model picker, language picker) dismiss themselves
  // (outside click, Escape, pointer leave), so this listener must not fight
  // them: it only closes our own popovers.
  const nativeMenus = clientPrimitives() !== null;
  useDismiss(
    (menu !== null && !(nativeMenus && (menu === 'model' || menu === 'translate')))
      || confirmDelete || confirmAnswer,
    function () {
      setMenu(null);
      setConfirmDelete(false);
      setConfirmAnswer(false);
    },
  );

  // Every menu in this row records whether it must open upwards, so the last
  // message of a conversation is not covered by the composer.
  function toggleMenu(name, event) {
    setPopUp(popupOpensUp(event));
    setMenu(menu === name ? null : name);
  }

  function openModelMenu(event) {
    setPopUp(popupOpensUp(event));
    setMenu(menu === 'model' ? null : 'model');
    if (catalog || catalogError) return;
    setBusy(true);
    fetchModels().then(function (value) {
      setCatalog(value);
    }).catch(function (e) {
      setCatalogError(String((e && e.message) || e));
    }).then(function () {
      setBusy(false);
    });
  }

  // "Regenerate" and "switch model" no longer branch the conversation: the new
  // answer is stored as a variant of this turn and swapped in place (see
  // AnswerCard), so the conversation stays one conversation. The branch path
  // is still one click away in the model menu for a full agent run with tools.
  async function regenerate() {
    if (typeof turn !== 'number') return;
    setBusy(true);
    setError(null);
    try {
      const info = currentModel();
      await generateInto(sessionId, turn, info === null ? undefined : info);
      showToast(t('answerGenerated'));
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  async function switchModel(model) {
    setMenu(null);
    if (typeof turn !== 'number') return;
    setBusy(true);
    setError(null);
    try {
      await generateInto(sessionId, turn, {
        provider: model.provider, model: model.model, name: model.name,
      });
      showToast(t('answerGeneratedBy', { name: modelLabel(model) }));
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  /** Walk the ring of answers of this turn, native first. */
  async function stepAnswer(delta) {
    const current = answerRing(state ? state.answers : null, turn);
    if (current === null || busy) return;
    const next = current.alternatives[current.index + delta];
    if (next === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await answerMutate({
        action: 'answer-select', sessionId: sessionId, turn: turn, id: next.id,
      });
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  /** The old behaviour, kept as an explicit choice: a real branch with tools. */
  async function branchVersion() {
    setMenu(null);
    if (typeof turn !== 'number') return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        action: 'retry', sessionId: sessionId, turn: turn, stopPrevious: prefs.stopPrevious,
      });
      store.invalidate();
      switchToVersion(navigation, { sessionId: result.sessionId }, sessionId);
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  // The editor itself lives in the answer area (AnswerCard): this row only asks
  // the host for the current source and hands it over through the store, so
  // pressing the pencil a second time closes that editor again.
  async function openAnswerEditor() {
    if (typeof turn !== 'number') return;
    if (store.getEdit(sessionId, turn) !== null) {
      store.setEdit(sessionId, turn, null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const source = await mutate({ action: 'answer-source', sessionId: sessionId, turn: turn });
      store.setEdit(sessionId, turn, { initial: source.text || '' });
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  /**
   * Translate what the turn is showing, in place. A variant or an edited answer
   * is not in the log, so it travels as text; the logged answer travels as its
   * event seq. Either way the turn afterwards draws the translation instead of
   * the answer, through the same markdown body — no second panel appears.
   */
  async function translate(lang) {
    setMenu(null);
    if (typeof turn !== 'number') { setError(t('messageNotIndexed')); return; }
    // Remember the choice so the menu ticks it next time; the model used for
    // translating is the host's default (the one that answered the turn).
    prefsStore.set({ lang: lang });
    const ringNow = answerRing(state ? state.answers : null, turn);
    const override = answerOverride(state ? state.answers : null, turn);
    const onScreen = ringNow !== null && ringNow.active.id !== 'native'
      ? ringNow.active.text
      : override !== null ? override.text : '';
    const body = { lang: lang };
    if (typeof onScreen === 'string' && onScreen.length > 0) {
      body.turn = turn;
      body.text = onScreen;
    } else if (message) {
      body.eventSeq = message.seq;
    } else {
      setError(t('messageNotIndexed'));
      return;
    }
    setBusy(true);
    setTranslating(true);
    setError(null);
    try {
      await translateInto(sessionId, turn, body);
      showToast(t('translated'));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setTranslating(false);
    setBusy(false);
  }

  /** Fold the translation away; the original stays where it always was, and the translation stays cached. */
  async function showOriginal() {
    setMenu(null);
    if (typeof turn !== 'number') return;
    setBusy(true);
    try {
      await mutate({ action: 'translate-off', sessionId: sessionId, turn: turn });
      store.patchShown(sessionId, turn, null);
      showToast(t('translationHidden'));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  async function removeVersion() {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await mutate({ action: 'delete-version', sessionId: sessionId });
      store.invalidate();
      showToast(t('deletedCard'));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  /**
   * Delete the answer that is on screen. A variant is dropped from the ring and
   * the previous answer takes its place; the logged answer can only be hidden
   * (the turn's tail row keeps the undo), because the log is append-only.
   */
  async function deleteVisible() {
    setConfirmAnswer(false);
    if (typeof turn !== 'number') return;
    setBusy(true);
    setError(null);
    try {
      const current = answerRing(state ? state.answers : null, turn);
      if (current !== null && current.active.id !== 'native') {
        await answerMutate({
          action: 'answer-delete', sessionId: sessionId, turn: turn, id: current.active.id,
        });
        showToast(t('variantDeleted'));
      } else if (failed) {
        // A failed turn has no answer row, only an error banner and this action
        // row — both belong to the answer that never arrived, so they leave the
        // same way an answer does. The prompt stays: deleting the answer is not
        // deleting the question.
        await hideMutate({
          action: 'hide', sessionId: sessionId, turn: turn, scope: 'answer', hidden: true,
        });
        showToast(t('answerHidden'));
      } else {
        await hideMutate({
          action: 'hide', sessionId: sessionId, turn: turn, scope: 'answer', hidden: true,
        });
        showToast(t('answerHidden'));
      }
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  return h('span', { className: 'mtt-toolbar' },
    h(ActionButton, {
      title: t('regenerate'), disabled: working || typeof turn !== 'number', onClick: regenerate,
    }, h(RetryIcon)),
    failed
      ? null
      : h(ActionButton, {
        title: edit !== null ? t('exitEdit') : t('editAnswer'), active: edit !== null,
        disabled: working || typeof turn !== 'number',
        onClick: openAnswerEditor,
      }, h(PencilIcon)),
    h(ModelMenuHost, {
      title: t('switchModel'),
      open: menu === 'model',
      up: popUp,
      disabled: working,
      loading: busy,
      catalog: catalog,
      selected: currentModel(),
      branchLabel: t('branchInstead'),
      onBranch: branchVersion,
      onPick: switchModel,
      onToggle: openModelMenu,
      onClose: function () { setMenu(null); },
    }),
    failed
      ? null
      : h(LanguageMenuHost, {
        title: shownLang === null ? t('translate') : t('translatedTo'),
        busyTitle: t('translating'),
        busy: translating,
        pickTitle: t('translateTo'),
        open: menu === 'translate',
        up: popUp,
        disabled: busy || typeof turn !== 'number',
        active: shownLang !== null,
        current: shownLang !== null ? shownLang : prefs.lang,
        original: shownLang !== null,
        originalLabel: t('hideTranslation'),
        onOriginal: showOriginal,
        onToggle: function (event) { toggleMenu('translate', event); },
        onPick: translate,
        onClose: function () { setMenu(null); },
      }),
    // One trash per row. A version card deletes the whole version (below), so the
    // row-level delete steps aside instead of sitting next to it.
    isVersion
      ? null
      : h('span', { className: 'mtt-menu-wrap' },
        h('span', { className: 'mtt-anchor', ref: answerAnchor },
          h(ActionButton, {
            title: failed ? t('deleteMessage') : (deletingVariant ? t('deleteVariant') : t('deleteAnswer')),
            active: confirmAnswer,
            disabled: working || typeof turn !== 'number',
            act: failed ? 'delete-turn' : 'delete-answer',
            onClick: function (event) {
              setPopUp(popupOpensUp(event));
              setConfirmAnswer(!confirmAnswer);
            },
          }, h(TrashIcon))),
        h(Popover, { open: confirmAnswer, anchor: answerAnchor, up: popUp },
          h('div', { className: 'mtt-pop-title' },
            failed ? t('deleteMessageConfirm') : (deletingVariant ? t('deleteVariantConfirm') : t('deleteAnswerConfirm'))),
          h('div', { className: 'mtt-pop-actions' },
            h('button', { type: 'button', className: 'mtt-btn', onClick: function () { setConfirmAnswer(false); } }, t('cancel')),
            h('button', { type: 'button', className: 'mtt-btn mtt-btn-danger', onClick: deleteVisible }, t('delete'))))),
    // The answer ring sits in this row — always at the bottom of the turn, next
    // to the other controls — and only when there is something to switch to.
    ringView !== null && ringView.count > 1
      ? h('span', { className: 'mtt-ring', title: t('variants') },
        h('button', {
          type: 'button', className: 'mtt-ring-btn', disabled: working || ringView.index <= 0,
          title: t('prevAnswer'), onClick: function () { stepAnswer(-1); },
        }, h(ChevronLeftIcon)),
        h('span', { className: 'mtt-ring-count' }, (ringView.index + 1) + '/' + ringView.count),
        h('button', {
          type: 'button', className: 'mtt-ring-btn',
          disabled: working || ringView.index >= ringView.count - 1,
          title: t('nextAnswer'), onClick: function () { stepAnswer(1); },
        }, h(ChevronRightIcon)))
      : null,
    isVersion
      ? h('span', { className: 'mtt-menu-wrap' },
        h('span', { className: 'mtt-anchor', ref: cardAnchor },
          h(ActionButton, {
            title: t('deleteCard'), active: confirmDelete,
            onClick: function (event) {
              setPopUp(popupOpensUp(event));
              setConfirmDelete(!confirmDelete);
            },
          }, h(TrashIcon))),
        h(Popover, { open: confirmDelete, anchor: cardAnchor, up: popUp },
          h('div', { className: 'mtt-pop-title' }, t('deleteCardConfirm')),
          h('div', { className: 'mtt-pop-actions' },
            h('button', { type: 'button', className: 'mtt-btn', onClick: function () { setConfirmDelete(false); } }, t('cancel')),
            h('button', { type: 'button', className: 'mtt-btn mtt-btn-danger', onClick: removeVersion }, t('delete')))))
      : null,
    h(ErrorChip, { error: error || catalogError }),
    toastNode);
}

/**
 * The Versions view: the whole branch family as an indented tree with model
 * chips, current marker and restore controls for deleted cards.
 */
function VersionsView(props) {
  const sessionId = props.sessionId;
  const toolbar = useToolbar(sessionId);
  useFocusPending(sessionId);
  const state = toolbar && toolbar.state ? toolbar.state : null;
  const versions = state ? state.versions : null;
  const [busy, setBusy] = React.useState(null);
  const [error, setError] = React.useState(null);

  if (!state) {
    return h('div', { className: 'mtt-view mtt-view-empty' },
      t(toolbar && toolbar.error ? 'loadError' : 'loading'));
  }

  const nodes = buildTurnTree(versions, sessionId);

  async function restore(node) {
    setBusy(node.sessionId);
    setError(null);
    try {
      await mutate({ action: 'restore-version', sessionId: node.sessionId });
      store.invalidate();
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(null);
  }

  const rows = nodes.map(function (node) {
    const isRoot = node.isRoot === true;
    const indent = { paddingLeft: (8 + node.depth * 18) + 'px' };
    const title = isRoot
      ? t('originalConversation')
      : (node.operation === 'edit' ? t('editedTurn', { turn: node.turn }) : t('retriedTurn', { turn: node.turn }));
    return h('div', {
      key: node.id,
      className: 'mtt-node'
        + (node.current ? ' mtt-node-current' : '')
        + (node.deleted ? ' mtt-node-deleted' : '')
        + (node.onCurrentPath ? ' mtt-node-path' : ''),
      style: indent,
    },
      h('button', {
        type: 'button', className: 'mtt-node-card',
        disabled: node.deleted || busy === node.sessionId,
        title: node.text ? clip(node.text, 200) : title,
        onClick: function () {
          switchToVersion(navigation, { sessionId: node.id, deleted: node.deleted, archived: node.archived }, sessionId);
        },
      },
        h('div', { className: 'mtt-node-head' },
          h('span', { className: 'mtt-node-title' }, title),
          node.model ? h(ModelChip, { model: node.model }) : null,
          node.archived ? h('span', { className: 'mtt-node-tag' }, t('archived')) : null,
          node.deleted ? h('span', { className: 'mtt-node-tag mtt-node-tag-danger' }, t('deletedCardTag')) : null,
          node.current ? h('span', { className: 'mtt-node-tag mtt-node-tag-current' }, t('currentTag')) : null,
          h('span', { className: 'mtt-node-time' }, timeLabel(node.time))),
        node.text ? h('div', { className: 'mtt-node-text' }, clip(node.text, 160)) : null),
      node.deleted
        ? h('button', {
          type: 'button', className: 'mtt-btn mtt-btn-small',
          disabled: busy === node.sessionId,
          onClick: function () { restore(node); },
        }, t('restore'))
        : null);
  });

  return h('div', { className: 'mtt-view' },
    h('div', { className: 'mtt-view-head' },
      h('div', null,
        h('div', { className: 'mtt-view-title' }, t('view')),
        h('div', { className: 'mtt-view-hint' }, t('viewHint'))),
      h('button', {
        type: 'button', className: 'mtt-btn mtt-btn-small',
        onClick: function () { store.invalidate(sessionId); },
      }, t('refresh'))),
    h(ErrorChip, { error: error }),
    versions && versions.length > 1 ? rows : h('div', { className: 'mtt-empty' }, t('emptyVersions')));
}

// Every colour comes from DSH's own theme aliases, and every alias has a
// light *and* dark definition in dsh-client-ui-theme (`[data-ds-dark-theme]`
// redefines bg-layer-*, border-l*, label-*, interactive-bg-hover, …). Anything
// hard-coded here would freeze the popovers in light mode — which is exactly
// what `--dsw-alias-bg-elevated` did: that token does not exist, so the `#fff`
// fallback always won and the menus stayed white in dark mode.
const CSS = [
  // The aliases live on <body>, not :root: DSH declares its own tokens on
  // `body` (light) and `body[data-ds-dark-theme]` (dark), and a var() inside a
  // custom-property declaration resolves against *that* element — so declared
  // on :root these aliases would freeze at the light palette.
  'body{--mtt-surface:var(--dsw-alias-bg-layer-3,Canvas);--mtt-surface-2:var(--dsw-alias-bg-layer-2,Canvas);--mtt-line:var(--dsw-alias-border-l3,rgba(128,128,128,.32));--mtt-line-strong:var(--dsw-alias-border-l4,rgba(128,128,128,.45));--mtt-fg:var(--dsw-alias-label-primary,CanvasText);--mtt-fg-2:var(--dsw-alias-label-secondary,CanvasText);--mtt-fg-3:var(--dsw-alias-label-tertiary,CanvasText);--mtt-hover:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.16));--mtt-bubble:var(--dsw-specific-bubble,rgba(128,128,128,.14));--mtt-hover-accent:var(--dsw-alias-interactive-bg-hover-accent,rgba(99,102,241,.18));--mtt-primary:var(--dsw-alias-button-primary-fill,#2563eb);--mtt-on-primary:var(--dsw-alias-label-primary-inverted,#fff);--mtt-danger:var(--dsw-alias-state-error-primary,#dc2626);--mtt-danger-soft:var(--dsw-alias-state-error-secondary,rgba(220,38,38,.16));--mtt-ok:var(--dsw-alias-state-success-primary,#059669);--mtt-ok-soft:var(--dsw-alias-state-success-tertiary,rgba(5,150,105,.16));--mtt-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.24));--mtt-shadow-high:var(--dsw-shadow-lv3,0 12px 32px rgba(0,0,0,.32));--mtt-radius-sm:var(--dsw-radius-sm,6px);--mtt-radius:var(--dsw-radius-md,8px);--mtt-radius-lg:var(--dsw-radius-lg,12px)}',
  // Every surface we own starts from the themed label colour, and every control
  // we own inherits it: a button with no colour of its own would otherwise fall
  // back to the UA's ButtonText, which stays black under a dark app theme.
  '.mtt-row,.mtt-toolbar,.mtt-answer,.mtt-alt,.mtt-view,.mtt-editor,.mtt-pop,.mtt-toast{color:var(--mtt-fg)}',
  // `:where()` keeps this at zero specificity so a variant that does state its
  // own ink — .mtt-btn-primary, .mtt-btn-danger — still wins.
  ':where(button.mtt-btn,button.mtt-act,button.mtt-pop-item,button.mtt-ring-btn,button.mtt-node-card,textarea.mtt-textarea){color:inherit}',
    // Fallback for the toast, used only when the primitives package is absent:
  // it copies Toast.module.css from that package — including the design rule
  // that a toast surface stays dark in both themes, so its label never flips.
  '.mtt-toast{position:fixed;top:40px;left:50%;transform:translateX(-50%);z-index:1100;pointer-events:none;width:max-content;max-width:min(640px,calc(100vw - 48px));padding:12px 16px;border-radius:var(--mtt-radius-lg);background:var(--dsw-alias-toast-bg,#1f242c);color:var(--dsw-alias-toast-label,#f2f4f7);font-size:14px;line-height:22px;box-shadow:var(--mtt-shadow-high);animation:mtt-toast-in 160ms ease-out,mtt-toast-fade 1000ms ease var(--dsh-toast-hold,3000ms) forwards}',
  '@keyframes mtt-toast-fade{to{opacity:0;visibility:hidden}}',
  // The fallback banner tints its own leading dot; the app's Toast draws a
  // check (success) or a warning glyph (failure) in the same seat.
  '.mtt-toast-ok::before,.mtt-toast-bad::before{content:"";display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:8px;vertical-align:middle}',
  '.mtt-toast-ok::before{background:var(--mtt-ok)}',
  '.mtt-toast-bad::before{background:var(--mtt-danger)}',
  '@keyframes mtt-toast-in{from{opacity:0;transform:translate(-50%,-6px)}to{opacity:1;transform:translate(-50%,0)}}',
  '.mtt-row{display:flex;flex-direction:column;align-items:flex-end;gap:2px;margin:2px 0;min-width:0}',
  '.mtt-row.mtt-editing{align-items:stretch}',
  '.mtt-line{display:flex;justify-content:flex-end;width:100%;min-width:0}',
  // Exactly DSH's own user bubble (Sixlwa_bubble in dsh-client-ui-chat): the
  // light-blue fill is --dsw-specific-bubble, not a neutral tint — the grey
  // version this rule used to paint over it was the tell that the token was made up.
  '.mtt-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);background:var(--mtt-bubble);border-radius:var(--dsw-radius-xl,16px);padding:10px 16px;color:var(--dsw-alias-label-primary,CanvasText);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));min-width:0;white-space:pre-wrap;word-break:break-word}',
  '.mtt-text{white-space:pre-wrap;word-break:break-word}',
  // Action rows mirror DSH's own MessageIconActions.module.css exactly:
  // 28px hit box (plus the user's content-font delta), 6px padding, 8px gap,
  // 17px glyphs in a clock="end" row, tertiary label colour.
  '.mtt-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;height:calc(28px + var(--dsh-content-font-delta,0px));opacity:0;transition:opacity 80ms}',
  '.mtt-row:hover .mtt-actions,.mtt-row:focus-within .mtt-actions{opacity:1}',
  '.mtt-toolbar{display:inline-flex;align-items:center;gap:8px;position:relative}',
  '.mtt-act{background:0 0;border:0;padding:6px;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--mtt-radius-sm);color:var(--mtt-fg-3);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font:inherit}',
  '.mtt-act svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}',
  '.mtt-act:hover{background:var(--mtt-hover);color:var(--mtt-fg-2)}',
  '.mtt-act:disabled{opacity:.4;cursor:default}',
  '.mtt-act:disabled:hover{background:0 0;color:var(--mtt-fg-3)}',
  // A button that is waiting on the network says so with its own icon: the arc
  // turns, the row keeps its size, and the tooltip explains what is happening.
  '.mtt-spin{animation:mtt-spin 900ms linear infinite;transform-origin:50% 50%}',
  // A waiting button is disabled (no second request), but the spinner has to stay
  // legible: the dimmed look is for unavailable actions, not for work in flight.
  '.mtt-act:disabled .mtt-spin{opacity:1}',
  '@keyframes mtt-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
  '@media (prefers-reduced-motion:reduce){.mtt-spin{animation-duration:2.4s}}',
  '.mtt-act-on{color:var(--mtt-fg-2);background:var(--mtt-hover)}',
  // The ring is an action like any other: same 28px box, same icon size, same
  // hover, so it reads as one more button in the row instead of a chip.
  '.mtt-ring{display:inline-flex;align-items:center;gap:0;height:calc(28px + var(--dsh-content-font-delta,0px));color:var(--mtt-fg-3);font:inherit;margin:0 0 0 2px}',
  '.mtt-ring-count{min-width:24px;text-align:center;font-size:calc(12px + var(--dsh-content-font-delta,0px));line-height:1;font-variant-numeric:tabular-nums}',
  '.mtt-ring-btn{background:0 0;border:0;cursor:pointer;padding:6px;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--mtt-radius-sm);color:var(--mtt-fg-3);display:inline-flex;align-items:center;justify-content:center;font:inherit}',
  '.mtt-ring-btn:hover:not(:disabled){background:var(--mtt-hover);color:var(--mtt-fg-2)}',
  '.mtt-ring-btn svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px));display:block}',
  '.mtt-ring-btn:disabled{opacity:.4}',
  // The visible answer sits in the flow like a normal message: no card chrome,
  // no colour of our own — it inherits the answer typography of the app.
  '.mtt-answer{margin:6px 0 2px;width:100%;min-width:0}',
  // An action row under an answer sits at the start of the content column, like
  // DSH's own assistant row — `.mtt-row` right-aligns a user bubble, so this
  // rule has to opt back out to line up with the answer text above it.
  '.mtt-tail-actions{display:flex;justify-content:flex-start;margin:2px 0 4px}',
  '.mtt-answer-body{overflow-wrap:anywhere;min-width:0}',
  // Paired translation: the original keeps its place and the translation follows
  // it block by block, so both languages read in the same order and the page
  // never swaps one for the other. The translated half is inset and quieter, so
  // the eye separates the two without needing a label.
  '.mtt-pair{display:flex;flex-direction:column;gap:18px;min-width:0}',
  '.mtt-pair-block{display:flex;flex-direction:column;gap:2px;min-width:0}',
  '.mtt-pair-src{color:var(--mtt-fg-2);min-width:0}',
  '.mtt-pair-tr{color:var(--mtt-fg);min-width:0}',
  '.mtt-dots{display:inline-flex;align-items:center;gap:3px;height:1em;vertical-align:-.1em;margin-left:2px}',
  '.mtt-dots i{width:4px;height:4px;border-radius:50%;background:currentColor;opacity:.4;animation:mtt-dot 900ms ease-in-out infinite}',
  '.mtt-dots i:nth-child(2){animation-delay:120ms}',
  '.mtt-dots i:nth-child(3){animation-delay:240ms}',
  '@keyframes mtt-dot{0%,80%,100%{transform:translateY(0);opacity:.35}40%{transform:translateY(-3px);opacity:1}}',
  '@media (prefers-reduced-motion:reduce){.mtt-dots i{animation-duration:2.4s}}',
  '.mtt-pair-note{margin-top:6px;font-size:12px;color:var(--mtt-fg-3)}',
  // Editing an answer where it stands: a well holding the markdown source, the
  // "editing" label on the left, the way out and the way to keep it on the
  // right. Nothing else lives in the header, so the box reads as the answer
  // with its source exposed.
  '.mtt-answer-edit{border:.5px solid var(--mtt-line-strong);border-radius:var(--mtt-radius);background:var(--mtt-surface-2);padding:8px 10px;width:100%;min-width:0}',
  '.mtt-answer-edit-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}',
  '.mtt-answer-edit-label{font-size:12px;color:var(--mtt-fg-3)}',
  '.mtt-answer-edit-tools{display:flex;align-items:center;gap:4px}',
  '.mtt-answer-edit-input{display:block;width:100%;height:clamp(140px,34vh,360px);resize:vertical;border:0;background:transparent;color:var(--mtt-fg);font-family:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.6;padding:0;outline:none;overflow:auto;overscroll-behavior:contain}',
  '.mtt-answer-edit-input::placeholder{color:var(--mtt-fg-3)}',
  '.mtt-answer-wait{font-size:var(--dsh-content-font-size-secondary,13px);color:var(--mtt-fg-3);padding:2px 0}',
  '.mtt-wait-text{opacity:.75}',
  '.mtt-think{margin:2px 0 6px}',
  '.mtt-think-head{display:inline-flex;align-items:center;gap:4px;background:0 0;border:0;padding:0;cursor:pointer;color:var(--mtt-fg-3);font:inherit;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(18px + var(--dsh-content-font-delta-secondary,0px))}',
  '.mtt-think-head:hover{color:var(--mtt-fg-2)}',
  '.mtt-think-head svg{width:12px;height:12px;display:block;transition:transform 120ms}',
  '.mtt-think-open svg{transform:rotate(90deg)}',
  '.mtt-think-body{margin:4px 0 0;padding-left:10px;border-left:.5px solid var(--mtt-line);color:var(--mtt-fg-3);font-size:var(--dsh-content-font-size-secondary,13px);line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto}',
  '.mtt-alt{margin:8px 0 2px;border:1px solid var(--mtt-line);background:var(--mtt-surface-2);border-radius:var(--mtt-radius-lg);padding:8px 10px;display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;color:var(--mtt-fg)}',
  '.mtt-alt-native{border-color:var(--mtt-line-strong);background:transparent}',
  '.mtt-alt-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--mtt-fg-3)}',
  '.mtt-alt-badge{font-weight:600;color:var(--mtt-fg)}',
  '.mtt-alt-native .mtt-alt-badge{color:var(--mtt-fg-2)}',
  '.mtt-alt-tag{background:var(--mtt-hover);color:var(--mtt-fg-2);border-radius:var(--mtt-radius-sm);padding:0 6px}',
  '.mtt-alt-tag-edit{background:var(--mtt-hover-accent);color:var(--mtt-fg)}',
  '.mtt-alt-tools{margin-left:auto;display:inline-flex;align-items:center;gap:2px}',
  '.mtt-alt-tools .mtt-act{width:24px;height:24px;padding:4px}',
  '.mtt-alt-tools .mtt-act svg{width:15px;height:15px}',
  '.mtt-alt-body{font-size:13px;line-height:1.6;color:inherit;min-width:0;overflow-wrap:anywhere}',
  '.mtt-alt-text{white-space:pre-wrap;word-break:break-word;color:var(--mtt-fg)}',
  '.mtt-alt-note{font-size:12px;color:var(--mtt-fg-2)}',
  '.mtt-answer-textarea{min-height:150px;max-height:44vh;border:1px solid var(--mtt-line);border-radius:var(--mtt-radius);padding:8px;font-family:inherit;font-size:13px;line-height:1.55;background:var(--mtt-surface-2);color:var(--mtt-fg);resize:vertical;outline:none}',
  '.mtt-answer-textarea:focus{border-color:var(--mtt-primary)}',
  '.mtt-error-inline{font-size:11px;color:var(--mtt-danger);margin-right:auto;max-width:60%}',
  '.mtt-pop-foot{border-top:1px solid var(--mtt-line);margin-top:4px;padding-top:4px}',
  '.mtt-pop-item-sub{font-size:11px;color:var(--mtt-fg-3)}',
  '.mtt-chip{font-size:11px;padding:1px 6px;border-radius:var(--mtt-radius);background:var(--mtt-hover-accent);color:var(--mtt-fg);max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mtt-menu-wrap{position:relative;display:inline-flex}',
  // The delete confirmations are portalled to <body> and placed next to their
  // button with fixed coordinates: inside the row they were painted over and
  // clipped by the conversation flow. These two rules undo the absolute
  // placement the inline menus rely on.
  '.mtt-anchor{display:inline-flex}',
  '.mtt-pop-float{position:fixed;right:auto;top:auto}',
  '.mtt-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:60;background:var(--mtt-surface);color:var(--mtt-fg);border:.5px solid var(--mtt-line-strong);border-radius:var(--mtt-radius-lg);box-shadow:var(--mtt-shadow);padding:6px;min-width:150px;max-height:min(320px,45vh);overflow:auto;text-align:left}',
  // Flipped above the button when the row sits at the bottom of the window
  // (the last message), where the composer would otherwise cover the popover.
  '.mtt-up .mtt-pop{top:auto;bottom:calc(100% + 6px)}',
  '.mtt-pop-wide{min-width:260px}',
  '.mtt-pop-trans{min-width:260px;max-width:420px}',
  '.mtt-pop-confirm{min-width:240px}',
  '.mtt-pop-title{font-size:11px;color:var(--mtt-fg-3);padding:4px 8px}',
  '.mtt-pop-group{font-size:10px;color:var(--mtt-fg-3);padding:6px 8px 2px}',
  '.mtt-pop-note{font-size:11px;color:var(--mtt-fg-3);padding:4px 8px}',
  '.mtt-pop-item{display:block;width:100%;text-align:left;background:none;border:0;padding:6px 8px;border-radius:var(--mtt-radius-sm);cursor:pointer;font:inherit;color:var(--mtt-fg)}',
  '.mtt-pop-item:hover{background:var(--mtt-hover)}',
  '.mtt-pop-actions{display:flex;gap:6px;justify-content:flex-end;padding:4px}',
  '.mtt-btn{border:.5px solid var(--mtt-line-strong);background:var(--mtt-surface-2);border-radius:var(--mtt-radius-sm);padding:4px 10px;font-size:12px;cursor:pointer;color:var(--mtt-fg);font-family:inherit}',
  '.mtt-btn:hover{background:var(--mtt-hover)}',
  '.mtt-btn-primary{background:var(--mtt-primary);border-color:transparent;color:var(--mtt-on-primary)}',
  '.mtt-btn-primary:hover{background:var(--mtt-primary);filter:brightness(1.08)}',
  '.mtt-btn-danger{background:var(--mtt-danger);border-color:transparent;color:var(--mtt-on-primary)}',
  '.mtt-btn-danger:hover{background:var(--mtt-danger);filter:brightness(1.08)}',
  '.mtt-btn-small{padding:2px 8px;font-size:11px}',
  '.mtt-btn:disabled{opacity:.5;cursor:default}',
  '.mtt-editor{width:100%;display:flex;flex-direction:column;gap:6px;background:var(--mtt-surface);color:var(--mtt-fg);border:.5px solid var(--mtt-line-strong);border-radius:var(--mtt-radius-lg);padding:10px}',
  '.mtt-textarea{width:100%;min-height:64px;resize:vertical;border:0;outline:none;background:transparent;font:inherit;color:var(--mtt-fg)}',
  '.mtt-editor-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}',
  '.mtt-hint{font-size:11px;color:var(--mtt-fg-3)}',
  '.mtt-error{font-size:11px;color:var(--mtt-danger);margin-top:2px;max-width:76%;text-align:right;white-space:pre-wrap;align-self:flex-end}',
  '.mtt-view{padding:16px;display:flex;flex-direction:column;gap:10px;overflow:auto;height:100%;min-width:0;color:var(--mtt-fg)}',
  '.mtt-view-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}',
  '.mtt-view-title{font-weight:600;font-size:14px}',
  '.mtt-view-hint{font-size:11px;color:var(--mtt-fg-3);margin-top:2px}',
  '.mtt-view-empty{color:var(--mtt-fg-3);align-items:center;justify-content:center}',
  '.mtt-node{display:flex;flex-direction:column;gap:4px;align-items:flex-start;color:var(--mtt-fg)}',
  '.mtt-node-card{text-align:left;display:flex;flex-direction:column;gap:3px;border:1px solid var(--mtt-line);background:var(--mtt-surface);border-radius:var(--mtt-radius-lg);padding:8px 10px;cursor:pointer;font:inherit;color:inherit;max-width:640px;min-width:220px}',
  '.mtt-node-card:hover{border-color:var(--mtt-primary)}',
  '.mtt-node-card:disabled{opacity:.55;cursor:default}',
  '.mtt-node-current .mtt-node-card{border-color:var(--mtt-primary);box-shadow:0 0 0 1px var(--mtt-primary) inset}',
  '.mtt-node-deleted .mtt-node-card{opacity:.5;text-decoration:line-through}',
  '.mtt-node-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px}',
  '.mtt-node-title{font-weight:600}',
  '.mtt-node-tag{font-size:10px;padding:0 6px;border-radius:var(--mtt-radius-sm);background:var(--mtt-hover);color:var(--mtt-fg-2)}',
  '.mtt-node-tag-current{background:var(--mtt-hover-accent);color:var(--mtt-fg)}',
  '.mtt-node-tag-danger{background:var(--mtt-danger-soft);color:var(--mtt-danger)}',
  '.mtt-node-time{margin-left:auto;color:var(--mtt-fg-3);font-size:10px}',
  '.mtt-node-text{font-size:12px;color:var(--mtt-fg-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:600px}',
  '.mtt-empty{color:var(--mtt-fg-3);font-size:12px;padding:24px 0;text-align:center}',
].join('\n');

/* ------------------------------------------------------------------ I18N -- */

const I18N = {
  en: {
    view: 'Versions',
    viewHint: 'Every branch of this conversation as model answer cards. Click a card to open it; deleted cards can be restored.',
    refresh: 'Refresh',
    loading: 'Loading…',
    loadError: 'Could not load version data.',
    emptyVersions: 'No branches yet — edit a message, regenerate it, or switch its model to create answer cards.',
    originalConversation: 'Original conversation',
    editedTurn: 'Edited turn {turn}',
    retriedTurn: 'Regenerated turn {turn}',
    archived: 'Archived',
    deletedCardTag: 'Deleted',
    currentTag: 'Current',
    copy: 'Copy',
    copied: 'Copied',
    edit: 'Edit message',
    regenerate: 'Regenerate this turn',
    translate: 'Translate',
    translateTo: 'Translate into…',
    translated: 'Translated',
    translating: 'Translating…',
    translationTruncated: 'The translation was cut off by the model\'s length limit — the rest is untranslated.',
    close: 'Close',
    imagesKept: '{count} image(s) kept as-is',
    cancel: 'Cancel',
    send: 'Send',
    sending: 'Sending…',
    shortcutHint: 'Ctrl/⌘+Enter to send · Esc to cancel',
    prevVersion: 'Previous version',
    nextVersion: 'Next version',
    versionHint: 'This answer has other versions',
    modelCard: 'Answer model of this card',
    switchModel: 'Answer this turn with another model',
    switchModelPick: 'Pick a model — its answer replaces this one in place (switch with ‹ ›)',
    branchInstead: '…or build a new answer card (separate conversation, can use tools)',
    variants: 'Answers',
    nativeAnswer: 'model’s own answer',
    nativeVisibleHint: 'Showing the answer the model actually produced. Use › to go back to an alternative.',
    editedAnswer: 'edited by you',
    editAnswer: 'Edit this answer',
    editing: 'Editing',
    exitEdit: 'Close the editor',
    answerEditHint: 'Your edit is kept as another variant of this answer; the model’s original stays available under ‹ ›.',
    save: 'Save',
    prevAnswer: 'Previous answer',
    nextAnswer: 'Next answer',
    deleteVariant: 'Delete this variant',
    deleteVariantConfirm: 'Delete this answer?',
    variantDeleted: 'Answer deleted',
    generating: 'Generating…',
    thinking: 'Thinking…',
    thought: 'Thinking',
    answerGenerated: 'New answer ready — switch with ‹ ›',
    answerGeneratedBy: 'Answer from {name} ready',
    answerEdited: 'Edit saved as a variant',
    footnotes: 'Footnotes',
    noModels: 'No models available',
    messageNotIndexed: 'This message is not indexed yet; reopen the conversation to retry.',
    switched: 'Answering with {name}…',
    deleteCard: 'Delete this answer card',
    deleteCardConfirm: 'Delete this answer card? You can restore it from the Versions view.',
    deleteMessage: 'Delete this message',
    deleteMessageConfirm: 'Delete this message?',
    deleteAnswer: 'Delete this answer',
    deleteAnswerConfirm: 'Delete this answer?',
    turnHidden: 'Message deleted',
    answerHidden: 'Answer deleted',
    delete: 'Delete',
    deletedCard: 'Card deleted',
    translateTo: 'Translate into',
    translatedTo: 'Translated',
    hideTranslation: 'Hide the translation',
    },
  zh: {
    view: '版本',
    viewHint: '当前对话的每条分支，按模型回答卡片展示。点击卡片打开；删除的卡片可以恢复。',
    refresh: '刷新',
    loading: '加载中…',
    loadError: '无法加载版本数据。',
    emptyVersions: '还没有分支——编辑消息、重新生成或切换模型即可创建回答卡片。',
    originalConversation: '原始对话',
    editedTurn: '编辑了第 {turn} 轮',
    retriedTurn: '重新生成第 {turn} 轮',
    archived: '已归档',
    deletedCardTag: '已删除',
    currentTag: '当前',
    copy: '复制',
    copied: '已复制',
    edit: '编辑消息',
    regenerate: '重新生成这一轮',
    translate: '翻译',
    translateTo: '翻译成…',
    translated: '已翻译',
    translating: '正在翻译…',
    translationTruncated: '译文因为模型的长度上限被截断了，后半部分没有翻译。',
    close: '关闭',
    imagesKept: '{count} 张图片原样保留',
    cancel: '取消',
    send: '发送',
    sending: '发送中…',
    shortcutHint: 'Ctrl/⌘+Enter 发送 · Esc 取消',
    prevVersion: '上一个版本',
    nextVersion: '下一个版本',
    versionHint: '这条回答还有其它版本',
    modelCard: '该卡片的回答模型',
    switchModel: '换一个模型回答这一轮',
    switchModelPick: '选择模型——它的回答会就地替换当前回答（用 ‹ › 切换）',
    branchInstead: '…或新建回答卡片（另开一个会话，可调用工具）',
    variants: '回答备选',
    nativeAnswer: '模型原始回答',
    nativeVisibleHint: '当前显示的是模型真实的回答。点 › 可以回到备选回答。',
    editedAnswer: '你的编辑版',
    editAnswer: '编辑这条回答',
    editing: '编辑中',
    exitEdit: '退出编辑',
    answerEditHint: '你的修改会作为这条回答的另一个备选保存，模型原文仍可在 ‹ › 里找回。',
    save: '保存',
    prevAnswer: '上一个回答',
    nextAnswer: '下一个回答',
    deleteVariant: '删除这个备选',
    deleteVariantConfirm: '删除这条回答？',
    variantDeleted: '已删除这条回答',
    generating: '正在生成…',
    thinking: '思考中…',
    thought: '思考过程',
    answerGenerated: '新回答已生成——用 ‹ › 切换',
    answerGeneratedBy: '{name} 的回答已就绪',
    answerEdited: '编辑已保存为备选',
    footnotes: '脚注',
    noModels: '暂无可用模型',
    messageNotIndexed: '这条消息还没有建立索引，请重新打开会话再试。',
    switched: '正在用 {name} 回答…',
    deleteCard: '删除这张回答卡片',
    deleteCardConfirm: '删除这张回答卡片？可以在“版本”视图里恢复。',
    deleteMessage: '删除这条消息',
    deleteMessageConfirm: '删除这条消息？',
    deleteAnswer: '删除这条回答',
    deleteAnswerConfirm: '删除这条回答？',
    turnHidden: '已删除这条消息',
    answerHidden: '已删除这条回答',
    delete: '删除',
    deletedCard: '卡片已删除',
    translateTo: '翻译成',
    translatedTo: '已翻译',
    hideTranslation: '隐藏译文',
    translationHidden: '已隐藏译文',
  },
};

/* -------------------------------------------------------------- registration -- */

return {
  inject: ['slots', 'sessions', 'locale', 'uiWorkspace'],
  apply(ctx) {
    const slots = ctx.get('slots');
    if (slots === undefined) {
      throw new Error('[dsh-message-toolbar] Missing DSH slots service. Check dsh.client.inject and restart DSH.');
    }
    const sessions = ctx.get('sessions');
    const uiWorkspace = ctx.get('uiWorkspace');
    if (!sessions || !sessions.list || !uiWorkspace || typeof uiWorkspace.openSession !== 'function') {
      throw new Error('[dsh-message-toolbar] Missing DSH sessions or uiWorkspace navigation service. Check client dependencies and restart DSH.');
    }
    sessionsService = sessions;
    navigation = { list: sessions.list, openVersion: function (id) { uiWorkspace.openSession(id); } };

    ctx.effect(function () { return styles.insert(CSS); });

    // The right-hand turn rail folds the session log, so it cannot know about an
    // answer we never logged or a row we hid. Patch the chat target's navigation
    // items so the rail follows the transcript. Optional: a shell without
    // `uiConversation` simply keeps the stock rail.
    const attachRail = function (scope) {
      scope.effect(function () { return installRailSync(scope); }, 'message-toolbar: turn rail');
    };
    if (typeof ctx.inject === 'function') ctx.inject(['uiConversation'], attachRail);
    else if (ctx.get('uiConversation')) attachRail(ctx);
    ctx.effect(function () {
      if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
        return sessions.list.subscribe(function () { store.invalidate(); });
      }
      return undefined;
    });

    try {
      const locale = ctx.get('locale');
      if (locale && typeof locale.register === 'function') {
        ctx.effect(function () { return locale.register(I18N_NS, I18N); });
        localeService = locale;
        invalidateLang();
        // A locale switch must reach already-mounted rows, so drop the cached
        // choice — `t` reads it again on the next render.
        if (typeof locale.subscribe === 'function') {
          ctx.effect(function () { return locale.subscribe(invalidateLang); });
        }
      }
    } catch (e) {
      // Fall back to the built-in dictionary.
    }

    // Shadow only the plain user bubble; steering and context rows keep the
    // host renderer. A collision with another user-bubble plugin degrades to
    // "they win" rather than failing this plugin's other registrations.
    slots.inject('conversation.chat.node', function () {
      try {
        return slots.register(
          { name: 'conversation.chat.node', key: 'user', priority: -1 },
          UserMessageView);
      } catch (e) {
        console.warn('[dsh-message-toolbar] Failed to register the user-message view; editing is unavailable.', e);
        return function () {};
      }
    });

    slots.inject('conversation.chat.assistant-actions', function () {
      try {
        return slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            id: 'message-toolbar',
            order: 30,
            locale: I18N_NS,
            inject: function (sessionId) { return { sessionId: sessionId }; },
          },
          AssistantToolbar);
      } catch (e) {
        console.warn('[dsh-message-toolbar] Failed to register the assistant action row.', e);
        return function () {};
      }
    });

    // Answer variants render in the flow where the answer itself lives: the
    // card replaces the logged answer visually (a generated stylesheet hides
    // that turn's assistant row) while the conversation stays one conversation.
    // The order is negative on purpose: the turn tail is a list, and the
    // deliverables card (the "files changed" block) registers at the default 0.
    // Ascending order means anything below zero renders *above* it, which keeps
    // the answer over its file changes, exactly where the app puts them.
    slots.inject('conversation.chat.turnTail', function () {
      try {
        return slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'message-toolbar-answers',
            order: -10,
            locale: I18N_NS,
            inject: function (sessionId) { return { sessionId: sessionId }; },
          },
          AnswerCard);
      } catch (e) {
        console.warn('[dsh-message-toolbar] Failed to register the answer variant card.', e);
        return function () {};
      }
    });

    slots.inject('conversation.view', function () {
      return slots.register(
        {
          name: 'conversation.view',
          id: 'message-toolbar',
          order: VIEW_ORDER,
          label: function () { return t('view'); },
          inject: function (sessionId) { return { sessionId: sessionId }; },
        },
        VersionsView);
    });
  },
};
    })();
  }
});
