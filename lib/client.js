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
//   (copy / edit / regenerate / translate / delete-version), a version ring
//   (‹ 2/3 ›) and a true rewind-branch editor.
// - Adds an assistant action row: regenerate, switch model (keeping a
//   per-model answer card), translate (bilingual) and delete-version.
// - Renders translations as an in-flow bilingual card under the answer
//   (conversation.chat.turnTail), with a popover fallback.
// - Adds a Versions view listing the whole branch family with model chips
//   and restore controls.
// - Adds a settings section for the translation target language/model.

const ROUTE = '/message-toolbar';
const VIEW_ORDER = 17;
const SETTINGS_ORDER = 211;
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
  lang: 'zh',
  translateModel: null,
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

  get(sessionId) {
    if (!sessionId) return null;
    return this.bySession.get(sessionId) || null;
  },

  notify() {
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
    out.push({ seq: Number(seqKey), role: role, langs: langs });
  }
  out.sort(function (a, b) { return a.seq - b.seq; });
  return out;
}

function langLabel(id) {
  for (let i = 0; i < LANGS.length; i++) if (LANGS[i].id === id) return LANGS[i].label;
  return id;
}

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

// Edge length of every icon in the toolbar row. The row's own CSS (see the
// .mtt-act svg rule) sets the rendered size to DSH's native 17px; the attribute
// only has to be a sane fallback. All glyphs share the native 16-unit grid so
// stroke weight and optical size match the built-in actions next to them.
const ICON = 16;

function CopyIcon() {
  return React.createElement('svg', { width: ICON, height: ICON, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('rect', { x: 5.2, y: 5.2, width: 8.2, height: 8.2, rx: 2, stroke: 'currentColor', strokeWidth: 1.3 }),
    React.createElement('path', {
      d: 'M10.6 5.2V4.2a1.8 1.8 0 00-1.8-1.8H4.2a1.8 1.8 0 00-1.8 1.8v4.6a1.8 1.8 0 001.8 1.8h1',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
    }));
}

function PencilIcon() {
  return React.createElement('svg', { width: ICON, height: ICON, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('path', {
      d: 'M11.1 2.4a1.9 1.9 0 012.7 2.7L5.3 13.6l-3.4.7.7-3.4L11.1 2.4z',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinejoin: 'round',
    }));
}

function RetryIcon() {
  return React.createElement('svg', { width: ICON, height: ICON, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('path', {
      d: 'M13.2 8a5.2 5.2 0 11-1.6-3.75', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
    }),
    React.createElement('path', {
      d: 'M13.4 2.3v3.1h-3.1', stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }));
}

// A "languages" mark (a 文-style stroke group plus an A) instead of a globe:
// in this row a globe reads as "web / browse", not "translate". Drawn on the
// same 16-unit grid and 1.3 stroke as the built-in action icons.
function TranslateIcon() {
  return React.createElement('svg', { width: ICON, height: ICON, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('path', {
      d: 'M2 4.6h7M5.6 2.3v2.3M2.9 6.9c.9 2.4 2.4 4.4 4.4 6.1M8.2 6.9c-1 2.6-2.8 4.9-5.6 6.7',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }),
    React.createElement('path', {
      d: 'M12.6 2.8L10.4 14h4.6L12.6 2.8M11 10.7h3.2',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }));
}

function TrashIcon() {
  return React.createElement('svg', { width: ICON, height: ICON, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('path', {
      d: 'M2.9 4.4h10.2M6.2 4.4V3a1 1 0 011-1h1.6a1 1 0 011 1v1.4M4 4.4l.6 9a1.2 1.2 0 001.2 1.1h4.4a1.2 1.2 0 001.2-1.1l.6-9',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round', strokeLinejoin: 'round',
    }));
}

function CpuIcon() {
  return React.createElement('svg', { width: ICON, height: ICON, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('rect', { x: 4.4, y: 4.4, width: 7.2, height: 7.2, rx: 1.6, stroke: 'currentColor', strokeWidth: 1.3 }),
    React.createElement('path', {
      d: 'M6.4 2.2v2.2M9.6 2.2v2.2M6.4 11.6v2.2M9.6 11.6v2.2M2.2 6.4h2.2M2.2 9.6h2.2M11.6 6.4h2.2M11.6 9.6h2.2',
      stroke: 'currentColor', strokeWidth: 1.3, strokeLinecap: 'round',
    }));
}

function CheckIcon() {
  return React.createElement('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    React.createElement('path', {
      d: 'M3 8.4l3.2 3.2L13 4.8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round',
    }));
}

/* -------------------------------------------------------------------- UI -- */

const h = React.createElement;

let t = function (key, params) {
  const dict = I18N.zh;
  let out = dict[key] || key;
  if (params) for (const name in params) out = out.replace('{' + name + '}', String(params[name]));
  return out;
};

function ActionButton(props) {
  return h('button', {
    type: 'button',
    className: 'mtt-act' + (props.active ? ' mtt-act-on' : ''),
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

// A menu must not outlive the user's attention: close it as soon as a pointer
// goes down outside any menu wrapper, or on Escape. The captured `close` only
// calls a state setter, so it stays valid for the lifetime of the listener.
function useDismiss(open, close) {
  React.useEffect(function () {
    if (!open) return undefined;
    function onPointer(event) {
      const target = event.target;
      if (target && typeof target.closest === 'function' && target.closest('.mtt-menu-wrap') !== null) return;
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
    LANGS.map(function (lang) {
      return h('button', {
        key: lang.id, type: 'button', className: 'mtt-pop-item',
        onClick: function () { props.onPick(lang.id); },
      }, lang.label);
    }));
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
    h('div', { className: 'mtt-pop-title' }, props.title), rows);
}

/** A small bilingual preview panel anchored under a translate button. */
function TranslationPanel(props) {
  if (!props.panel) return null;
  return h('div', { className: 'mtt-pop mtt-pop-trans' },
    h('div', { className: 'mtt-pop-title' },
      t('translationBadge') + ' · ' + langLabel(props.panel.lang) + (props.panel.model ? ' · ' + props.panel.model : '')),
    h('div', { className: 'mtt-trans-body' }, props.panel.text),
    h('div', { className: 'mtt-pop-actions' },
      h('button', {
        type: 'button', className: 'mtt-btn mtt-btn-small',
        onClick: function () {
          const g = realGlobal();
          try { if (g && g.navigator && g.navigator.clipboard) g.navigator.clipboard.writeText(props.panel.text); } catch (e) {}
        },
      }, t('copy')),
      h('button', { type: 'button', className: 'mtt-btn mtt-btn-small', onClick: props.onClose }, t('close'))));
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
  const [menu, setMenu] = React.useState(null);
  const [panel, setPanel] = React.useState(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [popUp, setPopUp] = React.useState(false);
  const [notice, setNotice] = React.useState(null);

  useDismiss(confirmDelete, function () { setConfirmDelete(false); });

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

  async function retry() {
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

  function copy() {
    const g = realGlobal();
    try {
      if (g && g.navigator && g.navigator.clipboard) g.navigator.clipboard.writeText(text);
    } catch (e) {}
    setCopied(true);
    setTimeout(function () { setCopied(false); }, 1200);
  }

  async function translate(lang) {
    setMenu(null);
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        action: 'translate',
        sessionId: sessionId,
        eventSeq: data.seq,
        lang: lang,
        model: prefs.translateModel || undefined,
      });
      store.patchTranslation(sessionId, result.seq, result.lang, {
        text: result.text, provider: result.provider, model: result.model, turn: result.turn, role: result.role,
      });
      setPanel({ lang: result.lang, text: result.text, model: modelLabel(result) });
      setNotice(t('translated'));
      setTimeout(function () { setNotice(null); }, 2000);
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  async function removeVersion() {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await mutate({ action: 'delete-version', sessionId: sessionId });
      store.invalidate();
      setNotice(t('deletedCard'));
    } catch (e) {
      setError(String((e && e.message) || e));
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
      h(ActionButton, { title: t('edit'), disabled: !canEdit, onClick: beginEdit }, h(PencilIcon)),
      h(ActionButton, { title: t('regenerate'), disabled: !canEdit || busy, onClick: retry }, h(RetryIcon)),
      // No translate action on user bubbles: the bubbled prompt is already the
      // language the user wrote in, and the useful direction to read is the
      // answer's. Translation lives on assistant cards only.
      isVersion
        ? h('span', { className: 'mtt-menu-wrap' + (popUp ? ' mtt-up' : '') },
          h(ActionButton, {
            title: t('deleteCard'), disabled: busy, active: confirmDelete,
            onClick: function (event) {
              setPopUp(popupOpensUp(event));
              setConfirmDelete(!confirmDelete);
            },
          }, h(TrashIcon)),
          confirmDelete
            ? h('div', { className: 'mtt-pop mtt-pop-confirm' },
              h('div', { className: 'mtt-pop-title' }, t('deleteCardConfirm')),
              h('div', { className: 'mtt-pop-actions' },
                h('button', { type: 'button', className: 'mtt-btn', onClick: function () { setConfirmDelete(false); } }, t('cancel')),
                h('button', { type: 'button', className: 'mtt-btn mtt-btn-danger', onClick: removeVersion }, t('delete'))))
            : null)
        : null),
    h(TranslationPanel, { panel: panel, onClose: function () { setPanel(null); } }),
    h(ErrorChip, { error: error }),
    notice ? h('div', { className: 'mtt-notice' }, notice) : null);
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
  const turn = message ? message.turn : undefined;

  const [menu, setMenu] = React.useState(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState(null);
  const [notice, setNotice] = React.useState(null);
  const [catalog, setCatalog] = React.useState(null);
  const [catalogError, setCatalogError] = React.useState(null);
  const [panel, setPanel] = React.useState(null);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [popUp, setPopUp] = React.useState(false);

  useDismiss(menu !== null || confirmDelete, function () { setMenu(null); setConfirmDelete(false); });

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

  async function regenerate() {
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

  async function switchModel(model) {
    setMenu(null);
    if (typeof turn !== 'number') return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        action: 'retry', sessionId: sessionId, turn: turn,
        stopPrevious: prefs.stopPrevious,
        model: { provider: model.provider, model: model.model, name: model.name },
      });
      store.invalidate();
      setNotice(t('switched', { name: modelLabel(model) }));
      switchToVersion(navigation, { sessionId: result.sessionId }, sessionId);
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  async function translate(lang) {
    setMenu(null);
    if (!message) { setError(t('messageNotIndexed')); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        action: 'translate',
        sessionId: sessionId,
        eventSeq: message.seq,
        lang: lang,
        model: prefs.translateModel || undefined,
      });
      store.patchTranslation(sessionId, result.seq, result.lang, {
        text: result.text, provider: result.provider, model: result.model, turn: result.turn, role: result.role,
      });
      setPanel({ lang: result.lang, text: result.text, model: modelLabel(result) });
      setNotice(t('translated'));
      setTimeout(function () { setNotice(null); }, 2000);
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  async function removeVersion() {
    setConfirmDelete(false);
    setBusy(true);
    try {
      await mutate({ action: 'delete-version', sessionId: sessionId });
      store.invalidate();
      setNotice(t('deletedCard'));
    } catch (e) {
      setError(String((e && e.message) || e));
    }
    setBusy(false);
  }

  return h('span', { className: 'mtt-toolbar' },
    h(ActionButton, {
      title: t('regenerate'), disabled: busy || typeof turn !== 'number', onClick: regenerate,
    }, h(RetryIcon)),
    h('span', { className: 'mtt-menu-wrap' + (popUp ? ' mtt-up' : '') },
      h(ActionButton, { title: t('switchModel'), active: menu === 'model', onClick: openModelMenu }, h(CpuIcon)),
      menu === 'model'
        ? h(ModelMenu, { title: t('switchModelPick'), loading: busy, catalog: catalog, onPick: switchModel })
        : null),
    h('span', { className: 'mtt-menu-wrap' + (popUp ? ' mtt-up' : '') },
      h(ActionButton, {
        title: t('translate'), active: menu === 'translate',
        disabled: busy || !message,
        onClick: function (event) { toggleMenu('translate', event); },
      }, h(TranslateIcon)),
      menu === 'translate'
        ? h(LanguageMenu, { title: t('translateTo'), onPick: translate })
        : null),
    isVersion
      ? h('span', { className: 'mtt-menu-wrap' + (popUp ? ' mtt-up' : '') },
        h(ActionButton, {
          title: t('deleteCard'), active: confirmDelete,
          onClick: function (event) {
            setPopUp(popupOpensUp(event));
            setConfirmDelete(!confirmDelete);
          },
        }, h(TrashIcon)),
        confirmDelete
          ? h('div', { className: 'mtt-pop mtt-pop-confirm' },
            h('div', { className: 'mtt-pop-title' }, t('deleteCardConfirm')),
            h('div', { className: 'mtt-pop-actions' },
              h('button', { type: 'button', className: 'mtt-btn', onClick: function () { setConfirmDelete(false); } }, t('cancel')),
              h('button', { type: 'button', className: 'mtt-btn mtt-btn-danger', onClick: removeVersion }, t('delete'))))
          : null)
      : null,
    h(TranslationPanel, { panel: panel, onClose: function () { setPanel(null); } }),
    h(ErrorChip, { error: error || catalogError }),
    notice ? h('div', { className: 'mtt-notice' }, notice) : null);
}

/**
 * Bilingual card under a finished turn: every cached translation of that
 * turn. Rendered through the turnTail slot so it sits in flow, above the
 * native action row.
 */
function TranslationTail(props) {
  const sessionId = props.sessionId;
  const turn = props.turn;
  const toolbar = useToolbar(sessionId);
  const state = toolbar && toolbar.state ? toolbar.state : null;
  const translations = state ? state.translations : null;
  const [collapsed, setCollapsed] = React.useState({});
  const entries = translationsForTurn(translations, turn);
  if (entries.length === 0) return null;

  const cards = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    for (const lang in entry.langs) {
      const value = entry.langs[lang];
      if (!value || !value.text) continue;
      const key = entry.seq + ':' + lang;
      const isCollapsed = collapsed[key] === true;
      cards.push(h('div', { key: key, className: 'mtt-trans-card' },
        h('div', { className: 'mtt-trans-head' },
          h('span', { className: 'mtt-trans-badge' }, t('translationBadge')),
          h('span', { className: 'mtt-trans-lang' }, langLabel(lang)),
          h('span', { className: 'mtt-trans-role' }, entry.role === 'user' ? t('fromUser') : t('fromAssistant')),
          value.model ? h('span', { className: 'mtt-trans-model' }, value.model) : null,
          h('button', {
            type: 'button', className: 'mtt-trans-toggle',
            onClick: function () {
              setCollapsed(function (prev) {
                const next = Object.assign({}, prev);
                next[key] = !isCollapsed;
                return next;
              });
            },
          }, isCollapsed ? t('expand') : t('collapse')),
          h('button', {
            type: 'button', className: 'mtt-trans-toggle',
            onClick: function () {
              const g = realGlobal();
              try { if (g && g.navigator && g.navigator.clipboard) g.navigator.clipboard.writeText(value.text); } catch (e) {}
            },
          }, t('copy'))),
        isCollapsed ? null : h('div', { className: 'mtt-trans-body' }, value.text)));
    }
  }
  if (cards.length === 0) return null;
  return h('div', { className: 'mtt-trans-wrap' }, cards);
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

/** Settings section: translation target language, model, stop-on-edit. */
function SettingsPanel(props) {
  const prefs = usePrefs();
  const [catalog, setCatalog] = React.useState(null);
  const [error, setError] = React.useState(null);

  React.useEffect(function () {
    let alive = true;
    fetchModels().then(function (value) {
      if (alive) setCatalog(value);
    }).catch(function (e) {
      if (alive) setError(String((e && e.message) || e));
    });
    return function () { alive = false; };
  }, []);

  const modelOptions = [];
  if (catalog && Array.isArray(catalog.providers)) {
    for (let i = 0; i < catalog.providers.length; i++) {
      const provider = catalog.providers[i];
      const models = provider.models || [];
      for (let j = 0; j < models.length; j++) {
        const model = models[j];
        modelOptions.push({
          key: provider.id + '/' + model.id,
          label: provider.name + ' · ' + model.name,
          value: { provider: provider.id, model: model.id, name: model.name },
        });
      }
    }
  }
  const currentModel = prefs.translateModel
    ? (prefs.translateModel.provider + '/' + prefs.translateModel.model)
    : '';

  return h('div', { className: 'mtt-settings' },
    h('div', { className: 'mtt-settings-title' }, t('nav')),
    h('div', { className: 'mtt-settings-desc' }, t('settingsDesc')),
    h('label', { className: 'mtt-field' },
      h('span', { className: 'mtt-field-label' }, t('targetLang')),
      h('select', {
        className: 'mtt-select',
        value: prefs.lang,
        onChange: function (e) { prefsStore.set({ lang: e.target.value }); },
      }, LANGS.map(function (lang) { return h('option', { key: lang.id, value: lang.id }, lang.label); }))),
    h('label', { className: 'mtt-field' },
      h('span', { className: 'mtt-field-label' }, t('translateModel')),
      h('select', {
        className: 'mtt-select',
        value: currentModel,
        onChange: function (e) {
          const value = e.target.value;
          if (!value) { prefsStore.set({ translateModel: null }); return; }
          const found = modelOptions.find(function (option) { return option.key === value; });
          if (found) prefsStore.set({ translateModel: found.value });
        },
      },
        h('option', { value: '' }, t('sameAsTurn')),
        modelOptions.map(function (option) { return h('option', { key: option.key, value: option.key }, option.label); }))),
    h('div', { className: 'mtt-settings-hint' }, t('translateModelHint')),
    h('label', { className: 'mtt-check' },
      h('input', {
        type: 'checkbox', checked: prefs.stopPrevious,
        onChange: function (e) { prefsStore.set({ stopPrevious: e.target.checked }); },
      }),
      h('span', null, t('stopPrevious'))),
    h(ErrorChip, { error: error }),
    h('div', { className: 'mtt-settings-foot' }, t('settingsFoot')));
}

/* ----------------------------------------------------------------- CSS -- */

const CSS = [
  '.mtt-row{display:flex;flex-direction:column;align-items:flex-end;gap:2px;margin:2px 0;min-width:0}',
  '.mtt-row.mtt-editing{align-items:stretch}',
  '.mtt-line{display:flex;justify-content:flex-end;width:100%;min-width:0}',
  '.mtt-bubble{max-width:76%;background:var(--dsw-alias-interactive-bg,rgba(0,0,0,.05));border-radius:16px 16px 4px 16px;padding:10px 14px;color:inherit;font:inherit;min-width:0}',
  '.mtt-text{white-space:pre-wrap;word-break:break-word}',
  // Action rows mirror DSH's own MessageIconActions.module.css exactly:
  // 28px hit box (plus the user's content-font delta), 6px padding, 8px gap,
  // 17px glyphs in a clock="end" row, tertiary label colour.
  '.mtt-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;height:calc(28px + var(--dsh-content-font-delta,0px));opacity:0;transition:opacity 80ms}',
  '.mtt-row:hover .mtt-actions,.mtt-row:focus-within .mtt-actions{opacity:1}',
  '.mtt-toolbar{display:inline-flex;align-items:center;gap:8px;position:relative}',
  '.mtt-act{background:0 0;border:0;padding:6px;width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm,6px);color:var(--dsw-alias-label-tertiary,#9ca3af);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;font:inherit}',
  '.mtt-act svg{width:calc(17px + var(--dsh-content-font-delta,0px));height:calc(17px + var(--dsh-content-font-delta,0px))}',
  '.mtt-act:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#6b7280)}',
  '.mtt-act:disabled{opacity:.4;cursor:default}',
  '.mtt-act:disabled:hover{background:0 0;color:var(--dsw-alias-label-tertiary,#9ca3af)}',
  '.mtt-act-on{color:var(--dsw-alias-label-secondary,#6b7280);background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.06))}',
  '.mtt-dots{font-size:13px;letter-spacing:1px}',
  '.mtt-ring{display:inline-flex;align-items:center;gap:1px;font-size:11px;color:var(--dsw-alias-label-tertiary,#9ca3af);margin-right:0}',
  '.mtt-ring-btn{background:none;border:0;cursor:pointer;padding:0 3px;font-size:13px;color:inherit}',
  '.mtt-ring-btn:disabled{opacity:.3}',
  '.mtt-chip{font-size:11px;padding:1px 6px;border-radius:8px;background:rgba(37,99,235,.1);color:#2563eb;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.mtt-menu-wrap{position:relative;display:inline-flex}',
  '.mtt-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:60;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.12));border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.14);padding:6px;min-width:150px;max-height:min(320px,45vh);overflow:auto;text-align:left}',
  // Flipped above the button when the row sits at the bottom of the window
  // (the last message), where the composer would otherwise cover the popover.
  '.mtt-up .mtt-pop{top:auto;bottom:calc(100% + 6px)}',
  '.mtt-pop-wide{min-width:260px}',
  '.mtt-pop-trans{min-width:260px;max-width:420px}',
  '.mtt-pop-confirm{min-width:240px}',
  '.mtt-pop-title{font-size:11px;color:#6b7280;padding:4px 8px}',
  '.mtt-pop-group{font-size:10px;color:#9ca3af;padding:6px 8px 2px}',
  '.mtt-pop-note{font-size:11px;color:#9ca3af;padding:4px 8px}',
  '.mtt-pop-item{display:block;width:100%;text-align:left;background:none;border:0;padding:6px 8px;border-radius:6px;cursor:pointer;font:inherit;color:inherit}',
  '.mtt-pop-item:hover{background:rgba(0,0,0,.05)}',
  '.mtt-pop-actions{display:flex;gap:6px;justify-content:flex-end;padding:4px}',
  '.mtt-btn{border:1px solid rgba(0,0,0,.14);background:var(--dsw-alias-bg-elevated,#fff);border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;color:inherit;font-family:inherit}',
  '.mtt-btn-primary{background:#2563eb;border-color:#2563eb;color:#fff}',
  '.mtt-btn-danger{background:#dc2626;border-color:#dc2626;color:#fff}',
  '.mtt-btn-small{padding:2px 8px;font-size:11px}',
  '.mtt-btn:disabled{opacity:.5;cursor:default}',
  '.mtt-editor{width:100%;display:flex;flex-direction:column;gap:6px;background:var(--dsw-alias-bg-elevated,#fff);border:1px solid rgba(0,0,0,.16);border-radius:12px;padding:10px}',
  '.mtt-textarea{width:100%;min-height:64px;resize:vertical;border:0;outline:none;background:transparent;font:inherit;color:inherit}',
  '.mtt-editor-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end}',
  '.mtt-hint{font-size:11px;color:#9ca3af}',
  '.mtt-error{font-size:11px;color:#dc2626;margin-top:2px;max-width:76%;text-align:right;white-space:pre-wrap;align-self:flex-end}',
  '.mtt-notice{font-size:11px;color:#059669;margin-top:2px;align-self:flex-end}',
  '.mtt-toolbar{display:inline-flex;align-items:center;gap:8px;position:relative}',
  '.mtt-trans-wrap{margin:6px 0 2px;display:flex;flex-direction:column;gap:6px;width:100%}',
  '.mtt-trans-card{border:1px solid rgba(16,185,129,.35);background:rgba(16,185,129,.06);border-radius:10px;padding:8px 10px}',
  '.mtt-trans-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;color:#059669;margin-bottom:4px}',
  '.mtt-trans-badge{font-weight:600}',
  '.mtt-trans-lang{background:rgba(16,185,129,.15);padding:0 6px;border-radius:6px}',
  '.mtt-trans-role,.mtt-trans-model{color:#6b7280}',
  '.mtt-trans-toggle{margin-left:auto;background:none;border:0;color:#6b7280;cursor:pointer;font-size:11px;font-family:inherit}',
  '.mtt-trans-toggle+.mtt-trans-toggle{margin-left:8px}',
  '.mtt-trans-body{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:1.55;color:inherit}',
  '.mtt-view{padding:16px;display:flex;flex-direction:column;gap:10px;overflow:auto;height:100%;min-width:0}',
  '.mtt-view-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}',
  '.mtt-view-title{font-weight:600;font-size:14px}',
  '.mtt-view-hint{font-size:11px;color:#9ca3af;margin-top:2px}',
  '.mtt-view-empty{color:#9ca3af;align-items:center;justify-content:center}',
  '.mtt-node{display:flex;flex-direction:column;gap:4px;align-items:flex-start}',
  '.mtt-node-card{text-align:left;display:flex;flex-direction:column;gap:3px;border:1px solid rgba(0,0,0,.08);background:var(--dsw-alias-bg-elevated,#fff);border-radius:10px;padding:8px 10px;cursor:pointer;font:inherit;color:inherit;max-width:640px;min-width:220px}',
  '.mtt-node-card:hover{border-color:rgba(37,99,235,.4)}',
  '.mtt-node-card:disabled{opacity:.55;cursor:default}',
  '.mtt-node-current .mtt-node-card{border-color:#2563eb;box-shadow:0 0 0 1px #2563eb inset}',
  '.mtt-node-deleted .mtt-node-card{opacity:.5;text-decoration:line-through}',
  '.mtt-node-head{display:flex;gap:6px;align-items:center;flex-wrap:wrap;font-size:12px}',
  '.mtt-node-title{font-weight:600}',
  '.mtt-node-tag{font-size:10px;padding:0 6px;border-radius:6px;background:rgba(0,0,0,.06);color:#6b7280}',
  '.mtt-node-tag-current{background:rgba(37,99,235,.12);color:#2563eb}',
  '.mtt-node-tag-danger{background:rgba(220,38,38,.12);color:#dc2626}',
  '.mtt-node-time{margin-left:auto;color:#9ca3af;font-size:10px}',
  '.mtt-node-text{font-size:12px;color:#6b7280;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:600px}',
  '.mtt-empty{color:#9ca3af;font-size:12px;padding:24px 0;text-align:center}',
  '.mtt-settings{display:flex;flex-direction:column;gap:12px;padding:16px;max-width:560px}',
  '.mtt-settings-title{font-size:15px;font-weight:600}',
  '.mtt-settings-desc{font-size:12px;color:#6b7280}',
  '.mtt-field{display:flex;flex-direction:column;gap:4px}',
  '.mtt-field-label{font-size:12px;color:#374151}',
  '.mtt-select{padding:6px 8px;border-radius:8px;border:1px solid rgba(0,0,0,.15);background:var(--dsw-alias-bg-elevated,#fff);color:inherit;font:inherit;max-width:100%}',
  '.mtt-check{display:flex;gap:8px;align-items:center;font-size:12px}',
  '.mtt-settings-hint{font-size:11px;color:#9ca3af}',
  '.mtt-settings-foot{font-size:11px;color:#9ca3af;border-top:1px solid rgba(0,0,0,.08);padding-top:8px}',
].join('\n');

/* ------------------------------------------------------------------ I18N -- */

const I18N = {
  en: {
    nav: 'Message Toolbar',
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
    restore: 'Restore',
    copy: 'Copy',
    copied: 'Copied',
    edit: 'Edit message',
    regenerate: 'Regenerate this turn',
    translate: 'Translate',
    translateTo: 'Translate into…',
    translated: 'Translated',
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
    switchModel: 'Switch model for this turn',
    switchModelPick: 'Pick a model — its answer becomes a new card',
    noModels: 'No models available',
    messageNotIndexed: 'This message is not indexed yet; reopen the conversation to retry.',
    switched: 'Answering with {name}…',
    deleteCard: 'Delete this answer card',
    deleteCardConfirm: 'Delete this answer card? You can restore it from the Versions view.',
    delete: 'Delete',
    deletedCard: 'Card deleted',
    fromUser: 'your message',
    fromAssistant: 'the answer',
    translationBadge: 'Translation',
    expand: 'Expand',
    collapse: 'Collapse',
    targetLang: 'Translation language',
    translateModel: 'Translation model',
    sameAsTurn: 'Same as the turn (default)',
    translateModelHint: 'When unset, translations reuse the model that answered the turn.',
    stopPrevious: 'Stop the running reply when I edit or regenerate',
    settingsDesc: 'Controls for the message toolbar.',
    settingsFoot: 'Translated text is cached on the host under ~/.dsh/message-toolbar/state.json.',
  },
  zh: {
    nav: '消息工具栏',
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
    restore: '恢复',
    copy: '复制',
    copied: '已复制',
    edit: '编辑消息',
    regenerate: '重新生成这一轮',
    translate: '翻译',
    translateTo: '翻译成…',
    translated: '已翻译',
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
    switchModel: '切换模型重新回答',
    switchModelPick: '选择模型——它的回答会成为一个新卡片',
    noModels: '暂无可用模型',
    messageNotIndexed: '这条消息还没有建立索引，请重新打开会话再试。',
    switched: '正在用 {name} 回答…',
    deleteCard: '删除这张回答卡片',
    deleteCardConfirm: '删除这张回答卡片？可以在“版本”视图里恢复。',
    delete: '删除',
    deletedCard: '卡片已删除',
    fromUser: '你的消息',
    fromAssistant: '回答',
    translationBadge: '译文',
    expand: '展开',
    collapse: '收起',
    targetLang: '翻译语言',
    translateModel: '翻译模型',
    sameAsTurn: '跟随本轮模型（默认）',
    translateModelHint: '未指定时，翻译复用回答本轮的模型。',
    stopPrevious: '编辑或重新生成时中止正在生成的回复',
    settingsDesc: '消息工具栏的相关设置。',
    settingsFoot: '译文缓存在主机端 ~/.dsh/message-toolbar/state.json。',
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
    ctx.effect(function () {
      if (sessions && sessions.list && typeof sessions.list.subscribe === 'function') {
        return sessions.list.subscribe(function () { store.invalidate(); });
      }
      return undefined;
    });

    try {
      const locale = ctx.get('locale');
      if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
        ctx.effect(function () { return locale.register(I18N_NS, I18N); });
        const bound = locale.bind(I18N_NS);
        if (typeof bound === 'function') t = bound;
      }
    } catch (e) {
      // Fall back to the built-in dictionary.
    }

    slots.inject('settings.section', function () {
      try {
        return slots.register(
          { name: 'settings.section', id: 'message-toolbar', order: SETTINGS_ORDER, label: function () { return t('nav'); } },
          SettingsPanel);
      } catch (e) {
        console.warn('[dsh-message-toolbar] Failed to register the settings section.', e);
        return function () {};
      }
    });

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

    slots.inject('conversation.chat.turnTail', function () {
      try {
        return slots.register(
          {
            name: 'conversation.chat.turnTail',
            id: 'message-toolbar-translations',
            order: 5,
            locale: I18N_NS,
            inject: function (sessionId) { return { sessionId: sessionId }; },
          },
          TranslationTail);
      } catch (e) {
        console.warn('[dsh-message-toolbar] Failed to register the translation tail.', e);
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
