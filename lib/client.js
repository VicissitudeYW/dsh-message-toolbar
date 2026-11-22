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
const translationRequests = new Map();
// Client state for progress and retry. The host owns the durable target.
const contextMigrations = new Map();

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
   * Turns a question is about to be replayed into: `sessionId` → Set of turn
   * numbers. The host writes its own mark the moment it queues the followup, but
   * this client only learns about that mark on the next fetch — until then the
   * replayed question would paint a second time and vanish a moment later. Marking
   * the turn here, before the request goes out, keeps the second copy off the
   * screen; the host's mark takes over with the next payload, which clears this.
   */
  pendingPrompts: new Map(),
  /**
   * Bumped on every notification. The turn rail memoizes its patched snapshot
   * per (chat snapshot, rail version), so one counter is enough to invalidate
   * every memo that depended on this store.
   */
  railVersion: 0,
  // Logical revisions order GETs and mutations even within the same clock tick.
  revision: 0,

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

  touch(entry, stale) {
    entry.revision = ++this.revision;
    entry.updatedAt = stale ? 0 : Date.now();
  },

  set(sessionId, state) {
    const previous = this.bySession.get(sessionId);
    const entry = { state: state, loading: false, error: null,
      answerRevisions: previous && previous.answerRevisions ? previous.answerRevisions : {} };
    this.touch(entry);
    this.bySession.set(sessionId, entry);
    // A guess is retired when the log catches up with it: either the turn it names
    // is in this payload (the host's own mark governs from now on) or the log has
    // already moved past that number (nothing was ever opened, so the guess is
    // stale and must not hide a later question that happens to land there). Until
    // then it keeps the replayed row hidden — clearing it on the first payload
    // would reveal the row again right before the turn opens, which is the flash
    // this is here to remove.
    const guesses = this.pendingPrompts.get(sessionId);
    if (guesses !== undefined) {
      const turns = Array.isArray(state && state.turns) ? state.turns : [];
      let highest = 0;
      for (let i = 0; i < turns.length; i++) {
        const entry = turns[i];
        if (entry && typeof entry.turn === 'number' && entry.turn > highest) highest = entry.turn;
      }
      const settled = [];
      guesses.forEach(function (guess) {
        const landed = turns.some(function (entry) { return entry && entry.turn === guess; });
        if (landed || guess <= highest) settled.push(guess);
      });
      for (let i = 0; i < settled.length; i++) guesses.delete(settled[i]);
      if (guesses.size === 0) this.pendingPrompts.delete(sessionId);
    }
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
    this.touch(entry);
    this.notify();
  },

  /** Merge one turn's answer variants into the cached payload. */
  patchAnswer(sessionId, turn, payload) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state || !payload) return;
    const answers = entry.state.answers || (entry.state.answers = {});
    const revisions = entry.answerRevisions || (entry.answerRevisions = {});
    revisions[String(turn)] = (revisions[String(turn)] || 0) + 1;
    this.liveTranslations.delete(sessionId + '|' + turn);
    answers[String(turn)] = {
      active: payload.active,
      items: payload.items || [],
      override: payload.override ?? null,
    };
    // The host retires translations whenever an answer changes. Mirror that
    // immediately, rather than painting an old translation until the next GET.
    const key = String(turn);
    if (entry.state.shown) delete entry.state.shown[key];
    if (entry.state.origins) delete entry.state.origins[key];
    const translations = entry.state.translations;
    if (translations) {
      for (const seq of Object.keys(translations)) {
        const langs = translations[seq];
        if (!langs || typeof langs !== 'object') continue;
        for (const lang of Object.keys(langs)) {
          if (seq === 'turn:' + key || (langs[lang] && langs[lang].turn === turn)) delete langs[lang];
        }
        if (Object.keys(langs).length === 0) delete translations[seq];
      }
    }
    this.touch(entry);
    this.notify();
  },

  /** Replace the cached list of rewritten questions. */
  patchPrompt(sessionId, prompts) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state || !prompts || typeof prompts !== 'object') return;
    entry.state.prompts = prompts;
    this.touch(entry);
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
    const revisions = entry.answerRevisions || (entry.answerRevisions = {});
    entry.state.hidden.turns.concat(entry.state.hidden.answers).forEach((turn) => {
      revisions[String(turn)] = (revisions[String(turn)] || 0) + 1;
      this.live.delete(sessionId + '|' + turn);
      this.liveTranslations.delete(sessionId + '|' + turn);
      this.edits.delete(sessionId + '|' + turn);
    });
    this.touch(entry);
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
    this.touch(entry);
    this.notify();
  },

  patchOrigin(sessionId, turn, text) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state || typeof turn !== 'number' || typeof text !== 'string') return;
    const origins = entry.state.origins || (entry.state.origins = {});
    if (origins[String(turn)] === text) return;
    origins[String(turn)] = text;
    this.touch(entry);
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

  /** Note that a question is about to be replayed into this turn. */
  markPendingPrompt(sessionId, turn) {
    if (!sessionId || typeof turn !== 'number') return;
    const turns = this.pendingPrompts.get(sessionId) || new Set();
    turns.add(turn);
    this.pendingPrompts.set(sessionId, turns);
    this.notify();
  },

  isPendingPrompt(sessionId, turn) {
    if (!sessionId || typeof turn !== 'number') return false;
    const turns = this.pendingPrompts.get(sessionId);
    return turns !== undefined && turns.has(turn);
  },

  clearPendingPrompts(sessionId) {
    if (this.pendingPrompts.delete(sessionId)) this.notify();
  },

  async load(sessionId) {
    if (!sessionId) return;
    const g = realGlobal();
    if (!g || typeof g.fetch !== 'function') return;
    if (this.inflight.has(sessionId)) return this.inflight.get(sessionId);

    let existing = this.bySession.get(sessionId);
    if (!existing) {
      existing = { state: null, loading: false, error: null, updatedAt: 0, revision: ++this.revision };
      this.bySession.set(sessionId, existing);
    }
    existing.loading = true;

    const self = this;
    const requestRevision = existing.revision;
    // Queue the body so even a synchronous fetch failure cannot finish before
    // this promise has been registered in inflight.
    const promise = Promise.resolve().then(async function () {
      let accepted = false;
      try {
        const res = await g.fetch(ROUTE + '?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        // The host asks for a row dump when someone is looking at the flow from
        // outside; the flag rides along with every state it hands out.
        const current = self.bySession.get(sessionId);
        if (current && current.revision === requestRevision) {
          rowDumpWanted = data !== null && data !== undefined && data.debugRows === true;
          self.set(sessionId, data);
          accepted = true;
        }
      } catch (e) {
        const errStr = String((e && e.message) || e);
        const prev = self.bySession.get(sessionId);
        if (prev && prev.revision === requestRevision) {
          prev.error = errStr;
          prev.loading = false;
          self.notify();
        }
      } finally {
        self.inflight.delete(sessionId);
        const current = self.bySession.get(sessionId);
        if (current) current.loading = false;
        // A mutation or invalidation happened after this GET started. Its old
        // snapshot is unusable, but one coalesced refresh can now observe it.
        if (!accepted && current && current.revision !== requestRevision) return self.load(sessionId);
      }
    });

    this.inflight.set(sessionId, promise);
    return promise;
  },

  ensure(sessionId) {
    if (!sessionId) return;
    // The row sweep needs to know which session the visible transcript belongs to,
    // and the rows themselves carry only a turn number. Whoever asks about a
    // session is the best answer available, and it is right far more often than
    // the alternative (a null session, and a sweep that does nothing).
    this.lastSession = sessionId;
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state) {
      this.load(sessionId);
    } else if (Date.now() - (entry.updatedAt || 0) > 8000 && !entry.loading) {
      this.load(sessionId);
    }
  },

  /** Replace the cached turn groups after switching which answer is shown. */
  patchRuns(sessionId, runs) {
    const entry = this.bySession.get(sessionId);
    if (!entry || !entry.state || !runs || typeof runs !== 'object') return;
    entry.state.runs = runs;
    this.touch(entry);
    this.notify();
  },

  invalidate(sessionId) {
    if (!sessionId) {
      const stale = [];
      this.bySession.forEach((entry, key) => {
        if (entry) this.touch(entry, true);
        stale.push(key);
      });
      this.notify();
      // A caller without a session is asking for "everything is stale", so every
      // cached conversation has to be refetched — notifying alone would leave the
      // panels showing what they had until some later reload.
      for (let i = 0; i < stale.length; i++) this.load(stale[i]);
      return;
    }
    const entry = this.bySession.get(sessionId);
    if (entry) this.touch(entry, true);
    this.load(sessionId);
  },

  /**
   * Keep asking for a session while a turn it just opened settles.
   *
   * Answering a question again returns as soon as the follow-up is queued, so the
   * turn it opened is not in the log yet — and when the model fails, the failure
   * lands later still. One refetch is not enough for the card to learn that the
   * turn produced no answer, and a turn without an answer has no action row of
   * the app's own: the row we draw is the only toolbar it will ever get.
   */
  follow(sessionId, times) {
    const self = this;
    if (!sessionId) return;
    let left = typeof times === 'number' ? times : 7;
    const step = function () {
      if (left <= 0) return;
      left -= 1;
      self.invalidate(sessionId);
      if (left > 0) setTimeout(step, 1600);
    };
    setTimeout(step, 900);
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
// The app's conversation assembly, bound in apply(): it is the only thing that
// can turn a stored image attachment into a URL, which is what makes a picture
// dropped into a question show up as a picture instead of a file name.
let conversationService = null;

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




/** The file attachments of one message: `{type:'file', attachment:{name, bytes}}`. */

/** Bytes as the app's own file cards spell them, without needing its helpers. */


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

function attachmentName(block) {
  const ref = block && block.attachment ? block.attachment : null;
  if (ref === null) return 'file';
  if (typeof ref.name === 'string' && ref.name !== '') return ref.name;
  return block.type === 'image' ? 'image' : 'file';
}

function bytesLabel(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return '';
  if (bytes < 1024) return String(bytes) + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

/** `PDF`, `PNG`, `TS`: the suffix the app's file cards lead their meta line with. */
function suffixOf(name) {
  const text = String(name === undefined || name === null ? '' : name);
  const dot = text.lastIndexOf('.');
  return dot <= 0 || dot === text.length - 1 ? '' : text.slice(dot + 1);
}

/**
 * The meta line of a file card, word for word as the app writes it:
 * `[SUFFIX, sizeText].filter(Boolean).join(' ')`. Both helpers come from the
 * primitives package when it is there, so `4.2KB` reads the same in both places.
 */
function fileMetaText(block) {
  const api = clientPrimitives();
  const name = attachmentName(block);
  const ref = block && block.attachment ? block.attachment : null;
  const suffix = api !== null && typeof api.fileExtension === 'function' ? api.fileExtension(name) : suffixOf(name);
  const size = ref !== null && typeof ref.bytes === 'number'
    ? (api !== null && typeof api.fileSizeText === 'function' ? api.fileSizeText(ref.bytes) : bytesLabel(ref.bytes))
    : '';
  return [String(suffix === undefined || suffix === null ? '' : suffix).toUpperCase().slice(0, 8), size]
    .filter(function (part) { return typeof part === 'string' && part !== ''; })
    .join(' ');
}

/** The 28px category glyph the app puts in front of a file name. */
function fileGlyph(block) {
  const api = clientPrimitives();
  const name = attachmentName(block);
  if (api !== null && isComponent(api.FileTypeIcon)) {
    return h(api.FileTypeIcon, { path: name, className: 'mtt-file-icon' });
  }
  return h('span', { className: 'mtt-file-icon mtt-file-icon-plain' },
    String(suffixOf(name) || 'file').toUpperCase().slice(0, 4));
}

function attachmentMeta(block) {
  const ref = block && block.attachment ? block.attachment : null;
  if (ref === null) return '';
  if (typeof ref.bytes === 'number') return bytesLabel(ref.bytes);
  if (typeof ref.width === 'number' && typeof ref.height === 'number') return String(ref.width) + ' × ' + String(ref.height);
  return block.type === 'image' ? 'image' : '';
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

/** Full source when the host knows it; old hosts can still supply origins. */
function sourceOf(state, turn) {
  const ring = answerRing(state ? state.answers : null, turn);
  if (ring !== null && ring.active.id !== 'native' && typeof ring.active.text === 'string') return ring.active.text;
  const override = answerOverride(state ? state.answers : null, turn);
  if (override !== null) return override.text;
  const info = turnInfo(state, turn);
  if (info && typeof info.answerText === 'string') return info.answerText;
  const origin = originOf(state, turn);
  if (origin !== '') return origin;
  const messages = state && Array.isArray(state.messages) ? state.messages : [];
  return messages.filter((message) => message && message.turn === turn && typeof message.text === 'string')
    .map((message) => message.text).join('\n\n');
}

function langLabel(id) {
  for (let i = 0; i < LANGS.length; i++) if (LANGS[i].id === id) return LANGS[i].label;
  return id;
}

/* ------------------------------------------------------ answer variants -- */

/**
 * The group of turns that answer one question, if this turn belongs to one.
 *
 * Answering again appends a real turn: the same question, a fresh answer, with
 * the agent's own tools, thinking and streaming — indistinguishable from the
 * first answer, because it *is* the same machinery. Those turns are
 * alternatives of one answer, and the host remembers the group; here they are
 * read back as `{ key, active, turns }`, where `key` is the turn the question
 * was asked in and `turns` runs in the order the answers were produced.
 */
function runsOf(runs, turn, hidden) {
  if (!runs || typeof turn !== 'number') return null;
  const keys = Object.keys(runs);
  for (let i = 0; i < keys.length; i++) {
    const group = runs[keys[i]];
    if (!group || !Array.isArray(group.turns)) continue;
    if (group.turns.indexOf(turn) < 0) continue;
    // A deleted answer is not an alternative any more. The host drops it from the
    // group when it is deleted, but a group can still list one — state written by
    // an older build, or a delete whose record never made it back — and then
    // `active` may name a turn nobody can see. Since a card stands down for every
    // turn that is not the active one, that strands the surviving answer: it keeps
    // its rows but loses its ring and its toolbar. Reading the marks here keeps
    // the group honest whatever the host sent.
    const alive = group.turns.filter((value) => !isGoneTurn(hidden, value));
    const turns = alive.length > 0 ? alive : group.turns.slice();
    const wanted = typeof group.active === 'number' ? group.active : turns[turns.length - 1];
    return {
      key: Number(keys[i]),
      active: turns.indexOf(wanted) < 0 ? turns[turns.length - 1] : wanted,
      turns: turns,
      models: group.models || {},
    };
  }
  return null;
}

/** Whether the reader deleted this turn or its answer. */
function isGoneTurn(hidden, turn) {
  if (!hidden || typeof turn !== 'number') return false;
  return (Array.isArray(hidden.turns) && hidden.turns.indexOf(turn) !== -1)
    || (Array.isArray(hidden.answers) && hidden.answers.indexOf(turn) !== -1);
}

/** Which answer of the group is on screen, `1`-based, for `‹ i/n ›`. */
function runPosition(run) {
  const index = run.turns.indexOf(run.active);
  return { count: run.turns.length, index: index < 0 ? run.turns.length - 1 : index };
}


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
 * The question as the reader rewrote it, or `null` when the row still shows what
 * was actually sent. A rewrite never regenerates anything by itself.
 */
function promptOverride(state, turn) {
  const prompts = state ? state.prompts : null;
  if (!prompts || typeof turn !== 'number') return null;
  const entry = prompts[String(turn)];
  return entry && typeof entry.text === 'string' ? entry : null;
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
  const requestOptions = {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/x-ndjson' },
    body: JSON.stringify(Object.assign({}, operation, { stream: true })),
  };
  if (callbacks.signal !== undefined) requestOptions.signal = callbacks.signal;
  const res = await g.fetch(ROUTE, requestOptions);
  if (!res.ok) {
    const body = await res.json().catch(function () { return {}; });
    throw new Error(body.error || ('HTTP ' + res.status));
  }

  let payload = null;
  let failure = null;
  let terminal = false;

  function frame(line) {
    const text = line.trim();
    if (text.length === 0) return;
    let value;
    try { value = JSON.parse(text); } catch (e) { throw new Error('流响应包含无效 JSON。'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || terminal) {
      throw new Error('流响应格式无效。');
    }
    if (value.type === 'start') {
      if (callbacks.onStart) callbacks.onStart(value);
    } else if (value.type === 'delta') {
      if (typeof value.text !== 'string') throw new Error('流响应文本格式无效。');
      if (callbacks.onDelta) callbacks.onDelta(value.text);
    } else if (value.type === 'reasoning') {
      if (typeof value.text !== 'string') throw new Error('流响应推理格式无效。');
      if (callbacks.onReasoning) callbacks.onReasoning(value.text);
    } else if (value.type === 'done') {
      if (!value.payload || typeof value.payload !== 'object' || Array.isArray(value.payload)) {
        throw new Error('流响应结果格式无效。');
      }
      payload = value.payload;
      terminal = true;
    } else if (value.type === 'error') {
      failure = value.message || '重答失败。';
      terminal = true;
    } else {
      throw new Error('流响应包含未知消息格式。');
    }
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let ended = false;
    try {
      while (!terminal) {
        const step = await reader.read();
        if (step.done) { ended = true; break; }
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
    } finally {
      try {
        if (!ended && typeof reader.cancel === 'function') {
          const cancelled = reader.cancel();
          // A verified terminal frame is already authoritative; cleanup must
          // not keep Stop enabled while the connection finishes closing.
          if (terminal) Promise.resolve(cancelled).catch(function () {});
          else await cancelled;
        }
      } catch (e) {
        // Preserve the actual decoding/network error when cancellation fails.
      } finally {
        if (typeof reader.releaseLock === 'function') reader.releaseLock();
      }
    }
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
function translationRequestKey(sessionId, turn) {
  return String(sessionId) + '|' + String(turn);
}

/** Stop one turn's translation without allowing its late response to write back. */
function cancelTranslation(sessionId, turn) {
  const key = translationRequestKey(sessionId, turn);
  const current = translationRequests.get(key);
  if (!current) return false;
  translationRequests.delete(key);
  current.controller.abort();
  store.setLiveTranslation(sessionId, turn, null);
  return true;
}

async function translateInto(sessionId, turn, body) {
  if (store.getLiveTranslation(sessionId, turn) !== null) return null;
  const entry = store.get(sessionId);
  const answerRevision = entry && entry.answerRevisions ? entry.answerRevisions[String(turn)] || 0 : 0;
  const unchanged = function () {
    const current = store.get(sessionId);
    const version = current && current.answerRevisions ? current.answerRevisions[String(turn)] || 0 : 0;
    return version === answerRevision && !isGoneTurn(current && current.state && current.state.hidden, turn);
  };
  const source = typeof body.text === 'string' ? body.text : sourceOf(entry && entry.state, turn);
  if (source !== '') store.patchOrigin(sessionId, turn, source);
  const token = {};
  const ownsLive = function () {
    const current = store.getLiveTranslation(sessionId, turn);
    return current !== null && current.token === token;
  };
  const seed = { lang: body.lang, text: '', token: token };
  const controller = new AbortController();
  const requestKey = translationRequestKey(sessionId, turn);
  const request = { controller: controller };
  translationRequests.set(requestKey, request);
  store.setLiveTranslation(sessionId, turn, seed);
  try {
    const payload = await streamOperation(Object.assign({ action: 'translate', sessionId: sessionId }, body), {
      signal: controller.signal,
      onDelta: function (text) {
        if (!unchanged() || !ownsLive()) return;
        const live = store.getLiveTranslation(sessionId, turn);
        store.setLiveTranslation(sessionId, turn, Object.assign({}, live, { text: (live.text || '') + text }));
      },
    });
    if (!unchanged() || !ownsLive()) throw new Error('回答已修改，请重新翻译。');
    if (controller.signal.aborted) return null;
    const sourceTurn = typeof payload.turn === 'number' ? payload.turn : turn;
    if (typeof payload.origin === 'string') store.patchOrigin(sessionId, sourceTurn, payload.origin);
    store.patchTranslation(sessionId, payload.seq, payload.lang, {
      text: payload.text, provider: payload.provider, model: payload.model,
      turn: payload.turn, role: payload.role, truncated: payload.truncated === true,
    });
    store.patchShown(sessionId, typeof payload.turn === 'number' ? payload.turn : turn, payload.lang);
    return payload;
  } catch (error) {
    if (controller.signal.aborted) return null;
    throw error;
  } finally {
    if (translationRequests.get(requestKey) === request) translationRequests.delete(requestKey);
    if (ownsLive()) store.setLiveTranslation(sessionId, turn, null);
  }
}

/** POST a hide/restore operation and fold the new lists into the cache. */
async function hideMutate(operation) {
  const result = await mutate(operation);
  if (result && result.hidden) store.patchHidden(operation.sessionId, result.hidden);
  // Deleting an answer of a question that was answered again also takes it out
  // of its group, and the host answers with the groups that are left. Without
  // this the ring kept the deleted answer and the survivor stayed "not active",
  // which is what made its card (and its toolbar) disappear.
  if (result && result.runs) store.patchRuns(operation.sessionId, result.runs);
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
  // Notices the answer was read with: the injected-context line and the "asked to
  // keep going" line sit above the answer, belong to that turn, and read as
  // leftovers once it is gone.
  'context',
  'turn-trigger',
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
    // One turn can carry more than one mark — a replayed prompt and the answer
    // it replaced, say — so the marks of a turn are a set, not a single mode.
    const turns = new Map();
    this.marks.forEach(function (mark) {
      const set = turns.get(mark.turn) || new Set();
      set.add(mark.mode);
      turns.set(mark.turn, set);
    });
    const numbers = Array.from(turns.keys()).sort(function (a, b) { return a - b; });
    const key = numbers.map(function (turn) {
      return turn + ':' + Array.from(turns.get(turn)).sort().join('+');
    }).join(',');
    if (key === this.key) return;
    this.key = key;
    const css = [];
    for (let i = 0; i < numbers.length; i++) {
      const turn = numbers[i];
      const modes = turns.get(turn);
      if (modes.has('turn')) {
        // Gone means gone: the whole turn leaves the flow, its own tail row
        // included — deleting is a view-level removal with nothing left behind.
        // The rail is handled by the navigation patch, not here: a mark carries
        // only its position (`data-index`) in the ladder, so hiding by position
        // would hit the wrong turn as soon as one is removed.
        css.push('[data-chat-turn="' + turn + '"]{display:none}');
        continue;
      }
      if (modes.has('prompt')) {
        // A prompt the plugin replayed to get a real answer out of the agent: it
        // is in the log (the log cannot rewrite itself) but must not read as a
        // second, identical question above the answer it produced.
        css.push('[data-chat-flow-kind="user"][data-chat-turn="' + turn + '"]{display:none}');
        // The turn's process group announces itself with a full-width title —
        // "已完成分析" and friends — that belongs to a turn the reader never asked
        // for: its question row is gone, so the title reads as a stray heading
        // above the answer. The steps underneath are the answer's own process and
        // stay; only the title goes, and the body is uncapped so nothing the title
        // used to reveal becomes unreachable.
        css.push('[data-step-process][data-chat-turn="' + turn + '"] > div:first-child{display:none}');
        css.push('[data-step-process][data-chat-turn="' + turn + '"] [data-step-process-body]{max-height:none;overflow:visible}');
        // Answering again makes the agent inject a fresh time and runtime context
        // before it says anything, and the app groups those into one row whose
        // title reads "已注入上下文". Nobody asked to see the plumbing, so a turn
        // this plugin opened on its own loses that row — unless the turn did real
        // work, in which case the row is the record of it (tools, reasoning) and
        // hiding it would hide the answer's own process. The group row carries
        // `data-chat-group-key` and no flow kind, so it needs its own selector.
        if (modes.has('noise')) {
          css.push('[data-step-process][data-chat-turn="' + turn + '"]{display:none}');
          css.push('[data-chat-flow-kind="context"][data-chat-turn="' + turn + '"]{display:none}');
          // And the disclosure that opens onto the same nothing. A turn with no
          // tools and no thinking has no steps to list, so its card reads "已完成 ·
          // Ns" and, opened, shows an empty box — one row that promises detail and
          // cannot deliver it.
          css.push('[data-chat-flow-kind="turn-process"][data-chat-turn="' + turn + '"]{display:none}');
        }
      }
      if (modes.has('deleted')) {
        // "Delete this answer" has to leave nothing of that answer behind: not the
        // body, not the process card, not the tool cards — and not the tail row
        // either, because the tail row is what still carries the action row (and
        // the file-change card) of an answer that no longer exists. The user row
        // keeps its own toolbar, so the turn can still be answered again.
        for (let k = 0; k < DELETED_ANSWER_KINDS.length; k++) {
          css.push('[data-chat-flow-kind="' + DELETED_ANSWER_KINDS[k] + '"][data-chat-turn="' + turn + '"]{display:none}');
        }
      } else if (modes.has('translate')) {
        // A translation is drawn beside the answer, so only the logged body makes
        // way for it — the process card and the tool cards of that answer are
        // still this turn's own record and stay visible.
        css.push('[data-chat-flow-kind="assistant-step"][data-chat-turn="' + turn + '"]{display:none}');
      } else if (modes.has('answer')) {
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

/**
 * Ask the host whether it wants the row dump, and hand it one when it does.
 *
 * This exists because the flow rows belong to the app: when something the reader
 * deleted leaves a row behind, only the client can say which kind that row is and
 * whether it carries a turn. The host turns the dump on with `?rows=1` and keeps
 * the last report, which is then readable over the same route.
 */
let rowDumpWanted = false;
let rowDumpAt = 0;

async function sendRowDump(sessionId, rows) {
  if (!rowDumpWanted) return;
  const now = Date.now();
  if (now - rowDumpAt < 4000) return;
  rowDumpAt = now;
  const digest = [];
  for (let index = 0; index < rows.length && digest.length < 400; index += 1) {
    const row = rows[index];
    if (!row || typeof row.getAttribute !== 'function') continue;
    const raw = row.getAttribute('data-chat-turn');
    // `text` and `chips` say what the row actually shows: a referenced session
    // arrives as `@name` in the text and the app turns it into a chip, so the
    // count is how a missing chip becomes visible from out here.
    const text = typeof row.innerText === 'string' ? row.innerText.replace(/\s+/g, ' ').slice(0, 80) : '';
    let chips = 0;
    if (typeof row.querySelectorAll === 'function') {
      try {
        chips = row.querySelectorAll('[class*="chip" i]:not([class*="mtt-"])').length;
      } catch (error) {
        chips = -1;
      }
    }
    digest.push({
      kind: row.getAttribute('data-chat-flow-kind'),
      key: row.getAttribute('data-chat-anchor-key'),
      turn: raw === null ? null : Number(raw),
      hidden: row.style && row.style.display === 'none',
      text: text,
      chips: chips,
    });
  }
  try {
    await mutate({ action: 'rows', sessionId: sessionId, rows: digest });
  } catch (error) {
    // A dump is diagnostics: it must never break the pass that produces it.
  }
}

/** The app's own upload route: bytes in, a durable attachment reference out. */
const UPLOAD_ROUTE = '/api/session/uploadFileBinary';

/**
 * Hand one dropped file to the app's upload endpoint and return the content block
 * a prompt would carry for it.
 *
 * The endpoint stores the bytes durably and answers with the reference, so the
 * file is uploaded exactly once and nothing new is invented here: an image is
 * admitted as an image (the app normalizes it), everything else verbatim as a
 * file. The reference is opaque to this plugin — it travels from the upload to
 * the replayed prompt untouched.
 */
async function uploadAttachment(sessionId, file) {
  const g = realGlobal();
  const mediaType = typeof file.type === 'string' ? file.type.toLowerCase() : '';
  const image = mediaType.indexOf('image/') === 0;
  const query = '?sessionId=' + encodeURIComponent(sessionId)
    + '&name=' + encodeURIComponent(typeof file.name === 'string' ? file.name : 'file')
    + (image ? '&mediaType=' + encodeURIComponent(mediaType) : '');
  const res = await g.fetch(UPLOAD_ROUTE + query, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: file,
  });
  const body = await res.json().catch(function () { return null; });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  if (body === null || body.ok !== true) {
    const failure = body && body.error ? body.error : null;
    throw new Error(failure && typeof failure.message === 'string' ? failure.message : '上传失败');
  }
  const value = body.value === undefined || body.value === null ? {} : body.value;
  if (image && value.image) return { type: 'image', attachment: value.image };
  if (value.file) return { type: 'file', attachment: value.file };
  throw new Error('上传没有返回附件引用。');
}

/* ------------------------------------------------------------ file changes -- */

/**
 * The files this turn changed, or null when there is nothing to undo.
 *
 * Answering again only makes sense from the workspace the answer started from:
 * if the answer being replaced had already edited files, those edits stay on
 * disk and the next model would build on top of them (or, for a text-only
 * variant, could not see them at all). The host can undo them because DSH's own
 * `dsh-workspace-changes` records each turn's changed files — when it did not
 * (no recorder, host restarted, or the turn changed nothing), this returns null
 * and the caller keeps the plain behaviour.
 */
async function turnChangePlan(sessionId, turn) {
  if (typeof turn !== 'number') return null;
  let plan;
  try {
    plan = await mutate({ action: 'changes', sessionId: sessionId, turn: turn });
  } catch (error) {
    return null;
  }
  if (plan === null || typeof plan !== 'object' || plan.supported !== true) return null;
  const files = Array.isArray(plan.files) ? plan.files : [];
  return files.length === 0 ? null : plan;
}

/**
 * Undo the turn's file changes, then answer again.
 *
 * Answering again creates a native context branch. Undoing the edits first
 * also restores the verifiable workspace changes made by the old answer.
 */
async function rerunAfterRevert(options) {
  const reverted = await mutate({ action: 'revert', sessionId: options.sessionId, turn: options.turn });
  if (!reverted || !Array.isArray(reverted.reverted) || !Array.isArray(reverted.skipped)) {
    throw new Error(t('revertUnconfirmed'));
  }
  const blocked = reverted.skipped.filter(function (file) {
    return !file || (file.reason !== 'unchanged' && file.reason !== 'already-gone');
  });
  if (blocked.length > 0) throw new Error(t('revertIncomplete', {
    reverted: String(reverted.reverted.length), count: String(blocked.length),
    files: blocked.map(function (file) { return file && (file.display || file.path || file.reason); }).join(', '),
  }));
  const result = await rerunTurnInPlace(options);
  return Object.assign({}, result, { revertedCount: reverted.reverted.length });
}

/** Rewind to the question and answer through the native agent in a new branch. */
async function rerunTurnInPlace(options) {
  const result = await contextMutation(options.sessionId, options.turn, 'retry', {
    ...(options.model ? { model: { provider: options.model.provider, model: options.model.model } } : {}),
    ...(typeof options.text === 'string' ? { text: options.text } : {}),
    ...(Array.isArray(options.files) ? { files: options.files } : {}),
    stopPrevious: options.stopPrevious === true,
  });
  return { kind: 'branch', sessionId: result.sessionId };
}

async function changeContext(request, sourceMount) {
  const sourceId = request.sourceSessionId || request.sessionId;
  const serial = startNavigation(sourceId, sourceMount);
  const result = await mutate(request);
  if (!result || typeof result.sessionId !== 'string') throw new Error(t('contextMissing'));
  try {
    assertNavigation(serial, sourceId);
    store.invalidate();
    await switchToVersion(navigation, { sessionId: result.sessionId, navigationToken: result.navigationToken,
      archived: result.archived }, sourceId, serial);
  } catch (error) {
    if (request.action === 'context-normalize' && result.navigationToken) {
      mutate({ action: 'cancel-focus', sessionId: result.sessionId, token: result.navigationToken }).catch(function () {});
    }
    throw error;
  }
  return result;
}

function contextMutation(sessionId, turn, operation, extra) {
  return changeContext(Object.assign({ action: 'context-branch', sessionId: sessionId,
    turn: turn, operation: operation }, extra || {}));
}

/** The confirmation a file-changing turn needs before anything is written. */
function RevertConfirm(props) {
  const plan = props.plan;
  const files = plan && Array.isArray(plan.files) ? plan.files : [];
  const shown = files.slice(0, 8);
  return h(React.Fragment, null,
    h('div', { className: 'mtt-pop-title' }, t('revertTitle', { count: String(files.length) })),
    h('div', { className: 'mtt-change-list' }, shown.map(function (file, index) {
      return h('div', { className: 'mtt-change-row', key: String(index) },
        h('span', { className: 'mtt-change-path', title: String(file.display) }, String(file.display)),
        h('span', { className: 'mtt-change-stat' },
          '+' + String(file.added || 0) + ' −' + String(file.deleted || 0)));
    }), files.length > shown.length
      ? h('div', { className: 'mtt-change-more' }, t('revertMore', { count: String(files.length - shown.length) }))
      : null),
    h('div', { className: 'mtt-pop-actions' },
      h('button', {
        className: 'mtt-btn mtt-btn-small', type: 'button', onClick: props.onCancel,
      }, t('cancel')),
      h('button', {
        className: 'mtt-btn mtt-btn-primary mtt-btn-small',
        type: 'button',
        disabled: props.busy === true,
        onClick: props.onConfirm,
      }, t('revertAndAnswer'))));
}

/* -------------------------------------------------------------- navigation -- */

let navigationSerial = 0;
let cancelNavigationWait = null;
let navigationSourceMount = null;
const contextMounts = new Set();
let activeEmbeddedNavigation = false;
let pendingFocus = null;
const focusRequests = new Map();

function contextMountAvailable(mount) {
  const frame = mount.frame.current;
  return !frame || (frame.isConnected !== false && !frame.closest?.('[inert], [aria-hidden="true"], [hidden]'));
}

function foregroundContextMount() {
  return [...contextMounts].reverse().find(contextMountAvailable);
}

function navigationSuperseded() {
  const error = new Error(t('navigationSuperseded'));
  error.name = 'NavigationSupersededError';
  return error;
}

function startNavigation(sourceId, sourceMount) {
  if (activeEmbeddedNavigation) throw new Error(t('navigationBusy'));
  if (sourceMount && sourceMount !== foregroundContextMount()) throw navigationSuperseded();
  const serial = ++navigationSerial;
  if (cancelNavigationWait) cancelNavigationWait();
  navigationSourceMount = sourceMount || [...contextMounts].reverse().find(function (mount) { return mount.sessionId === sourceId; }) || null;
  pendingFocus = null;
  return serial;
}

function assertNavigation(serial, sourceId) {
  const foreground = foregroundContextMount();
  if (serial !== navigationSerial
    || (navigationSourceMount && (!contextMounts.has(navigationSourceMount) || !contextMountAvailable(navigationSourceMount)))
    || (foreground && foreground.sessionId !== sourceId)) {
    throw navigationSuperseded();
  }
}

function openWorkspaceVersion(uiWorkspace, sessionId, options) {
  const g = realGlobal();
  let handler = null, accepting = true;
  if (g && typeof g.dispatchEvent === 'function' && typeof g.CustomEvent === 'function') {
    const detail = Object.freeze({ version: 1, sourceSessionId: options && options.sourceSessionId,
      targetSessionId: sessionId,
      claim: function (candidate) {
        if (!accepting || handler || typeof candidate !== 'function') return false;
        handler = candidate;
        return true;
      },
    });
    try { g.dispatchEvent(new g.CustomEvent('dsh-message-toolbar:open-version', { detail: detail })); }
    finally { accepting = false; }
  }
  // The embedded host owns both persistence and rendering once it claims this
  // navigation. A failed claim must surface to the editor, never open a window.
  if (!handler) return uiWorkspace.openSession(sessionId);
  activeEmbeddedNavigation = true;
  return Promise.resolve().then(handler).finally(function () {
    activeEmbeddedNavigation = false;
    foregroundContextMount()?.checkMigration?.();
  });
}

function openWhenListed(nav, sessionId, sourceId, serial) {
  return new Promise(function (resolve, reject) {
    let stop = function () {}, timer = null, settled = false, opening = false;
    function finish(error) {
      if (settled) return;
      settled = true;
      stop();
      if (timer !== null) clearTimeout(timer);
      if (cancelNavigationWait === cancel) cancelNavigationWait = null;
      if (error) reject(error); else resolve();
    }
    function cancel() { finish(navigationSuperseded()); }
    cancelNavigationWait = cancel;
    function check() {
      if (opening || settled) return;
      try {
        assertNavigation(serial, sourceId);
        const list = nav.list;
        if (list && typeof list.getSnapshot === 'function' && !list.getSnapshot().byId[sessionId]) return;
        opening = true;
        Promise.resolve(nav.openVersion(sessionId, { sourceSessionId: sourceId })).then(function () { finish(); }, finish);
      } catch (error) { finish(error); }
    }
    if (nav.list && typeof nav.list.subscribe === 'function') stop = nav.list.subscribe(check);
    if (settled) { stop(); return; }
    timer = setTimeout(function () { finish(new Error(t('navigationTimeout'))); }, 15000);
    check();
  });
}

async function switchToVersion(nav, version, currentSessionId, serial = startNavigation(currentSessionId)) {
  if (!version || version.deleted) return;
  if (version.sessionId === currentSessionId) {
    if (version.navigationToken) {
      pendingFocus = { target: version.sessionId, token: version.navigationToken };
      store.invalidate(currentSessionId);
    }
    return;
  }
  if (!nav || typeof nav.openVersion !== 'function') throw new Error(t('navigationMissing'));
  let token = version.navigationToken, archived = version.archived;
  if (!token) {
    const job = await mutate({ action: 'prepare-focus', sessionId: version.sessionId, sourceSessionId: currentSessionId });
    token = job.token;
    archived = job.archived;
  }
  assertNavigation(serial, currentSessionId);
  if (archived) {
    await mutate({ action: 'activate', sessionId: version.sessionId });
    store.invalidate();
    assertNavigation(serial, currentSessionId);
  }
  pendingFocus = { target: version.sessionId, token: token };
  try { await openWhenListed(nav, version.sessionId, currentSessionId, serial); }
  catch (error) {
    if (serial === navigationSerial) pendingFocus = null;
    throw error;
  }
}

function useFocusPending(sessionId, state, retrySerial, frame) {
  const saved = state && state.pendingFocus;
  const token = pendingFocus && pendingFocus.target === sessionId ? pendingFocus.token : saved && saved.token;
  React.useEffect(function () {
    if (!token || focusRequests.has(token)) return;
    if (pendingFocus && (pendingFocus.target !== sessionId || pendingFocus.token !== token)) return;
    if (frame && !contextMountAvailable({ frame: frame })) {
      const entry = store.get(sessionId);
      if (entry && entry.state && !entry.state.contextError) {
        entry.state.contextError = t('navigationSuperseded');
        store.notify();
      }
      return;
    }
    let settled = false;
    focusRequests.set(token, true);
    if (focusRequests.size > 100) focusRequests.delete(focusRequests.keys().next().value);
    mutate({ action: 'focus', sessionId: sessionId, token: token })
      .then(function () {
        if (settled) return;
        settled = true;
        focusRequests.delete(token);
        if (pendingFocus && pendingFocus.token === token) pendingFocus = null;
        store.invalidate();
      })
      .catch(function (error) {
        if (settled) return;
        settled = true;
        // A failed focus must not poison this token forever. The host rolls back
        // any archive it started; cancel the durable job so a remount can retry.
        focusRequests.delete(token);
        mutate({ action: 'cancel-focus', sessionId: sessionId, token: token }).catch(function () {});
        if (pendingFocus && pendingFocus.token === token) pendingFocus = null;
        const entry = store.get(sessionId);
        if (entry && entry.state) { entry.state.contextError = failureText(error); store.notify(); }
      });
    return function () {
      if (settled) return;
      settled = true;
      focusRequests.delete(token);
      if (pendingFocus && pendingFocus.token === token) pendingFocus = null;
      // The target component can disappear while archiveSession is in flight.
      // Tell the host to restore the source instead of leaving a half-focused
      // version stranded in the workspace.
      mutate({ action: 'cancel-focus', sessionId: sessionId, token: token }).catch(function () {});
    };
  }, [sessionId, token, retrySerial]);
}

function holdLegacyComposer(blocks, sessionId) {
  if (typeof blocks?.storeFor !== 'function' || typeof blocks.set !== 'function') return;
  const native = blocks.storeFor(sessionId);
  if (typeof native?.getSnapshot !== 'function') return;
  const block = { reason: t('checkingContext') };
  function ensure() {
    if (native.getSnapshot() === undefined) blocks.set(sessionId, block);
  }
  const unsubscribe = native.subscribe?.(ensure);
  ensure();
  return function () {
    unsubscribe?.();
    if (native.getSnapshot() === block) blocks.set(sessionId, undefined);
  };
}

// The composer is present even after deleting the only question in a session.
function ContextFocus(props) {
  const sessionId = props.sessionId;
  const frame = React.useRef(null);
  const contextMount = React.useRef(null);
  const toolbar = useToolbar(sessionId);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [retrySerial, setRetrySerial] = React.useState(0);
  React.useEffect(function () {
    const mount = { sessionId: sessionId, frame: frame };
    contextMount.current = mount;
    contextMounts.add(mount);
    return function () {
      contextMounts.delete(mount);
      contextMount.current = null;
      foregroundContextMount()?.checkMigration?.();
    };
  }, [sessionId]);
  useFocusPending(sessionId, toolbar && toolbar.state, retrySerial, frame);
  const state = toolbar && toolbar.state;
  const needsMigration = state?.needsContextMigration === true;
  const holdComposer = needsMigration || (!state && !toolbar?.error);
  React.useLayoutEffect(function () {
    // Keep native Send and its keyboard shortcut pointed away from legacy history.
    if (holdComposer) return holdLegacyComposer(props.composerBlocks, sessionId);
  }, [props.composerBlocks, sessionId, holdComposer]);
  async function normalize(mount) {
    if (busy || activeEmbeddedNavigation || !mount || mount !== foregroundContextMount()
      || contextMigrations.get(sessionId)?.pending) return;
    contextMigrations.set(sessionId, { pending: true });
    store.notify();
    try {
      await changeContext({ action: 'context-normalize', sessionId: sessionId }, mount);
      contextMigrations.set(sessionId, { complete: true });
    } catch (error) {
      if (error.name === 'NavigationSupersededError') {
        if (foregroundContextMount() === mount) contextMigrations.set(sessionId, { complete: true });
        else {
          contextMigrations.delete(sessionId);
          foregroundContextMount()?.checkMigration?.();
        }
      } else contextMigrations.set(sessionId, { error: failureText(error) });
    }
    finally { store.notify(); }
  }
  React.useEffect(function () {
    const mount = contextMount.current;
    if (!needsMigration || !mount) return;
    let watching = true;
    function checkMigration() {
      // Wait until all composers from this render have registered in mount order.
      Promise.resolve().then(function () {
        if (watching && !contextMigrations.has(sessionId)) void normalize(mount);
      });
    }
    mount.checkMigration = checkMigration;
    checkMigration();
    const Observer = realGlobal()?.MutationObserver;
    const observer = typeof Observer === 'function' ? new Observer(checkMigration) : null;
    if (observer) {
      for (let node = frame.current; node; node = node.parentElement) {
        observer.observe(node, { attributes: true, attributeFilter: ['inert', 'aria-hidden', 'hidden'] });
      }
    }
    return function () {
      watching = false;
      delete mount.checkMigration;
      observer?.disconnect();
    };
  }, [sessionId, needsMigration]);
  async function retryFocus() {
    if (busy) return;
    const localPending = pendingFocus && pendingFocus.target === props.sessionId ? pendingFocus : null;
    const pending = localPending && localPending.source ? localPending : state && state.pendingFocus;
    const source = pending && pending.source;
    if (!pending || typeof source !== 'string') {
      setError(t('navigationRetryUnavailable'));
      return;
    }
    setBusy(true); setError(null);
    try {
      await mutate({ action: 'cancel-focus', sessionId: props.sessionId, token: pending.token }).catch(function () {});
      const job = await mutate({ action: 'prepare-focus', sessionId: props.sessionId, sourceSessionId: source });
      pendingFocus = { target: props.sessionId, token: job.token, source: source };
      const entry = store.get(props.sessionId);
      if (entry && entry.state) entry.state.contextError = null;
      setRetrySerial(function (value) { return value + 1; });
      store.invalidate();
    } catch (error) { setError(failureText(error)); }
    finally { setBusy(false); }
  }
  const localJob = pendingFocus && pendingFocus.target === props.sessionId ? pendingFocus : null;
  const focusJob = localJob && localJob.source ? localJob : state && state.pendingFocus;
  const canRetryFocus = typeof focusJob?.source === 'string';
  const migration = contextMigrations.get(sessionId);
  const migrationFailure = needsMigration && migration?.error;
  const focusFailure = error || (!needsMigration && state?.contextError);
  return h('div', { ref: frame },
    needsMigration && !migrationFailure
      ? migration?.complete
        ? h('div', { className: 'mtt-context-notice' }, h('button', { type: 'button', className: 'mtt-btn mtt-btn-small', disabled: busy,
          onClick: function () { return normalize(contextMount.current); } }, t('openMigratedContext')))
        : h('div', { className: 'mtt-context-notice', role: 'status' }, t('syncingContext'))
      : null,
    migrationFailure || focusFailure
      ? h('div', { className: 'mtt-context-error' },
        h(ErrorChip, { error: migrationFailure || focusFailure }),
        migrationFailure ? h('button', { type: 'button', className: 'mtt-btn mtt-btn-small', disabled: busy,
          onClick: function () { return normalize(contextMount.current); } }, t('retrySync'))
          : canRetryFocus ? h('button', { type: 'button', className: 'mtt-btn mtt-btn-small', disabled: busy,
            onClick: retryFocus }, t('retryNavigation')) : null)
      : null);
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
      if (v.deleted) return false;
      if (v.sessionId === fork.sessionId) return true;
      // A regenerate is a replacement, not another card: its child session must
      // not turn into a `‹ 1/2 ›` the reader never asked for. Edits keep their ring.
      if (v.operation === 'retry') return false;
      return v.targetTurn === turn && walksToFork(v);
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

/** Stop square shown in the translate control while its AbortSignal is active. */
function StopIcon() {
  return glyph(h('rect', {
    x: 4, y: 4, width: 8, height: 8, rx: 1.5,
    stroke: 'currentColor', fill: 'currentColor',
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

function ClipIcon() {
  return glyph(h('path', {
    d: 'M11.6 5.2 6.35 10.45a1.75 1.75 0 0 0 2.47 2.47l5.1-5.1a3.3 3.3 0 0 0-4.66-4.66L4.5 7.93a4.9 4.9 0 0 0 6.93 6.93',
    stroke: 'currentColor',
    strokeLinecap: 'round',
  }));
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

/** Clipboard writes may reject asynchronously when permissions or focus change. */
async function writeClipboard(text) {
  const g = realGlobal();
  const clipboard = g && g.navigator && g.navigator.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') throw new Error(t('clipboardUnavailable'));
  await clipboard.writeText(text);
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

// Mounting one React root per decorated row needs the client entry point: a
// `createRoot` is not on `react-dom` itself.
let reactDomClientCache;
function clientReactDomClient() {
  if (reactDomClientCache !== undefined) return reactDomClientCache;
  try {
    reactDomClientCache = require('react-dom/client');
  } catch (e) {
    reactDomClientCache = null;
  }
  return reactDomClientCache;
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
  const [error, setError] = React.useState(null);
  const ring = props.ring;
  if (!ring) return null;
  const current = ring.alternatives[ring.index];
  const go = function (delta) {
    const next = ring.alternatives[ring.index + delta];
    if (next) switchToVersion(navigation, next, props.sessionId).catch(function (e) { setError(failureText(e)); });
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
    }, '›'), h(ErrorChip, { error: error }));
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
    props.copy === true
      ? h('button', {
        type: 'button',
        className: 'mtt-pop-item',
        onClick: function () { props.onCopy(); },
      }, props.copyLabel)
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
const COPY_TRANSLATION_ROW = 'message-toolbar/copy-translation';

/**
 * The "translate" action: a menu of target languages, nothing else. It is the
 * same native dropdown the model picker uses, so both toolbars share one
 * interaction, and it replaces the old settings fields — the language is picked
 * at the moment of translating instead of being configured up front.
 */
function LanguageMenuHost(props) {
  const primitives = clientPrimitives();
  // While a translation is on its way, keep its toolbar button available as the
  // stop action instead of disabling the only control that can end the request.
  const trigger = h(ActionButton, {
    title: props.busy === true ? props.busyTitle : props.title,
    active: props.open || props.active === true,
    disabled: props.busy === true ? false : props.disabled,
    onClick: props.busy === true ? props.onCancel : props.onToggle,
  }, props.busy === true ? h(StopIcon) : h(TranslateIcon));

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
          copy: props.copy === true,
          copyLabel: props.copyLabel,
          onCopy: props.onCopy,
          onPick: props.onPick,
        })
        : null);
  }

  // A translation replaces the answer, so the same menu has to offer the way
  // back: "Show the original" is the first row whenever one is on screen, and the
  // translation's own text sits right under it so it can be copied on its own.
  const rows = (props.original === true
    ? [{ id: ORIGINAL_ROW, label: props.originalLabel }]
    : []).concat(props.copy === true ? [{ id: COPY_TRANSLATION_ROW, label: props.copyLabel }] : [])
    .concat(LANGS.map(function (lang) { return { id: lang.id, label: lang.label }; }));

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
      if (id === COPY_TRANSLATION_ROW) { props.onCopy(); return; }
      const picked = LANGS.find(function (lang) { return lang.id === id; });
      if (picked) props.onPick(picked.id);
    },
    onClose: props.onClose,
  });
}

/**
 * The answers of one turn, as rows of a menu: `1. native`, `2. deepseek-flash`,
 * and so on. Naming an answer by the model that wrote it is what makes the list
 * worth opening — stepping through `1/3` tells a reader nothing about which
 * model wrote what.
 *
 * Two shapes reach this function. A run keeps every answer as a turn of its own,
 * so the rows are turns and the model of each one was recorded when the answer
 * was made. An answer that never got a turn of its own (an in-place variant) is
 * named by the provider and model the plugin asked.
 */
function answerChoiceLabel(name, text) {
  const preview = railPreview(text);
  return h('span', { className: 'mtt-answer-choice' },
    h('span', { className: 'mtt-answer-choice-model' }, name),
    preview.length > 0
      ? h('span', { className: 'mtt-answer-choice-preview', title: preview }, preview)
      : null);
}

function choicePreview(turns, turnNumber, fallback) {
  const turn = Array.isArray(turns)
    ? turns.find(function (item) { return item && item.turn === turnNumber; })
    : null;
  const text = turn && turn.answerText;
  return typeof text === 'string' && text.length > 0 ? text : fallback;
}

function ringChoices(run, ring, turns, answers) {
  if (run !== null) {
    const known = run.models && typeof run.models === 'object' ? run.models : {};
    return {
      selectedId: String(run.active),
      items: run.turns.map(function (turnNumber, index) {
        const legacy = answerRing(answers, turnNumber);
        const picked = legacy !== null && legacy.active.id !== 'native' ? legacy.active : null;
        const model = picked || known[String(turnNumber)];
        // The group's first turn is the answer the app made first, so it gets the
        // same name the variant ring gives slot 1 instead of a bare number.
        const name = model && (model.model || model.provider)
          ? (model.model || model.provider)
          : index === 0 ? t('nativeAnswer') : t('answerNumber', { n: index + 1 });
        const edit = answerOverride(answers, turnNumber);
        const preview = picked !== null ? picked.text : edit !== null ? edit.text
          : choicePreview(turns, turnNumber, '');
        return {
          id: String(turnNumber),
          label: answerChoiceLabel((index + 1) + '. ' + name, preview),
        };
      }),
    };
  }
  if (ring === null) return null;
  return {
    selectedId: ring.alternatives[ring.index].id,
    items: ring.alternatives.map(function (alternative, index) {
      const edit = answerOverride(answers, ring.turn);
      const name = alternative.kind === 'native'
        ? t('nativeAnswer')
        : (alternative.name || alternative.model || alternative.provider || t('answerNumber', { n: index + 1 }));
      const preview = alternative.kind === 'native'
        ? (edit !== null ? edit.text : choicePreview(turns, ring.turn, ''))
        : alternative.text;
      return {
        id: alternative.id,
        label: answerChoiceLabel((index + 1) + '. ' + name, preview),
      };
    }),
  };
}

function contextRingChoices(ring) {
  return {
    selectedId: ring.active,
    items: ring.items.map(function (item, index) {
      const model = item.model || item.provider || t('answerNumber', { n: index + 1 });
      return { id: item.id, label: answerChoiceLabel((index + 1) + '. ' + model, item.preview) };
    }),
  };
}

/**
 * The ring count is a menu, not a label: clicking `2/3` opens the answers of this
 * turn by name and jumps straight to the one picked. Two arrows alone cannot
 * answer "which one is the deepseek answer", and a long ring makes stepping a
 * chore. The arrows stay for quick flips.
 */
function RingMenuHost(props) {
  const primitives = clientPrimitives();
  const label = (props.index + 1) + '/' + props.count;
  const trigger = h('button', {
    type: 'button',
    className: 'mtt-ring-btn mtt-ring-num',
    disabled: props.disabled === true,
    title: props.title,
    onClick: props.onToggle,
  }, label);

  if (!primitives || props.choices === null) return trigger;

  return h(primitives.Menu, {
    open: props.open,
    anchor: trigger,
    items: props.choices.items,
    selectedId: props.choices.selectedId,
    selection: 'check',
    align: 'end',
    side: props.up ? 'top' : 'bottom',
    portal: true,
    onSelect: props.onPick,
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
 * Markdown is other people's code as far as this plugin is concerned: KaTeX,
 * the syntax highlighter and the transcript renderer all run inside it, over
 * text the reader typed. A throw in there must not take the panel with it — and
 * above all it must never leave a native bubble hidden with nothing painted over
 * it, which is how a question used to vanish from the transcript. So the failure
 * is caught here, the plain text is painted instead, and `onFail` lets the caller
 * uncover what it covered.
 */
class BodyBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch() {
    if (typeof this.props.onFail === 'function') this.props.onFail();
  }

  render() {
    if (this.state.failed) return h('div', { className: 'mtt-alt-text' }, this.props.text);
    return this.props.children;
  }
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
    return h(
      BodyBoundary,
      { text: props.text, onFail: props.onFail },
      h(Markdown, {
        text: props.text,
        labels: markdownLabels(),
        variant: 'body',
        ...props.streaming === true ? { streaming: true } : {},
      }),
    );
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
      await contextMutation(props.sessionId, props.turn, 'edit-answer', { text: text });
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
  // Answers produced by answering again are turns of their own. Keep only the
  // active member visible; its edits and translations still use this card.
  const hidden = hiddenOf(state, turn);
  const run = runsOf(state ? state.runs : null, turn, state ? state.hidden : null);
  const ring = answerRing(state ? state.answers : null, turn);
  const live = useLiveAnswer(sessionId, turn);
  const edit = useAnswerEdit(sessionId, turn);
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
  const translationSource = sourceOf(state, turn);
  // A deleted real answer stays deleted even if an old edit, stream or variant
  // remains cached. Regeneration uses another real turn, not this hidden one.
  const answerGone = hidden.answer;

  // A translation only hides the logged body (our paired view draws the original
  // itself); a variant hides the body and everything that answer produced.
  useHideRule(
    'tail:' + turn,
    turn,
    hidden.turn
      ? 'turn'
      : run !== null && run.active !== turn
        // An alternative answer that is not the one on screen leaves the flow
        // entirely: it is the same question answered again, so its rows (body,
        // process card, tool cards, action row) would otherwise read as a second
        // conversation. The question row itself stays — it is the one the reader
        // asked.
        ? 'deleted'
        : answerGone
          ? 'deleted'
        : showingVariant ? 'answer'
          : (translation !== null || liveTranslation !== null) && translationSource !== '' ? 'translate' : null,
  );

  // A prompt the plugin replayed to get a real answer out of the agent is in the
  // log, but it must not read as a second, identical question above the answer it
  // produced: the stylesheet takes that row out of the flow. It is a mark of its
  // own, so a turn can be prompt-hidden and answer-visible at the same time.
  const promptGone = hidden.prompt === true;
  useHideRule('prompt:' + turn, turn, promptGone ? 'prompt' : null);

  // Answering again makes the agent inject a fresh time and runtime context before
  // it says anything, and the app groups those into one row whose title reads
  // "已注入上下文". Nobody asked for that plumbing. It is only noise when the turn
  // holds nothing else, though: with tools or reasoning in it, that group is the
  // record of the work and stays.
  const replayed = promptGone ? turnInfo(state, turn) : undefined;
  const noise = replayed !== undefined
    && (replayed.tools === undefined || replayed.tools === 0)
    && replayed.reasoning !== true;
  useHideRule('noise:' + turn, turn, noise ? 'noise' : null);

  // An inactive member leaves the flow entirely. The active member follows the
  // normal editor, translation and failed-answer paths below.
  if (run !== null && run.active !== turn) return null;

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
    if (failedAnswer(state, turn)) {
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
    const source = translationSource;
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
            !pair.source ? null
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

/**
 * Whether the app drew its own action row under this turn.
 *
 * It only draws one for a turn that produced an answer, so a turn that failed —
 * or one the payload does not know yet, because it opened a moment ago — has
 * none, and the row this plugin draws is the only toolbar it will get. Looking at
 * the page answers that immediately; waiting for state would leave the answer
 * without a toolbar for as long as the refetch takes, or for good if the turn
 * never made it into the payload. `true` when the question cannot be answered.
 */
function nativeAnswerRow(turn) {
  if (typeof document === 'undefined' || typeof turn !== 'number') return true;
  let rows = null;
  try {
    rows = document.querySelectorAll('[data-chat-flow-kind="turn-tail"][data-chat-turn="' + turn + '"]');
  } catch (e) {
    return true;
  }
  if (rows === null || rows === undefined || rows.length === 0) return true;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row && typeof row.querySelector === 'function' && row.querySelector('[class*="_actions"]') !== null) return true;
  }
  return false;
}

/**
 * Whether this turn is an answer that never arrived, so the row has to come from
 * here. State first (it also covers a payload with no `turns` at all), then the
 * page: a turn the payload does not know is not a turn with an answer, and its
 * silence must not cost the reader the retry button.
 */
function failedAnswer(state, turn) {
  const info = turnInfo(state, turn);
  if (info !== undefined && info.answered === false) return true;
  if (info !== undefined && info.answered === true) return false;
  return nativeAnswerRow(turn) === false;
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
  const forget = railGoneTurns(state);
  const out = [];
  let changed = false;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item.turn !== 'number') { out.push(item); continue; }
    if (forget.indexOf(item.turn) !== -1) { changed = true; continue; }
    // The question keeps its original rail position while a replayed turn owns
    // the visible answer. Read that member before filtering its duplicate prompt.
    const runs = state && state.runs;
    let run = runsOf(runs, item.turn, state && state.hidden);
    const direct = runs && runs[String(item.turn)];
    if (run === null && direct && Array.isArray(direct.turns)) {
      run = runsOf(runs, direct.turns[0], state && state.hidden);
    }
    let answerTurn = run !== null ? run.active : item.turn;
    if (run === null && state && state.replays) {
      const members = [item.turn].concat(Object.keys(state.replays)
        .filter((member) => state.replays[member] === item.turn).map(Number))
        .filter((member) => !isGoneTurn(state.hidden, member)
          && (turnInfo(state, member) !== undefined || items.some((candidate) => candidate && candidate.turn === member)));
      if (members.length > 0) answerTurn = members.reduce((latest, member) => Math.max(latest, member));
    }
    let text = isGoneTurn(state && state.hidden, answerTurn) ? '' : railAnswerText(state, sessionId, answerTurn);
    if (text === null) {
      const info = turnInfo(state, answerTurn);
      if (info && typeof info.answerText === 'string') text = info.answerText;
      else if (answerTurn !== item.turn) {
        const activeItem = items.find((candidate) => candidate && candidate.turn === answerTurn);
        if (activeItem && typeof activeItem.response === 'string') text = activeItem.response;
      }
    }
    const override = promptOverride(state, item.turn);
    const prompt = override !== null ? railPreview(override.text) : item.prompt;
    const response = text === null ? item.response : railPreview(text);
    if (prompt === item.prompt && response === item.response) { out.push(item); continue; }
    changed = true;
    out.push(Object.assign({}, item, { prompt: prompt, response: response }));
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
 * Whether a question row is a replay that must not be drawn.
 *
 * `answer-run` asks the agent the same question again, which the log records as a
 * second `user/message`; the host marks that turn `prompt` so the row stays out of
 * the transcript. Two sources answer here: the host's mark (only once the log has
 * that turn — a mark for a run that never opened its turn must not hide an
 * unrelated question) and the guess this client makes before it sends the request.
 */
function promptIsReplayed(sessionId, turn) {
  if (store.isPendingPrompt(sessionId, turn)) return true;
  const cached = store.get(sessionId);
  const state = cached && cached.state;
  if (!state) return false;
  const hidden = hiddenOf(state, turn);
  return hidden.prompt === true && turnInfo(state, turn) !== undefined;
}

/**
 * Notices that name no turn.
 *
 * "Context injected", "asked to keep going" and friends are logged as messages of
 * their own, and the frame writes `data-chat-turn` on a row only when that node's
 * location resolved to a turn. A notice sitting between turns resolves to
 * nothing, so the generated stylesheet cannot reach it and deleting the answer
 * leaves it standing on its own.
 *
 * Which turn a notice belongs to is read from where it sits:
 *
 * - `turn-trigger` opens the turn below it ("asked to keep going" is a request to
 *   answer *this* turn), so it follows the next row that names a turn;
 * - everything else trails the turn it was injected into, so it follows the
 *   previous one, and only falls back to the next when it comes first.
 */
const NOTICE_KINDS = ['context', 'turn-trigger', 'command', 'compaction', 'manual-compaction'];
const OPENS_NEXT_TURN = ['turn-trigger'];
const strayNotices = new Set();

function noticeBelongsToGoneAnswer(state, turn) {
  if (!state || turn === null) return false;
  const hidden = hiddenOf(state, turn);
  return hidden.turn === true || hidden.answer === true;
}

function turnAt(rows, from, step) {
  for (let at = from; at >= 0 && at < rows.length; at += step) {
    const other = rows[at];
    const raw = other && typeof other.getAttribute === 'function' ? other.getAttribute('data-chat-turn') : null;
    if (raw === null || raw === '') continue;
    const value = Number(raw);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function syncStrayNotices(sessionId) {
  if (typeof document === 'undefined' || document === null) return;
  const target = sessionId !== null && sessionId !== undefined && sessionId !== ''
    ? sessionId
    : store.lastSession;
  if (target === null || target === undefined) return;
  const cached = store.get(target);
  const state = cached && cached.state ? cached.state : null;
  const rows = document.querySelectorAll('[data-chat-flow-kind]');
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row || typeof row.getAttribute !== 'function') continue;
    if (row.getAttribute('data-chat-turn') !== null) continue;
    const kind = row.getAttribute('data-chat-flow-kind');
    if (NOTICE_KINDS.indexOf(kind) === -1) continue;
    const opens = OPENS_NEXT_TURN.indexOf(kind) !== -1;
    const before = turnAt(rows, index - 1, -1);
    const after = turnAt(rows, index + 1, 1);
    const turn = opens ? after : (before !== null ? before : after);
    if (noticeBelongsToGoneAnswer(state, turn)) {
      if (row.style && row.style.display !== 'none') row.style.display = 'none';
      strayNotices.add(row);
    } else if (strayNotices.has(row)) {
      strayNotices.delete(row);
      if (row.style) row.style.display = '';
    }
  }
  strayNotices.forEach(function (row) {
    if (row.isConnected === false) strayNotices.delete(row);
  });
  if (rowDumpWanted) sendRowDump(target, rows);
}

/**
 * Turns the rail must not list: a row the reader deleted, and the extra copy of
 * a question that `answer-run` asked again (that turn is real, so the rail would
 * otherwise show the same question twice).
 */
function railGoneTurns(state) {
  const hidden = state && state.hidden ? state.hidden : null;
  if (hidden === null) return [];
  const turns = Array.isArray(hidden.turns) ? hidden.turns : [];
  const prompts = Array.isArray(hidden.prompts) ? hidden.prompts : [];
  if (prompts.length === 0) return turns;
  return turns.length === 0 ? prompts : turns.concat(prompts);
}

/**
 * Which session a projection store belongs to. The store is a per-session
 * instance handed to the Session object as `projections`, so the only place the
 * two are correlated is here.
 */
const outlineSessions = new WeakMap();

/** Faces already handed out, one per store, so identity stays stable. */
const outlineFaces = new WeakMap();

/**
 * One filtered face over the real `turnOutline` face.
 *
 * The rail merges two folds of the log: the loaded navigation items and the
 * host's `turnOutline` projection (every turn, loaded or not). Removing a turn
 * from the first is not enough — the projection keeps listing it, and the merged
 * list is what the marks are drawn from. The projection cannot be written to
 * (registrants sharing a key share one unit, so a second writer fights the
 * host's own frames), but it can be *read* through a filter.
 *
 * Identity matters: `useProjection` binds this face with
 * `useSyncExternalStore`, so the filtered value keeps its reference until either
 * the host publishes a new value or the plugin state changes. The face also
 * subscribes to our store, so edits and deletions repaint the rail without
 * waiting for the next host frame.
 * @param sessionId - the session this store belongs to, so the filter can ask.
 * @param inner - the store's own `turnOutline` face.
 * @returns a face that answers without the forgotten turns.
 */
function outlineFace(sessionId, inner) {
  const box = { raw: undefined, value: undefined, version: -1 };
  box.face = {
    getSnapshot: function () {
      const raw = inner.getSnapshot();
      if (raw === box.raw && box.version === store.railVersion) return box.value;
      box.raw = raw;
      box.version = store.railVersion;
      const cached = store.get(sessionId);
      const state = cached && cached.state;
      box.value = state && Array.isArray(raw) ? patchRailItems(raw, state, sessionId) : raw;
      return box.value;
    },
    subscribe: function (listener) {
      const offHost = inner.subscribe(listener);
      const offOurs = store.subscribe(listener);
      return function () { offHost(); offOurs(); };
    },
  };
  return box.face;
}

/**
 * Install the `turnOutline` filter on the projection store itself.
 *
 * The app reads the host's projection through `binding(sessionId).session
 * .projections` — a per-session store instance the manager keeps and the client
 * never looks up again — so the filter goes on that class's prototype, found from
 * the first store we see, and every binding is watched to learn which session a
 * store belongs to. `binding` is the one door the chat view and this plugin both
 * walk through, which is what keeps the correlation complete.
 * @param ctx - the plugin's client context.
 * @returns the disposer that restores the untouched prototype and method.
 */
function installOutlineFilter(ctx) {
  const service = (typeof ctx.get === 'function' ? ctx.get('sessions') : null) || sessionsService;
  if (!service || typeof service.binding !== 'function') return undefined;
  const original = service.binding;
  let proto = null;
  let previous = null;
  /** Remember the store a binding exposes, and patch the class once. */
  const learn = function (bound, sessionId) {
    const session = bound && bound.session;
    const projections = session && session.projections;
    if (!projections || typeof projections !== 'object') return;
    if (typeof sessionId === 'string') outlineSessions.set(projections, sessionId);
    if (proto !== null) return;
    const found = Object.getPrototypeOf(projections);
    if (!found || typeof found.faceOf !== 'function') return;
    previous = found.faceOf;
    found.faceOf = function (key) {
      const inner = previous.call(this, key);
      if (key !== 'turnOutline') return inner;
      const cached = outlineFaces.get(this);
      if (cached !== undefined && cached.inner === inner) return cached.face;
      const face = outlineFace(outlineSessions.get(this), inner);
      outlineFaces.set(this, { inner: inner, face: face });
      return face;
    };
    proto = found;
  };
  const wrapped = function (sessionId) {
    const bound = original.call(service, sessionId);
    try { learn(bound, sessionId); } catch (error) {}
    return bound;
  };
  try {
    service.binding = wrapped;
  } catch (error) {
    return undefined;
  }
  // A store may already exist for a session the app has open before we install.
  try {
    if (typeof service.list.getSnapshot === 'function') {
      const byId = service.list.getSnapshot().byId || {};
      for (const id of Object.keys(byId)) learn(original.call(service, id), id);
    }
  } catch (error) {}
  return function () {
    try {
      if (Object.prototype.hasOwnProperty.call(service, 'binding')) delete service.binding;
      else service.binding = original;
    } catch (error) {}
    if (proto !== null && previous !== null) proto.faceOf = previous;
  };
}

/** A chat snapshot whose navigation items follow the transcript. */
function railSnapshot(snapshot, sessionId) {
  const cached = store.get(sessionId);
  const state = cached && cached.state;
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
      // The host rebuilds its snapshot object on every publish, but the item
      // array is the app's own change signal (`TurnNavigationIndex` doc), so it
      // is the safe thing to validate the memo against: a snapshot that comes
      // back with a different list must not answer with the old patch.
      const items = snapshot.navigation && typeof snapshot.navigation.items === 'function'
        ? snapshot.navigation.items()
        : null;
      const hit = railMemo.get(snapshot);
      if (hit !== undefined && hit.version === version && hit.items === items) return hit.value;
      const value = railSnapshot(snapshot, sessionId);
      railMemo.set(snapshot, { version: version, items: items, value: value });
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
    // The chat view tells us which session it draws: the row decorator needs it,
    // because a flow row carries a turn number but no session id.
    if (typeof source === 'string') activeSessionId = source;
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

/* ----------------------------------------------------------- user rows -- */

/**
 * A question is drawn by the app as plain text. Everything that reads like a
 * formula, a fence, a list or a table is handed to the markdown renderer
 * instead — but only then, so an ordinary question stays exactly as the app
 * draws it, attachments and all.
 */
function markdownish(text) {
  if (typeof text !== 'string' || text === '') return false;
  return /\$[^\n$]+\$|\\(|\\)|\[|\\\[|\]|\\.|\*\*|__|`|```|~~~|^\s{0,3}#{1,6}\s|^\s{0,3}[-*+]\s|^\s{0,3}\d+[.)]\s|^\s{0,3}>\s|^\s{0,3}\|.*\|/m.test(text) || /\n\s*\n/.test(text);
}

/**
 * Whether the text carries an `@` reference, which the app draws as a chip.
 *
 * A path like `@C:\Users\…\crash.ips` contains dots, so `markdownish` calls it
 * markdown on that alone; covering the bubble for it would trade the app's chip
 * for a run of plain characters.
 */
function mentionish(text) {
  if (typeof text !== 'string' || text === '') return false;
  return /(^|[\s(（【])@[^\s@]/.test(text);
}

/** The session the chat view is bound to, as told by `conversation.binding`. */
let activeSessionId = null;

/* ---------------------------------------------------------- attachments -- */
//
// The rail above the field and the cards above the bubble are the app's own
// look: 64px thumbnails, 240×64 file cards with a 28px category glyph, the
// suffix and the size on the meta line. The app draws them with components that
// no slot hands out, so the geometry is copied from its stylesheet and the
// glyph, the suffix and the size text come from the primitives package at
// runtime — same helper, same `4.2KB`.

/** Resolved picture URLs, keyed by session and attachment. */
const imageUrls = new Map();

function imageKey(sessionId, attachment) {
  const id = attachment && typeof attachment.attachmentId === 'string' ? attachment.attachmentId : '';
  return String(sessionId) + '|' + id;
}

/**
 * Ask the app for one stored picture's URL, once. `null` in the map means the
 * question is out — either it is still being answered or it will never be.
 */
function primeImage(sessionId, attachment) {
  if (attachment === null || typeof sessionId !== 'string') return;
  const key = imageKey(sessionId, attachment);
  if (imageUrls.has(key)) return;
  imageUrls.set(key, null);
  const service = conversationService;
  if (service === null || typeof service.imageUrl !== 'function') return;
  try {
    const pending = service.imageUrl(sessionId, attachment);
    if (pending !== null && typeof pending.then === 'function') {
      pending.then(function (url) {
        imageUrls.set(key, typeof url === 'string' && url !== '' ? url : null);
        store.notify();
      }, function () {});
      return;
    }
    if (typeof pending === 'string' && pending !== '') imageUrls.set(key, pending);
  } catch (e) {}
}

/**
 * The picture of one attachment: the local blob while it is being uploaded (a
 * `preview` object URL made at drop time), the stored one after a reload.
 */
function useImageSrc(sessionId, block) {
  const [, force] = React.useReducer(function (x) { return x + 1; }, 0);
  React.useEffect(function () { return store.subscribe(force); }, []);
  const local = block && typeof block.preview === 'string' ? block.preview : null;
  const attachment = block && block.attachment ? block.attachment : null;
  const key = attachment === null ? '' : imageKey(sessionId, attachment);
  React.useEffect(function () {
    if (local !== null || attachment === null) return;
    primeImage(sessionId, attachment);
  }, [local, key]);
  if (local !== null) return local;
  if (attachment === null) return null;
  return imageUrls.get(key) || null;
}

/** The attachments the reader added to one question, from the plugin state. */
function promptFilesOf(state, turn) {
  const prompts = state ? state.prompts : null;
  if (!prompts || typeof turn !== 'number') return [];
  const entry = prompts[String(turn)];
  return entry && Array.isArray(entry.files) ? entry.files : [];
}

/** Only the identity of each attachment travels: a preview blob is a local handle. */
function attachmentBlocks(list) {
  const items = Array.isArray(list) ? list : [];
  return items.map(function (block) {
    return { type: block.type, attachment: block.attachment };
  });
}

/** A stable fingerprint of one attachment list, for "did the rail change?". */
function attachmentIds(list) {
  const items = Array.isArray(list) ? list : [];
  return items.map(function (block) {
    const ref = block && block.attachment ? block.attachment : null;
    const id = ref !== null && typeof ref.attachmentId === 'string' ? ref.attachmentId : '';
    return String(block && block.type) + ':' + id;
  }).join('|');
}

/** A 64px picture: the thumbnail in the composer rail and in the bubble row. */
function ImageTile(props) {
  const src = useImageSrc(props.sessionId, props.block);
  return h('div', { className: 'mtt-tile' },
    src === null ? h('span', { className: 'mtt-tile-blank' }) : h('img', {
      className: 'mtt-tile-img',
      src: src,
      alt: attachmentName(props.block),
      draggable: false,
    }),
    props.onRemove === undefined ? null : h('button', {
      className: 'mtt-tile-remove',
      type: 'button',
      title: props.removeLabel,
      onClick: function (event) {
        event.preventDefault();
        event.stopPropagation();
        props.onRemove();
      },
    }, h(CloseIcon)));
}

/** A 240×64 file card: glyph, name, `PDF 4.2KB`. */
function AttachFileCard(props) {
  return h('div', { className: 'mtt-file', title: attachmentName(props.block) },
    fileGlyph(props.block),
    h('div', { className: 'mtt-file-body' },
      h('div', { className: 'mtt-file-name' }, attachmentName(props.block)),
      h('div', { className: 'mtt-file-meta' }, fileMetaText(props.block))),
    props.onRemove === undefined ? null : h('button', {
      className: 'mtt-file-remove',
      type: 'button',
      title: props.removeLabel,
      onClick: function (event) {
        event.preventDefault();
        event.stopPropagation();
        props.onRemove();
      },
    }, h(CloseIcon)));
}

/** One list of attachments, drawn with whichever card fits each of them. */
function AttachList(props) {
  const items = Array.isArray(props.items) ? props.items : [];
  if (items.length === 0) return null;
  const remove = props.onRemove;
  return items.map(function (block, index) {
    const onRemove = typeof remove === 'function'
      ? function () { remove(index); }
      : undefined;
    return block !== null && block.type === 'image'
      ? h(ImageTile, {
        key: 'i' + index,
        sessionId: props.sessionId,
        block: block,
        onRemove: onRemove,
        removeLabel: props.removeLabel,
      })
      : h(AttachFileCard, {
        key: 'f' + index,
        block: block,
        onRemove: onRemove,
        removeLabel: props.removeLabel,
      });
  });
}

/**
 * The attachments of a question, above its bubble — the same place and the same
 * cards the app uses for a question that carried them when it was first sent.
 * Drawn from the plugin state because a question the reader only edited has no
 * log entry of its own to read them back from.
 */
function QuestionAttachments(props) {
  const entry = useToolbar(props.sessionId);
  const state = entry && entry.state ? entry.state : null;
  const files = promptFilesOf(state, props.turn);
  if (files.length === 0) return null;
  return h('div', { className: 'mtt-attach-row' }, h(AttachList, {
    sessionId: props.sessionId,
    items: files,
  }));
}

/** The question rows of the transcript, in the DOM the app draws them in. */
const USER_ROW_SELECTOR = '[data-chat-flow-kind="user"]';




/**
 * The app already draws a question — bubble, attachment cards, reference chips,
 * image gallery. All that is missing is a toolbar, so instead of replacing that
 * renderer this decorator walks the flow and mounts one small React root per row
 * into the row itself, plus a slot inside the row's stack where an overlay (the
 * editor, or the markdown copy of a question the app can only draw as text) can
 * stand in front of the bubble.
 */
function installUserRows() {
  const dom = clientReactDom();
  const client = clientReactDomClient();
  const createRoot = client === null || typeof client.createRoot !== 'function'
    ? (dom !== null && typeof dom.createRoot === 'function' ? dom.createRoot : null)
    : client.createRoot;
  if (createRoot === null) return undefined;
  if (typeof document === 'undefined' || document === null) return undefined;

  const mounted = new Map();
  let frame = 0;

  function drop(row) {
    const entry = mounted.get(row);
    if (entry === undefined) return;
    mounted.delete(row);
    try { entry.root.unmount(); } catch (e) {}
    try { if (entry.attsRoot) entry.attsRoot.unmount(); } catch (e) {}
    entry.bar.remove();
    entry.slot.remove();
    if (entry.atts) entry.atts.remove();
    row.removeAttribute('data-mtt-row');
  }

  function decorate(row) {
    const raw = row.getAttribute('data-chat-turn');
    const turn = raw === null ? NaN : Number(raw);
    if (!Number.isFinite(turn)) return;
    const sessionId = activeSessionId;
    const existing = mounted.get(row);
    if (existing !== undefined) {
      if (existing.turn === turn && existing.sessionId === sessionId) return;
      drop(row);
    }
    const stack = row.querySelector('[class*="_userStack"]');
    if (stack === null) return;
    const bubble = row.querySelector('[class*="_bubble"]');
    const bar = document.createElement('div');
    bar.className = 'mtt-user-bar';
    const slot = document.createElement('div');
    slot.className = 'mtt-user-slot';
    stack.appendChild(slot);
    row.appendChild(bar);
    row.setAttribute('data-mtt-row', '1');
    // A replayed question is hidden here, not in the row's effect: the observer
    // callback runs before the frame is drawn, an effect runs after it, and that
    // one drawn frame is exactly the flash this is here to remove.
    if (promptIsReplayed(sessionId, turn)) row.style.display = 'none';
    // The attachments of this question go above its bubble, in the app's own
    // order: cards first, then the bubble. `display:contents` keeps this wrapper
    // out of the stack's flex layout, so its row lands where the app's own
    // attachment row lands.
    const atts = document.createElement('div');
    atts.className = 'mtt-user-atts';
    stack.insertBefore(atts, stack.firstChild);
    const root = createRoot(bar);
    const attsRoot = createRoot(atts);
    mounted.set(row, {
      root: root,
      bar: bar,
      slot: slot,
      atts: atts,
      attsRoot: attsRoot,
      turn: turn,
      sessionId: sessionId,
    });
    attsRoot.render(h(QuestionAttachments, { sessionId: sessionId, turn: turn }));
    root.render(h(UserRow, { sessionId: sessionId, turn: turn, slot: slot, bubble: bubble, row: row }));
  }

  function scan() {
    frame = 0;
    if (typeof document === 'undefined' || document === null) return;
    mounted.forEach(function (entry, row) {
      if (row.isConnected !== true) drop(row);
    });
    const rows = document.querySelectorAll(USER_ROW_SELECTOR);
    for (let index = 0; index < rows.length; index += 1) decorate(rows[index]);
    // Rows the stylesheet cannot name still have to leave with the answer they
    // belong to; this is the pass that reads the frame's own ordering for that.
    syncStrayNotices(activeSessionId);
  }

  function schedule() {
    if (frame !== 0) return;
    frame = 1;
    // A timer, not requestAnimationFrame: a window that is not in front (a
    // background tab, a headless check) throttles animation frames to never.
    // The flag is cleared whatever happens, or one bad pass stops every later
    // one.
    setTimeout(function () {
      frame = 0;
      run('observe');
    }, 0);
  }

  let lastRowError = null;
  // One bad pass must not stop the later ones, and must not surface as an
  // unhandled error on a timer.
  const run = function () {
    try {
      scan();
    } catch (error) {
      lastRowError = error;
    }
  };
  let observer = null;
  if (typeof MutationObserver === 'function') {
    // Decorate inside the callback, not on a timer: an observer callback runs
    // before the frame is painted, a timer runs after it, and a replayed question
    // that is decorated one frame late is a question the reader sees twice.
    let scanning = false;
    observer = new MutationObserver(function () {
      if (scanning) return;
      scanning = true;
      try {
        scan();
      } catch (error) {
        lastRowError = error;
      } finally {
        scanning = false;
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
  run('install');
  setTimeout(function () { run('tick0'); }, 0);
  setTimeout(function () { run('tick300'); }, 300);

  // Deleting an answer changes which rows must go, but it mutates no row — the
  // app never re-renders a notice it considers unchanged — so no observer
  // callback would fire and the sweep below would wait for the next scroll. The
  // store is the other half of the signal.
  let sweeping = false;
  const unsubscribe = store.subscribe(function () {
    if (sweeping) return;
    sweeping = true;
    try {
      run('state');
    } catch (error) {
      lastRowError = error;
    } finally {
      sweeping = false;
    }
  });

  return function () {
    unsubscribe();
    observer.disconnect();
    const rows = Array.from(mounted.keys());
    rows.forEach(drop);
  };
}

/* --------------------------------------------------------------- components -- */

/**
 * The user bubble. Replaces the native renderer when no other plugin shadows
 * it (registered with priority -1; a collision degrades to "they win").
 */
function UserRow(props) {
  const sessionId = props.sessionId;
  const turn = props.turn;
  const slot = props.slot;
  const bubble = props.bubble;
  const dom = clientReactDom();

  const prefs = usePrefs();
  const list = useSessionList();
  const summary = sessionId !== undefined ? list.byId[sessionId] : undefined;
  const running = !!(summary && summary.running);
  const toolbar = useToolbar(sessionId);
  const state = toolbar && toolbar.state ? toolbar.state : null;
  const versions = state ? state.versions : null;
  const ring = typeof turn === 'number' ? ringFor(versions, sessionId, turn) : null;
  const self = versions && versions.find(function (v) { return v.sessionId === sessionId; });
  const isVersion = !!(self && self.parentSessionId);
  // The question as it was asked, unless the reader rewrote it.
  const info = turnInfo(state, turn);
  const logged = info !== undefined && typeof info.text === 'string' ? info.text : '';
  const override = promptOverride(state, turn);
  const shownText = override !== null ? override.text : logged;
  // A prompt the plugin replayed to get a real answer out of the agent is in the
  // log, but it must not read as a second, identical question. The row is hidden
  // here rather than by AnswerCard: a turn that failed or is still running has no
  // tail row yet, so a tail-owned rule would never be written for it.
  const hidden = hiddenOf(state, turn);
  // A mark written for a replayed prompt names a turn the agent was about to
  // open. If that turn never opened — the run failed before it started — the mark
  // is stale, and hiding by it would delete the reader's question from a
  // transcript that has every right to show it. So the mark only counts when the
  // log actually has that turn.
  const promptGone = promptIsReplayed(sessionId, turn);
  const promptRow = props.row;
  React.useEffect(function () {
    if (!promptRow) return undefined;
    promptRow.style.display = promptGone ? 'none' : '';
    return function () { promptRow.style.display = ''; };
  }, [promptRow, promptGone]);
  // Set when the markdown body threw: the native bubble comes back rather than
  // staying hidden under an overlay that cannot paint. Declared here because
  // `wantsMarkdown` is computed from it — reading a hook result before its own
  // declaration is a TDZ error, and an error in this component takes the whole
  // row's toolbar down with it.
  const [bodyFailed, setBodyFailed] = React.useState(false);
  React.useEffect(function () { setBodyFailed(false); }, [shownText]);

  // When the app's own bubble is covered by a markdown copy of the text.
  //
  // Only when this plugin has something of its own to draw: a question the reader
  // rewrote, or text that is markdown. Never when the text carries an `@`
  // reference — `@C:\…\report.ips` is turned into a highlighted chip by the app's
  // own user-text rules, and a markdown copy of the same characters is plain text.
  // A markdown copy also costs the attachment cards and every other affordance the
  // app draws inside that bubble, so it earns its place only where it adds
  // something.
  const wantsMarkdown = !bodyFailed
    && (override !== null || (markdownish(logged) && !mentionish(logged)));

  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  // Files dropped into the editor, as content blocks of the very same shape a
  // native prompt carries: the replay hands them to the agent unchanged.
  const [files, setFiles] = React.useState([]);
  const [uploading, setUploading] = React.useState(0);
  // Read synchronously in keyboard/send handlers too: React may not have
  // committed the render that disables the button when a drop just started.
  const uploads = React.useRef({ generation: 0, pending: 0, error: null, failures: new Map() });
  const [dragging, setDragging] = React.useState(false);
  const fileInput = React.useRef(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [copied, setCopied] = React.useState(false);
  const copyAttempt = React.useRef(0);
  React.useEffect(function () {
    copyAttempt.current++;
    setCopied(false);
  }, [sessionId, turn, shownText]);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmHide, setConfirmHide] = React.useState(false);
  const [popUp, setPopUp] = React.useState(false);
  const hideAnchor = React.useRef(null);
  const cardAnchor = React.useRef(null);
  const [revert, setRevert] = React.useState(null);
  const revertAnchor = React.useRef(null);
  const [toastNode, showToast] = useToast();

  useDismiss(confirmDelete || confirmHide || revert !== null, function () {
    setConfirmDelete(false);
    setConfirmHide(false);
    setRevert(null);
  });

  const canEdit = !running && sessionId !== undefined && typeof turn === 'number' && shownText !== '' && !editing;

  function beginEdit() {
    uploads.current = { generation: uploads.current.generation + 1, pending: 0, error: null, failures: new Map() };
    setUploading(0);
    setDraft(shownText);
    setError(null);
    // The rail opens with what this question already carries, so a second edit
    // adds to that list instead of replacing it.
    const stored = state && state.prompts && state.prompts[String(turn)];
    const native = state && state.promptAttachments && state.promptAttachments[String(turn)];
    setFiles((stored && Array.isArray(stored.files) ? stored.files : (native || [])).slice());
    setDragging(false);
    setEditing(true);
  }

  function pickFiles() {
    const node = fileInput.current;
    if (node !== null && node !== undefined && typeof node.click === 'function') node.click();
  }

  async function addFiles(list) {
    if (typeof sessionId !== 'string') return;
    const items = list === null || list === undefined ? [] : Array.from(list);
    const picked = items.filter(function (file) { return file !== null && typeof file === 'object'; });
    if (picked.length === 0) return;
    setError(null);
    const batch = uploads.current;
    batch.pending += picked.length;
    setUploading(batch.pending);
    for (const file of picked) {
      const fileKey = JSON.stringify([file.name, file.size, file.type, file.lastModified]);
      try {
        const block = await uploadAttachment(sessionId, file);
        if (uploads.current !== batch) continue;
        batch.failures.delete(fileKey);
        // A picture shows as a picture from the moment it is dropped: the local
        // blob is the thumbnail until the stored one can be asked for.
        const preview = block.type === 'image'
          && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
          ? URL.createObjectURL(file)
          : null;
        const entry = preview === null ? block : { ...block, preview };
        setFiles(function (current) { return current.concat([entry]); });
      } catch (e) {
        batch.failures.set(fileKey, e);
      } finally {
        batch.pending -= 1;
        batch.error = batch.failures.size > 0 ? batch.failures.values().next().value : null;
        if (uploads.current === batch) setUploading(batch.pending);
      }
    }
    if (batch.error !== null && uploads.current === batch) setError(String((batch.error && batch.error.message) || batch.error));
  }

  function removeFile(index) {
    setFiles(function (current) { return current.filter(function (_, at) { return at !== index; }); });
  }

  function onDragOver(event) {
    if (!event.dataTransfer) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
    if (!dragging) setDragging(true);
  }

  function onDragLeave(event) {
    // Moving onto a child of the box is not leaving it.
    const inside = event.currentTarget && event.currentTarget.contains
      ? event.relatedTarget !== null && event.relatedTarget !== undefined && event.currentTarget.contains(event.relatedTarget)
      : false;
    if (inside) return;
    setDragging(false);
  }

  function onDrop(event) {
    event.preventDefault();
    event.stopPropagation();
    setDragging(false);
    const transfer = event.dataTransfer;
    if (transfer && transfer.files && transfer.files.length > 0) addFiles(transfer.files);
  }

  // Ctrl+V is a third door into the same list, next to the picker and the drop
  // target: a screenshot on the clipboard arrives as a file, not as text, and
  // there is no reason to make the reader save it to disk first. Text pastes are
  // left alone — the field keeps its own editing behaviour, including undo.
  function pastedFiles(event) {
    const clip = event && event.clipboardData;
    if (!clip) return [];
    const found = [];
    const items = clip.items;
    if (items !== null && items !== undefined && items.length > 0) {
      for (const item of Array.from(items)) {
        if (item === null || typeof item !== 'object' || item.kind !== 'file') continue;
        const file = typeof item.getAsFile === 'function' ? item.getAsFile() : null;
        if (file !== null && file !== undefined) found.push(file);
      }
    }
    // Some platforms only fill the files list; only consulted when the item list
    // gave nothing, so a paste never adds the same picture twice.
    if (found.length === 0 && clip.files !== null && clip.files !== undefined && clip.files.length > 0) {
      for (const file of Array.from(clip.files)) found.push(file);
    }
    return found;
  }

  function onPaste(event) {
    const found = pastedFiles(event);
    if (found.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    addFiles(found);
  }

  // Saving a question rewrites nothing but the row's own text: the answer that
  // is already there stays, the conversation does not move, no model is called.
  function canSubmitPrompt() {
    if (typeof turn !== 'number' || busy || (draft.trim() === '' && files.length === 0)) return false;
    const pending = uploads.current;
    if (pending.pending > 0) { setError(t('waitForUploads')); return false; }
    if (pending.error !== null) {
      setError(t('uploadFailed', { error: failureText(pending.error) }));
      return false;
    }
    return true;
  }

  async function submit() {
    if (!canSubmitPrompt()) return;
    setBusy(true);
    setError(null);
    try {
      const stored = state && state.prompts && state.prompts[String(turn)];
      const native = state && state.promptAttachments && state.promptAttachments[String(turn)];
      const original = stored && Array.isArray(stored.files) ? stored.files : (native || []);
      if (draft !== shownText || attachmentIds(files) !== attachmentIds(original)) {
        await contextMutation(sessionId, turn, 'edit-prompt', { text: draft, files: attachmentBlocks(files) });
        showToast(t('promptEdited'));
      }
      setEditing(false);
    } catch (error) { setError(failureText(error)); }
    finally { setBusy(false); }
  }

  async function send() {
    if (!canSubmitPrompt()) return;
    await retry({ text: draft, files: attachmentBlocks(files) });
  }

  async function retry(options) {
    if (typeof turn !== 'number' || busy) return;
    setBusy(true);
    setError(null);
    const edit = options && typeof options.text === 'string' ? { text: options.text, files: options.files } : {};
    try {
      const plan = await turnChangePlan(sessionId, turn);
      if (plan !== null) { setRevert(Object.assign({ plan: plan, model: null }, edit)); return; }
      await rerunTurnInPlace(Object.assign({ sessionId: sessionId, turn: turn, stopPrevious: prefs.stopPrevious }, edit));
      setEditing(false);
      showToast(t('answerRegenerated'));
    } catch (error) {
      if (typeof edit.text === 'string') setError(failureText(error));
      else showToast(failureText(error), 'error');
    } finally { setBusy(false); }
  }

  async function confirmRevert() {
    const pending = revert;
    if (pending === null || typeof turn !== 'number') return;
    setRevert(null);
    setBusy(true);
    try {
      const result = await rerunAfterRevert({
        sessionId: sessionId,
        turn: turn,
        model: pending.model,
        stopPrevious: prefs.stopPrevious,
        text: pending.text,
        files: pending.files,
      });
      setEditing(false);
      showToast(t('revertedToast', { count: String(result.revertedCount) }));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  async function copy() {
    const attempt = ++copyAttempt.current;
    setCopied(false);
    try {
      await writeClipboard(shownText);
      if (copyAttempt.current !== attempt) return;
      setCopied(true);
      setTimeout(function () { if (copyAttempt.current === attempt) setCopied(false); }, 1200);
    } catch (e) {
      if (copyAttempt.current === attempt) showToast(failureText(e), 'error');
    }
  }

  async function removeVersion() {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await changeContext({ action: 'delete-version', sessionId: sessionId });
      showToast(t('deletedCard'));
    } catch (error) { showToast(failureText(error), 'error'); }
    finally { setBusy(false); }
  }

  // "Delete this message" removes the turn from the transcript view only: the
  // log is append-only, so the row is hidden here.
  async function hideTurn() {
    setConfirmHide(false);
    if (typeof turn !== 'number') return;
    setBusy(true);
    setError(null);
    try {
      await contextMutation(sessionId, turn, 'delete-question');
      showToast(t('turnHidden'));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  // The overlay stands where the bubble stands: the editor, or the markdown copy
  // of a question the app can only draw as text. While it shows, the app's own
  // bubble is hidden — the attachment cards above it are never touched.
  // The editor is the answer editor with one extra button: `send` writes the new
  // question and then answers it again, so a corrected prompt never needs a
  // second trip to the toolbar.
  const overlay = editing
    ? h('div', {
      className: 'mtt-answer-edit mtt-answer-edit-prompt' + (dragging ? ' mtt-dropping' : ''),
      onDragOver: onDragOver,
      onDragEnter: onDragOver,
      onDragLeave: onDragLeave,
      onDrop: onDrop,
      // On the box rather than the field so a paste works wherever the caret's
      // focus sits inside it.
      onPaste: onPaste,
    },
    h('div', { className: 'mtt-answer-edit-head' },
      h('span', { className: 'mtt-answer-edit-label' }, t('editing')),
      h('span', { className: 'mtt-answer-edit-tools' },
        h('input', {
          key: 'picker',
          type: 'file',
          multiple: true,
          className: 'mtt-file-input',
          ref: fileInput,
          onChange: function (e) {
            addFiles(e.target.files);
            e.target.value = '';
          },
        }),
        h('button', {
          key: 'attach', type: 'button', className: 'mtt-act', title: t('attach'),
          onClick: pickFiles,
        }, h(ClipIcon)),
        h('button', {
          key: 'close', type: 'button', className: 'mtt-act', title: t('exitEdit'),
          onClick: function () { setEditing(false); },
        }, h(CloseIcon)),
        h('button', {
          key: 'save', type: 'button', className: 'mtt-btn mtt-btn-small',
          disabled: busy || uploading > 0 || (draft.trim() === '' && files.length === 0),
          onClick: submit,
        }, t('save')),
        h('button', {
          key: 'send', type: 'button', className: 'mtt-btn mtt-btn-small mtt-btn-primary',
          disabled: busy || uploading > 0 || (draft.trim() === '' && files.length === 0),
          onClick: send,
        }, t('send')))),
    // The rail sits above the field, as it does in the composer: pictures as
    // 64px thumbnails, files as the app's own 240×64 cards.
    files.length === 0 && uploading === 0
      ? null
      : h('div', { className: 'mtt-rail' },
        h(AttachList, {
          sessionId: sessionId,
          items: files,
          onRemove: removeFile,
          removeLabel: t('attachRemove'),
        }),
        uploading > 0 ? h('div', { className: 'mtt-file mtt-file-busy' },
          h('span', { className: 'mtt-file-spin' }),
          h('div', { className: 'mtt-file-body' },
            h('div', { className: 'mtt-file-name' }, t('attaching')))) : null),
    h('textarea', {
      className: 'mtt-answer-edit-input',
      value: draft,
      autoFocus: true,
      spellCheck: false,
      placeholder: t('editSendHint'),
      onChange: function (e) { setDraft(e.target.value); },
      onKeyDown: function (e) {
        if (e.key === 'Escape') { e.preventDefault(); setEditing(false); }
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); }
      },
    }),
    files.length === 0 && uploading === 0 && !dragging
      ? h('div', { className: 'mtt-attach-hint' }, t('attachHint'))
      : null,
    h(ErrorChip, { error: error }))
    : wantsMarkdown && shownText !== ''
      ? h(
          'div',
          { className: 'mtt-bubble mtt-bubble-md', 'data-mtt-overlay': '1' },
          h(AnswerBody, { text: shownText, onFail: function () { setBodyFailed(true); } }),
        )
      : null;

  const covered = overlay !== null;
  React.useEffect(function () {
    if (bubble === null || bubble === undefined) return undefined;
    bubble.style.display = covered ? 'none' : '';
    return function () { bubble.style.display = ''; };
  }, [bubble, covered]);

  const bar = h('div', { className: 'mtt-actions' },
    h(VersionRing, { ring: ring, sessionId: sessionId }),
    isVersion && self && self.model ? h(ModelChip, { model: self.model, title: t('modelCard') }) : null,
    h(ActionButton, {
      title: copied ? t('copied') : t('copy'),
      onClick: copy,
      act: 'copy',
    }, copied ? h(CheckIcon) : h(CopyIcon)),
    h(ActionButton, { title: t('edit'), disabled: !canEdit, onClick: beginEdit, act: 'edit' }, h(PencilIcon)),
    h('span', { className: 'mtt-anchor', ref: revertAnchor },
      h(ActionButton, {
        title: t('regenerate'), disabled: !canEdit || busy, onClick: retry, act: 'retry',
        active: revert !== null,
      }, h(RetryIcon))),
    h(Popover, { open: revert !== null, anchor: revertAnchor, up: popUp },
      revert === null ? null : h(RevertConfirm, {
        plan: revert.plan,
        busy: busy,
        onCancel: function () { setRevert(null); },
        onConfirm: confirmRevert,
      })),
    // One trash per row, and it always deletes this message — on a version card too.
    // Deleting the card is a branch-level decision and lives in the Versions view.
    h('span', { className: 'mtt-menu-wrap' },
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
    // No translate action on a question: it is already in the language the reader
    // wrote it in, and the useful direction is the answer's.
    //
    // No card delete either. The trash above means "this message, and nothing else":
    // deleting one message must never take the conversation with it, which is exactly
    // what archiving a version card looked like. Removing a branch is a branch-level
    // decision, so it lives in the Versions view.
    null);

  return h(React.Fragment, null,
    bar,
    slot !== null && slot !== undefined && dom !== null && typeof dom.createPortal === 'function'
      ? dom.createPortal(overlay, slot)
      : null,
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
  // Answers produced by answering again are turns of their own; when this turn
  // belongs to such a group, the app's own rows draw the visible answer and this
  // card has nothing to paint — only the alternatives that are *not* on screen
  // have to be taken out of the flow.
  const run = runsOf(state ? state.runs : null, turn, state ? state.hidden : null);
  const ring = answerRing(state ? state.answers : null, turn);
  // The text the reader edited in place on the logged answer (no variant), if
  // any. Both the copy button and the translator need it: what is on screen is
  // not what the log says once an edit was saved.
  const override = answerOverride(state ? state.answers : null, turn);
  const live = useLiveAnswer(sessionId, turn);
  const liveTranslation = useLiveTranslation(sessionId, turn);
  // The trash deletes what is on screen: the selected variant when the answer
  // is a variant, the logged answer (a view-level hide) when it is the original.
  const deletingVariant = live === null && ring !== null && ring.active.id !== 'native';
  // The turn is showing a translation when the host says which language, and the
  // button then reads as "on" and its menu offers the way back.
  const shownLang = shownLangOf(state, turn);
  // The translation on screen, if any: what the paired page draws, and what
  // "copy the translation" has to write.
  const drawnTranslation = translationOf(state, turn);

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
  // The shared live cell survives a toolbar remount and is cleared immediately
  // by cancellation, so it owns both the stop control and this row's busy state.
  const translating = liveTranslation !== null;
  const [error, setError] = React.useState(null);
  const [toastNode, showToast] = useToast();
  const [copied, setCopied] = React.useState(false);
  const copyAttempt = React.useRef(0);
  const [catalog, setCatalog] = React.useState(null);
  const [catalogError, setCatalogError] = React.useState(null);
  const edit = useAnswerEdit(sessionId, turn);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [confirmAnswer, setConfirmAnswer] = React.useState(false);
  const [popUp, setPopUp] = React.useState(false);
  const answerAnchor = React.useRef(null);
  const cardAnchor = React.useRef(null);
  // A file-changing turn asks before anything is written, so the pending plan
  // lives here until the user confirms it (or the popover is dismissed).
  const [revert, setRevert] = React.useState(null);
  const revertAnchor = React.useRef(null);

  // Busy while a request of this row is in flight, and while an answer of this
  // turn is still being written by anyone (this row, the card, or a bubble).
  const working = busy || live !== null || translating;

  const contextRing = state && state.contextChoices
    ? state.contextChoices[String(run ? run.key : turn)] : null;
  const ringView = contextRing && contextRing.items.length > 1
    ? { count: contextRing.items.length, index: contextRing.items.findIndex(function (item) { return item.id === contextRing.active; }) }
    : null;

  // The native dropdowns (model picker, language picker) dismiss themselves
  // (outside click, Escape, pointer leave), so this listener must not fight
  // them: it only closes our own popovers.
  const nativeMenus = clientPrimitives() !== null;
  useDismiss(
    (menu !== null && !(nativeMenus && (menu === 'model' || menu === 'translate' || menu === 'answers')))
      || confirmDelete || confirmAnswer || revert !== null,
    function () {
      setMenu(null);
      setConfirmDelete(false);
      setConfirmAnswer(false);
      setRevert(null);
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

  // "Regenerate" and "switch model" do not branch the conversation: the answer
  // is swapped in place (see AnswerCard), so the conversation stays one
  // conversation. The branch path is still one click away in the model menu for
  // a full agent run with tools.
  //
  // A file-changing answer first offers a verified undo of its edits — see
  // `rerunAfterRevert`. Both regenerate and model switching then append a real
  // agent turn, with native tools and streaming, as an alternative answer.
  async function regenerate() {
    if (typeof turn !== 'number') return;
    setError(null);
    const plan = await turnChangePlan(sessionId, turn);
    if (plan !== null) {
      setRevert({ plan: plan, model: null, mode: 'model' });
      return;
    }
    setBusy(true);
    try {
      // Regenerating replaces the answer in this conversation: same question, same
      // session, one answer on screen. The answer being replaced is hidden; the model
      // menu keeps the explicit new-session option for a clean starting point.
      await rerunTurnInPlace({
        sessionId: sessionId,
        turn: turn,
        model: currentModel(),
        stopPrevious: prefs.stopPrevious,
      });
      showToast(t('answerRegenerated'));
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  async function switchModel(model) {
    setMenu(null);
    if (typeof turn !== 'number') return;
    setError(null);
    const plan = await turnChangePlan(sessionId, turn);
    if (plan !== null) {
      setRevert({
        plan: plan,
        model: { provider: model.provider, model: model.model, name: model.name },
        mode: 'model',
      });
      return;
    }
    setBusy(true);
    try {
      // Same real turn, pinned to the chosen model for this answer only: the
      // session keeps its own model for everything that follows.
      await rerunTurnInPlace({
        sessionId: sessionId,
        turn: turn,
        model: { provider: model.provider, model: model.model },
        stopPrevious: prefs.stopPrevious,
      });
      showToast(t('answerGeneratedBy', { name: modelLabel(model) }));
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  /** Undo the files the answer being replaced touched, then answer again. */
  async function confirmRevert() {
    const pending = revert;
    if (pending === null || typeof turn !== 'number') return;
    setRevert(null);
    setBusy(true);
    setError(null);
    try {
      const result = await rerunAfterRevert({
        sessionId: sessionId,
        turn: turn,
        model: pending.model,
        mode: pending.mode,
        stopPrevious: prefs.stopPrevious,
        ...(pending.replace === true ? { replace: true } : {}),
        ...(Array.isArray(pending.files) && pending.files.length > 0 ? { files: pending.files } : {}),
      });
      showToast(t('revertedToast', { count: String(result.revertedCount) }));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
    setBusy(false);
  }

  async function selectAnswer(id) {
    if (busy || !contextRing || id === contextRing.active) return;
    setBusy(true);
    setError(null);
    try { await changeContext({ action: 'context-select', sessionId: sessionId, turn: turn, id: id }); }
    catch (error) { setError(failureText(error)); }
    finally { setBusy(false); }
  }

  async function stepAnswer(delta) {
    if (!contextRing) return;
    const next = contextRing.items[ringView.index + delta];
    if (next) await selectAnswer(next.id);
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
    setError(null);
    try {
      const result = await translateInto(sessionId, turn, body);
      if (result !== null) showToast(t('translated'));
    } catch (e) {
      showToast(failureText(e), 'error');
    }
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

  /** Copy the translation alone: the pair on screen is for reading, not for selecting by hand. */
  async function copyTranslation() {
    setMenu(null);
    const drawn = translationOf(state, turn);
    if (drawn === null || typeof drawn.text !== 'string') return;
    const attempt = ++copyAttempt.current;
    setCopied(false);
    try {
      await writeClipboard(drawn.text);
      if (copyAttempt.current === attempt) showToast(t('translationCopied'));
    } catch (e) {
      if (copyAttempt.current === attempt) showToast(failureText(e), 'error');
    }
  }

  /**
   * The app's own copy button copies the *logged* answer. While a variant, an edit
   * or a translation is on screen that is the wrong text, so the row offers the
   * answer the reader is looking at instead of leaving the only copy button lying.
   */
  const drawnCopy = ring !== null && ring.active.id !== 'native'
      ? String(ring.active.text || '')
      : override !== null
        ? String(override.text || '')
        : drawnTranslation !== null ? String(drawnTranslation.text || '') : '';

  React.useEffect(function () {
    copyAttempt.current++;
    setCopied(false);
  }, [sessionId, turn, drawnCopy]);

  async function copyDrawn() {
    const attempt = ++copyAttempt.current;
    setCopied(false);
    try {
      await writeClipboard(drawnCopy);
      if (copyAttempt.current !== attempt) return;
      setCopied(true);
      setTimeout(function () { if (copyAttempt.current === attempt) setCopied(false); }, 1200);
    } catch (e) {
      if (copyAttempt.current === attempt) showToast(failureText(e), 'error');
    }
  }

  async function removeVersion() {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await changeContext({ action: 'delete-version', sessionId: sessionId });
      showToast(t('deletedCard'));
    } catch (error) { showToast(failureText(error), 'error'); }
    finally { setBusy(false); }
  }

  async function deleteVisible() {
    setConfirmAnswer(false);
    if (typeof turn !== 'number') return;
    setBusy(true);
    setError(null);
    try {
      await contextMutation(sessionId, turn, 'delete-answer');
      showToast(t('answerHidden'));
    } catch (error) { showToast(failureText(error), 'error'); }
    finally { setBusy(false); }
  }

  return h('span', { className: 'mtt-toolbar' },
    h('span', { className: 'mtt-anchor', ref: revertAnchor },
      h(ActionButton, {
        title: t('regenerate'), disabled: working || typeof turn !== 'number', onClick: regenerate,
        active: revert !== null,
      }, h(RetryIcon))),
    h(Popover, { open: revert !== null, anchor: revertAnchor, up: popUp },
      revert === null ? null : h(RevertConfirm, {
        plan: revert.plan,
        busy: busy,
        onCancel: function () { setRevert(null); },
        onConfirm: confirmRevert,
      })),
    failed || drawnCopy.length === 0
      ? null
      : h(ActionButton, {
        title: copied ? t('copied') : t('copyThisAnswer'),
        onClick: copyDrawn,
        act: 'copy-answer',
      }, copied ? h(CheckIcon) : h(CopyIcon)),
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
      onPick: switchModel,
      onToggle: openModelMenu,
      onClose: function () { setMenu(null); },
    }),
    failed
      ? null
      : h(LanguageMenuHost, {
        title: shownLang === null ? t('translate') : t('translatedTo'),
        busyTitle: t('stopTranslating'),
        busy: translating,
        pickTitle: t('translateTo'),
        open: menu === 'translate',
        up: popUp,
        disabled: working || typeof turn !== 'number',
        active: shownLang !== null,
        current: shownLang !== null ? shownLang : prefs.lang,
        original: shownLang !== null,
        originalLabel: t('hideTranslation'),
        onOriginal: showOriginal,
        // With a translation on screen the menu also offers its text: a reader who
        // wants the translation somewhere else should not have to select the pair
        // by hand in the transcript.
        copy: shownLang !== null && drawnTranslation !== null,
        copyLabel: t('copyTranslation'),
        onCopy: copyTranslation,
        onToggle: function (event) { toggleMenu('translate', event); },
        onCancel: function () { cancelTranslation(sessionId, turn); },
        onPick: translate,
        onClose: function () { setMenu(null); },
      }),
    // One trash per row, and it always deletes the message — on a version card too.
    // Deleting a card used to archive that session, which read as the conversation
    // vanishing; the branch-level delete now lives in the Versions view.
    h('span', { className: 'mtt-menu-wrap' },
        h('span', { className: 'mtt-anchor', ref: answerAnchor },
          h(ActionButton, {
            title: working
              ? t('deleteWhileWriting')
              : (failed ? t('deleteMessage') : (deletingVariant ? t('deleteVariant') : t('deleteAnswer'))),
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
      ? h('span', { className: 'mtt-ring' },
        h('button', {
          type: 'button', className: 'mtt-ring-btn', disabled: working || ringView.index <= 0,
          title: t('prevAnswer'), onClick: function () { return stepAnswer(-1); },
        }, h(ChevronLeftIcon)),
        // Answers are also kept as turns, so `2/3` names an answer worth picking:
        // the count opens the list instead of only flipping one at a time.
        h(RingMenuHost, {
          title: t('pickAnswer'),
          open: menu === 'answers',
          up: popUp,
          disabled: working,
          index: ringView.index,
          count: ringView.count,
          choices: menu === 'answers'
            ? contextRingChoices(contextRing)
            : { items: [], selectedId: null },
          onToggle: function (event) { toggleMenu('answers', event); },
          onPick: function (id) { setMenu(null); return selectAnswer(id); },
          onClose: function () { setMenu(null); },
        }),
        h('button', {
          type: 'button', className: 'mtt-ring-btn',
          disabled: working || ringView.index >= ringView.count - 1,
          title: t('nextAnswer'), onClick: function () { return stepAnswer(1); },
        }, h(ChevronRightIcon)))
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

  // Removing a branch is a branch-level decision: it lives here, where the tree is
  // the thing being looked at, and it is the only place a card can be deleted.
  async function removeCard(node) {
    setBusy(node.sessionId); setError(null);
    try {
      await changeContext({ action: 'delete-version', sessionId: node.sessionId, sourceSessionId: sessionId });
    } catch (error) { setError(failureText(error)); }
    finally { setBusy(null); }
  }

  const rows = nodes.map(function (node) {
    const isRoot = node.isRoot === true;
    const indent = { paddingLeft: (8 + node.depth * 18) + 'px' };
    const title = isRoot
      ? t('originalConversation')
      : ({
        'edit-prompt': t('editedQuestion', { turn: node.turn }),
        'edit-answer': t('editedAnswerTurn', { turn: node.turn }),
        'delete-answer': t('deletedAnswerTurn', { turn: node.turn }),
        'delete-question': t('deletedQuestionTurn', { turn: node.turn }),
        retry: t('retriedTurn', { turn: node.turn }),
        edit: t('editedTurn', { turn: node.turn }),
      }[node.operation] || t('editedTurn', { turn: node.turn }));
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
          switchToVersion(navigation, node, sessionId).catch(function (error) { setError(failureText(error)); });
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
        : isRoot
          ? null
          : h('button', {
            type: 'button', className: 'mtt-btn mtt-btn-small mtt-btn-danger',
            title: t('deleteCard'),
            disabled: busy === node.sessionId,
            onClick: function () { return removeCard(node); },
          }, t('delete')));
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
  '.mtt-row,.mtt-toolbar,.mtt-answer,.mtt-alt,.mtt-view,.mtt-pop,.mtt-toast{color:var(--mtt-fg)}',
  // `:where()` keeps this at zero specificity so a variant that does state its
  // own ink — .mtt-btn-primary, .mtt-btn-danger — still wins.
  ':where(button.mtt-btn,button.mtt-act,button.mtt-pop-item,button.mtt-ring-btn,button.mtt-node-card,textarea.mtt-answer-edit-input){color:inherit}',
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
  // The app's user row: attachments and bubble stack right-aligned, 8px apart.
  // Exactly DSH's own user bubble (Sixlwa_bubble in dsh-client-ui-chat): the
  // light-blue fill is --dsw-specific-bubble, not a neutral tint — the grey
  // version this rule used to paint over it was the tell that the token was made up.
  // The app's own file card, measurement for measurement: a 240px card, a 28px
  // type icon, the name over "PDF 1.2 MB".
  '.mtt-user-bar{display:flex;justify-content:flex-end;align-items:flex-start;gap:8px;padding:2px 0 0;min-width:0}',
  // The app's own action row fades in under the pointer; ours sits in the app's row, so it follows the app's row and not a .mtt-row of ours.
  '[data-mtt-row]:hover .mtt-actions,[data-mtt-row]:focus-within .mtt-actions{opacity:1}',
  // The stack around a question shrink-wraps its bubble, and that bubble is hidden
  // while the editor is open — without this the editor had nothing to size against
  // and collapsed to the width of its own head. Stretch the decorated row's stack
  // so the editor gets the width the bubble would have had.
  '[data-mtt-row] [class*="_userStack"]{width:100%}',
  '.mtt-user-slot{display:flex;justify-content:flex-end;width:100%;min-width:0;max-width:100%}',
  '.mtt-bubble-md{white-space:normal;word-break:break-word;text-align:left}',
  '.mtt-bubble-md>div>:first-child{margin-top:0}',
  '.mtt-bubble-md>div>:last-child{margin-bottom:0}',
  '[data-mtt-row] [class*="_actions"]{display:none}',
  '.mtt-bubble{max-width:min(calc(var(--dsh-chat-content-width,748px) * .702),82%);background:var(--mtt-bubble);border-radius:var(--dsw-radius-xl,16px);padding:10px 16px;color:var(--dsw-alias-label-primary,CanvasText);font:inherit;font-size:var(--dsh-content-font-size,14px);line-height:calc(22px + var(--dsh-content-font-delta,0px));min-width:0;white-space:pre-wrap;word-break:break-word}',
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
  // The count of an answer row is a button that opens the answers by name, so it
  // has to look like the two arrows beside it — same box, same hover — while
  // staying wide enough for `12/12`.
  '.mtt-ring-num{min-width:26px;padding:0 3px;height:calc(28px + var(--dsh-content-font-delta,0px));display:inline-flex;align-items:center;justify-content:center;font-size:calc(12px + var(--dsh-content-font-delta,0px));line-height:1;font-variant-numeric:tabular-nums;color:var(--mtt-fg-3)}',
  '.mtt-answer-choice{display:flex;flex-direction:column;gap:2px;min-width:0;max-width:min(320px,calc(100vw - 96px));padding:2px 0}',
  '.mtt-answer-choice-model,.mtt-answer-choice-preview{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mtt-answer-choice-preview{color:var(--mtt-fg-2);font-size:calc(12px + var(--dsh-content-font-delta,0px));line-height:1.4}',
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
  // The box itself is the composer's: the same input surface, the same panel
  // radius, the same soft elevation with the hairline stroke drawn as part of it.
  '.mtt-answer-edit{display:flex;flex-direction:column;gap:8px;width:100%;min-width:0;padding:10px 12px 8px;border:0;--dsw-elevation-stroke-color:var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-panel,16px);background:var(--dsw-specific-input-major,var(--mtt-surface-2));box-shadow:var(--dsw-elevation-soft,inset 0 0 0 .5px var(--mtt-line))}',
  '.mtt-answer-edit-head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}',
  '.mtt-answer-edit-label{font-size:12px;color:var(--mtt-fg-3)}',
  '.mtt-answer-edit-tools{display:flex;align-items:center;gap:4px}',
  '.mtt-answer-edit-input{display:block;width:100%;height:clamp(140px,34vh,360px);resize:vertical;border:0;background:transparent;color:var(--mtt-fg);font-family:inherit;font-size:var(--dsh-content-font-size,14px);line-height:1.6;padding:0;outline:none;overflow:auto;overscroll-behavior:contain}',
  '.mtt-answer-edit-input::placeholder{color:var(--mtt-fg-3)}',
  // The question editor is the answer editor where a bubble would be: same box,
  // same head, plus `send`. It sits right-aligned under the attachment cards.
  // Same box as the answer editor, sized to the width the bubble would have used.
  // (The bubble's own `0.702 × content-width` cap is too narrow to type in.)
  '.mtt-answer-edit-prompt{width:100%;max-width:100%;margin-left:auto}',
  '.mtt-answer-edit-prompt .mtt-answer-edit-input{height:clamp(96px,22vh,240px)}',
  '.mtt-answer-edit.mtt-dropping{outline:1px dashed var(--mtt-line-strong);outline-offset:2px;background:var(--mtt-hover)}',
  '.mtt-file-input{display:none}',
  // Attachments are the app's own components, drawn from its metrics: 64px
  // thumbnails in a gap-10 rail, 240×64 file cards with a 28px category glyph,
  // the suffix and the size on the meta line. The remove button only appears on
  // hover, as it does in the composer.
  '.mtt-rail{display:flex;align-items:stretch;gap:10px;min-width:0;overflow-x:auto;overflow-y:hidden;scrollbar-width:none}',
  '.mtt-rail::-webkit-scrollbar{display:none}',
  // Layout-transparent: its row takes the place the app's own attachment row takes.
  '.mtt-user-atts{display:contents}',
  '.mtt-attach-row{display:flex;flex-wrap:wrap;justify-content:flex-end;max-width:100%;gap:8px;min-width:0}',
  '.mtt-tile{position:relative;flex:none;width:64px;height:64px}',
  '.mtt-tile-img{display:block;width:64px;height:64px;object-fit:cover;border:.5px solid var(--dsw-alias-border-l2-darkmode-thin,var(--mtt-line));border-radius:var(--dsw-radius-xl,16px);background:var(--mtt-hover);cursor:zoom-in}',
  '.mtt-tile-blank{display:block;width:64px;height:64px;border-radius:var(--dsw-radius-xl,16px);background:var(--mtt-hover)}',
  '.mtt-tile-remove{position:absolute;top:4px;right:4px;z-index:1;display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-button-contrast-fill,var(--mtt-fg-3));color:var(--dsw-alias-label-primary-inverted,var(--mtt-surface));cursor:pointer;opacity:0;transition:opacity .2s}',
  '.mtt-tile:hover .mtt-tile-remove,.mtt-tile:focus-within .mtt-tile-remove{opacity:1}',
  '.mtt-tile-remove svg{display:block;width:10px;height:10px}',
  '.mtt-file{position:relative;display:inline-flex;flex:none;align-items:center;gap:10px;width:240px;height:64px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2,var(--mtt-line));border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-specific-input-major,transparent);box-sizing:border-box;text-align:left}',
  '.mtt-file-icon{flex:none;width:28px;height:28px}',
  '.mtt-file-icon-plain{display:grid;place-items:center;font-size:9px;font-weight:600;letter-spacing:.02em;color:var(--mtt-fg-3)}',
  '.mtt-file-body{display:flex;flex:1;flex-direction:column;min-width:0;padding:8px 0}',
  '.mtt-file-name{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--mtt-fg);font-size:14px;font-weight:500;line-height:22px}',
  '.mtt-file-meta{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;color:var(--mtt-fg-3);font-size:12px;line-height:15px}',
  '.mtt-file-remove{position:absolute;top:6px;right:6px;z-index:1;display:grid;place-items:center;width:18px;height:18px;padding:0;border:0;border-radius:50%;background:var(--dsw-alias-button-contrast-fill,var(--mtt-fg-3));color:var(--dsw-alias-label-primary-inverted,var(--mtt-surface));cursor:pointer;opacity:0;transition:opacity .2s}',
  '.mtt-file:hover .mtt-file-remove,.mtt-file:focus-within .mtt-file-remove{opacity:1}',
  '.mtt-file-remove svg{display:block;width:10px;height:10px}',
  '.mtt-file-busy{opacity:.85}',
  '.mtt-file-spin{flex:none;width:20px;height:20px;border:2px solid var(--mtt-fg-3);border-top-color:transparent;border-radius:50%;animation:mtt-spin .8s linear infinite}',
  '@keyframes mtt-spin{to{transform:rotate(360deg)}}',
  '.mtt-attach-hint{margin-top:6px;font-size:12px;color:var(--mtt-fg-3)}',

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
  '.mtt-change-list{display:flex;flex-direction:column;gap:2px;padding:2px 8px 6px;max-height:180px;overflow:auto}',
  '.mtt-change-row{display:flex;gap:8px;align-items:baseline;font-size:12px;line-height:1.5}',
  '.mtt-change-path{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mtt-fg)}',
  '.mtt-change-stat{flex:0 0 auto;color:var(--mtt-fg-3);font-variant-numeric:tabular-nums}',
  '.mtt-change-more{font-size:11px;color:var(--mtt-fg-3);padding-top:2px}',
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
    editedQuestion: 'Edited question {turn}',
    editedAnswerTurn: 'Edited answer {turn}',
    deletedAnswerTurn: 'Deleted answer {turn}',
    deletedQuestionTurn: 'Deleted question {turn}',
    retriedTurn: 'Regenerated turn {turn}',
    archived: 'Archived',
    deletedCardTag: 'Deleted',
    currentTag: 'Current',
    copy: 'Copy',
    copied: 'Copied',
    clipboardUnavailable: 'Clipboard is unavailable. Select the text and copy it with Ctrl/⌘+C.',
    edit: 'Edit message',
    regenerate: 'Regenerate this turn',
    translate: 'Translate',
    translateTo: 'Translate into…',
    translated: 'Translated',
    translating: 'Translating…',
    stopTranslating: 'Stop translating',
    translationTruncated: 'The translation was cut off by the model\'s length limit — the rest is untranslated.',
    copyTranslation: 'Copy the translation',
    copyThisAnswer: 'Copy this answer',
    translationCopied: 'Translation copied',
    close: 'Close',
    imagesKept: '{count} image(s) kept as-is',
    cancel: 'Cancel',
    send: 'Send',
    sending: 'Sending…',
    shortcutHint: 'Ctrl/⌘+Enter to send · Esc to cancel',
    saving: 'Saving…',
    editSaveHint: 'Save keeps the answer you already have; send answers the new question.',
    editSendHint: 'Rewrite the question — ⌘/Ctrl+Enter sends it.',
    promptEdited: 'Question updated',
    attach: 'Attach files',
    attachHint: 'Drop files here — they are sent with this question.',
    attaching: 'Uploading…',
    waitForUploads: 'Wait for the attachments to finish uploading before saving or sending.',
    uploadFailed: 'Attachment upload failed: {error}. Retry the upload, or close and reopen the editor to omit it.',
    attachRemove: 'Remove this file',
    prevVersion: 'Previous version',
    nextVersion: 'Next version',
    versionHint: 'This answer has other versions',
    modelCard: 'Answer model of this card',
    switchModel: 'Answer this turn with another model',
    switchModelPick: 'Pick a model — its answer replaces this one in place (switch with ‹ ›)',
    branchInstead: '…or answer in a new session from before this question',
    variants: 'Answers',
    nativeAnswer: 'model’s own answer',
    nativeVisibleHint: 'Showing the answer the model actually produced. Use › to go back to an alternative.',
    editedAnswer: 'edited by you',
    editAnswer: 'Edit this answer',
    editing: 'Editing',
    exitEdit: 'Close the editor',
    answerEditHint: 'Edit the Markdown source. Saving replaces the displayed answer without adding a variant.',
    save: 'Save',
    prevAnswer: 'Previous answer',
    nextAnswer: 'Next answer',
    pickAnswer: 'Pick an answer',
    answerNumber: 'Answer {n}',
    deleteVariant: 'Delete this variant',
    deleteVariantConfirm: 'Delete this answer?',
    variantDeleted: 'Answer deleted',
    generating: 'Generating…',
    thinking: 'Thinking…',
    thought: 'Thinking',
    answerGenerated: 'New answer ready — switch with ‹ ›',
    answerRegenerated: 'The agent is answering again…',
    answerGeneratedBy: 'Answering again with {name}…',
    answerEdited: 'Edit saved',
    footnotes: 'Footnotes',
    noModels: 'No models available',
    messageNotIndexed: 'This message is not indexed yet; reopen the conversation to retry.',
    switched: 'Answering with {name}…',
    deleteCard: 'Delete this answer card',
    deleteCardConfirm: 'Delete this answer card? You can restore it from the Versions view.',
    deleteMessage: 'Delete this message',
    deleteMessageConfirm: 'Delete this question and leave its answer and later turns in the previous version?',
    deleteAnswer: 'Delete this answer',
    deleteAnswerConfirm: 'Delete this answer? Its continuation stays in the previous version.',
    deleteWhileWriting: 'Wait for the answer to finish, then delete it',
    turnHidden: 'Message deleted',
    answerHidden: 'Answer deleted',
    contextMissing: 'The toolbar host did not return a conversation branch. Update the plugin and restart DSH.',
    navigationMissing: 'DSH conversation navigation is unavailable.',
    navigationBusy: 'Switching answers. Please wait before making another change.',
    navigationSuperseded: 'The conversation changed before this branch could open. Find it in Versions.',
    navigationTimeout: 'DSH did not list this branch in time. Find it in Versions.',
    retryNavigation: 'Retry organizing versions',
    navigationRetryUnavailable: 'This navigation job is no longer available. Refresh the conversation and try again.',
    openMigratedContext: 'Open synced conversation',
    checkingContext: 'Checking conversation context…',
    syncingContext: 'Syncing old conversation…',
    retrySync: 'Retry sync',
    delete: 'Delete',
    deletedCard: 'Card deleted',
    translatedTo: 'Translated',
    hideTranslation: 'Hide the translation',
    revertTitle: 'This answer changed {count} file(s). Undo them and answer again?',
    revertMore: 'and {count} more',
    revertAndAnswer: 'Undo and answer again',
    revertedToast: 'Put {count} file(s) back — answering again…',
    revertUnconfirmed: 'The file revert could not be confirmed. Regeneration stopped; inspect the workspace.',
    revertIncomplete: 'Reverted {reverted} file(s), but {count} could not be safely reverted ({files}). Regeneration stopped; inspect these files.',
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
    editedQuestion: '编辑了第 {turn} 轮问题',
    editedAnswerTurn: '编辑了第 {turn} 轮回答',
    deletedAnswerTurn: '删除了第 {turn} 轮回答',
    deletedQuestionTurn: '删除了第 {turn} 轮问题',
    retriedTurn: '重新生成第 {turn} 轮',
    archived: '已归档',
    deletedCardTag: '已删除',
    currentTag: '当前',
    copy: '复制',
    copied: '已复制',
    clipboardUnavailable: '无法访问剪贴板，请选中文字后按 Ctrl/⌘+C 复制。',
    edit: '编辑消息',
    regenerate: '重新生成这一轮',
    translate: '翻译',
    translateTo: '翻译成…',
    translated: '已翻译',
    translating: '正在翻译…',
    stopTranslating: '停止翻译',
    translationTruncated: '译文因为模型的长度上限被截断了，后半部分没有翻译。',
    copyTranslation: '复制译文',
    copyThisAnswer: '复制这条回答',
    translationCopied: '已复制译文',
    close: '关闭',
    imagesKept: '{count} 张图片原样保留',
    cancel: '取消',
    send: '发送',
    sending: '发送中…',
    shortcutHint: 'Ctrl/⌘+Enter 发送 · Esc 取消',
    saving: '保存中…',
    editSaveHint: '保存只改文字，保留现有回答；发送会按新问题重新回答。',
    editSendHint: '改写这条提问 — ⌘/Ctrl+Enter 直接发送。',
    promptEdited: '问题已更新',
    attach: '添加附件',
    attachHint: '把文件拖到这里，会随这条提问一起发出。',
    attaching: '上传中…',
    waitForUploads: '请等附件上传完成后再保存或发送。',
    uploadFailed: '附件上传失败：{error}。请重新上传，或关闭后重新编辑以放弃该附件。',
    attachRemove: '移除这个附件',
    prevVersion: '上一个版本',
    nextVersion: '下一个版本',
    versionHint: '这条回答还有其它版本',
    modelCard: '该卡片的回答模型',
    switchModel: '换一个模型回答这一轮',
    switchModelPick: '选择模型——它的回答会就地替换当前回答（用 ‹ › 切换）',
    branchInstead: '…或从这条问题之前开始，在新会话里重答',
    variants: '回答备选',
    nativeAnswer: '模型原始回答',
    nativeVisibleHint: '当前显示的是模型真实的回答。点 › 可以回到备选回答。',
    editedAnswer: '你的编辑版',
    editAnswer: '编辑这条回答',
    editing: '编辑中',
    exitEdit: '退出编辑',
    answerEditHint: '编辑 markdown 源码；保存会覆盖当前显示的回答，不增加备选。',
    save: '保存',
    prevAnswer: '上一个回答',
    nextAnswer: '下一个回答',
    pickAnswer: '选择回答',
    answerNumber: '回答 {n}',
    deleteVariant: '删除这个备选',
    deleteVariantConfirm: '删除这条回答？',
    variantDeleted: '已删除这条回答',
    generating: '正在生成…',
    thinking: '思考中…',
    thought: '思考过程',
    answerGenerated: '新回答已生成——用 ‹ › 切换',
    answerRegenerated: 'agent 正在重新回答…',
    answerGeneratedBy: '正在用 {name} 重新回答…',
    answerEdited: '编辑已保存',
    footnotes: '脚注',
    noModels: '暂无可用模型',
    messageNotIndexed: '这条消息还没有建立索引，请重新打开会话再试。',
    switched: '正在用 {name} 回答…',
    deleteCard: '删除这张回答卡片',
    deleteCardConfirm: '删除这张回答卡片？可以在“版本”视图里恢复。',
    deleteMessage: '删除这条消息',
    deleteMessageConfirm: '删除这条提问？它的回答和之后的消息会保留在原版本。',
    deleteAnswer: '删除这条回答',
    deleteAnswerConfirm: '删除这条回答？它之后的消息会保留在原版本。',
    deleteWhileWriting: '等这轮回答写完再删除',
    turnHidden: '已删除这条消息',
    answerHidden: '已删除这条回答',
    contextMissing: '插件宿主未返回会话分支，请更新插件并重启 DSH。',
    navigationMissing: 'DSH 的会话导航服务不可用。',
    navigationBusy: '正在切换回答，请稍后再试。',
    navigationSuperseded: '打开分支前已切换会话，可在版本树里找到这个分支。',
    navigationTimeout: 'DSH 未及时列出新分支，可在版本树里找到它。',
    retryNavigation: '重试整理版本',
    navigationRetryUnavailable: '这次导航任务已不存在，请刷新会话后重试。',
    openMigratedContext: '打开同步后的会话',
    checkingContext: '正在检查会话上下文…',
    syncingContext: '正在同步旧会话…',
    retrySync: '重试同步',
    delete: '删除',
    deletedCard: '卡片已删除',
    translatedTo: '已翻译',
    hideTranslation: '隐藏译文',
    translationHidden: '已隐藏译文',
    revertTitle: '这个回答改了 {count} 个文件，回退它们再重答？',
    revertMore: '另有 {count} 个',
    revertAndAnswer: '回退并重答',
    revertedToast: '已回退 {count} 个文件，正在重新回答…',
    revertUnconfirmed: '无法确认文件回退结果，已停止重新生成，请检查工作区。',
    revertIncomplete: '已回退 {reverted} 个文件，另有 {count} 个未能安全回退（{files}）。已停止重新生成，请检查文件。',
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
    navigation = { list: sessions.list, openVersion: function (id, options) { return openWorkspaceVersion(uiWorkspace, id, options); } };

    ctx.effect(function () { return styles.insert(CSS); });

    // The right-hand turn rail is a merge of two folds of the log, and neither
    // knows about a row the reader deleted or a question that was asked twice.
    // Filtering the host's projection is what actually shortens the rail (its
    // marks are positioned by index in the merged list, so hiding one by
    // position leaves the virtual list's own transform in the way); patching the
    // chat target's navigation items covers the other half.
    ctx.effect(function () { return installOutlineFilter(ctx); }, 'message-toolbar: turn rail outline');
    // Optional: a shell without `uiConversation` simply keeps the stock rail.
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

    // A question keeps the renderer the app ships — attachment cards, reference
    // chips, images and the plain-text bubble all stay native. The toolbar is
    // mounted into that row, and the markdown copy of a question (only when the
    // text actually holds markdown) is laid over the bubble instead of replacing
    // the row. See installUserRows().
    ctx.effect(function () { return installUserRows(); }, 'message-toolbar: user rows');

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

    slots.inject('conversation.composer.dock', function () {
      return slots.register({ name: 'conversation.composer.dock', id: 'message-toolbar-context',
        inject: function (sessionId) { return { sessionId: sessionId, composerBlocks: ctx.get('conversation')?.blocks }; } }, ContextFocus);
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
