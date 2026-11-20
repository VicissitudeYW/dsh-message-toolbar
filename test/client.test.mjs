// Client harness for 1.6.0: dropping files into the question editor.
//
// Loads the BUILT bundle (lib/client.js) the way DSH does, mounts the question
// row the plugin decorates the app's row with, and drives the editor: open it,
// drop a file, send, then read the request the plugin made.

import fs from 'node:fs';

const SOURCE_URL = new URL('../lib/client.js', import.meta.url);

const SOURCE = fs.readFileSync(SOURCE_URL, 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { console.log('ok   ' + label); return; }
  failures += 1;
  console.log('FAIL ' + label + '\n  actual:   ' + a + '\n  expected: ' + e);
}

/* ------------------------------------------------------------- DOM stubs -- */

function makeElement(tag) {
  const node = {
    tagName: String(tag || 'div').toUpperCase(),
    className: '',
    style: {},
    dataset: {},
    children: [],
    attrs: {},
    textContent: '',
    isConnected: true,
    removed: false,
    appendChild(child) { this.children.push(child); return child; },
    append(child) { return this.appendChild(child); },
    insertBefore(child) { return this.appendChild(child); },
    removeChild(child) { this.children = this.children.filter((c) => c !== child); return child; },
    remove() { this.removed = true; },
    setAttribute(key, value) { this.attrs[key] = String(value); },
    getAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key) ? this.attrs[key] : null; },
    removeAttribute(key) { delete this.attrs[key]; },
    hasAttribute(key) { return Object.prototype.hasOwnProperty.call(this.attrs, key); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; },
  };
  return node;
}

const styleTags = [];
globalThis.document = {
  documentElement: { lang: 'en' },
  head: { appendChild(tag) { tag.appended = true; } },
  body: makeElement('body'),
  createElement(tag) {
    const node = makeElement(tag);
    if (node.tagName === 'STYLE') {
      node.selector = 'style[data-plugin="' + 'dsh-message-toolbar' + '"]';
      styleTags.push(node);
    }
    return node;
  },
  createTextNode(text) { return { text }; },
  querySelector(selector) { return styleTags.find((tag) => tag.selector === selector) ?? null; },
  querySelectorAll() { return []; },
  addEventListener() {},
  removeEventListener() {},
};

/* ----------------------------------------------------------- React stub -- */

// A one-pass renderer with real state: hooks are stored per component call site
// (function name + ordinal among that function's calls), so a rerender keeps the
// state of every component that is still in the tree.
const hookStore = new Map();
let activeSlots = null;
let hookIndex = 0;
let pending = false;

function freshMount() {
  // Each case starts from a component that has never rendered: hook state is
  // kept per component name, so without this a case would inherit the menu or
  // the busy flag of the case before it.
  hookStore.clear();
}

function slotKey(fn, ordinal) {
  return (fn.name || 'anon') + ':' + String(ordinal);
}

class Component {
  constructor(props) { this.props = props || {}; this.state = undefined; }
  setState(patch) {
    const next = typeof patch === 'function' ? patch(this.state, this.props) : patch;
    this.state = Object.assign({}, this.state, next);
    pending = true;
  }
  forceUpdate() { pending = true; }
}

const React = {
  Component,
  createElement(type, props, ...kids) {
    const merged = Object.assign({}, props);
    if (kids.length === 1) merged.children = kids[0];
    else if (kids.length > 1) merged.children = kids;
    return { type, props: merged };
  },
  Fragment: '__fragment__',
  memo(fn) { return { $$memo: true, fn }; },
  useState(init) {
    const at = hookIndex++;
    if (activeSlots[at] === undefined) activeSlots[at] = { value: typeof init === 'function' ? init() : init };
    const cell = activeSlots[at];
    return [cell.value, function (next) {
      cell.value = typeof next === 'function' ? next(cell.value) : next;
      pending = true;
    }];
  },
  useReducer(reducer, init) {
    const at = hookIndex++;
    if (activeSlots[at] === undefined) activeSlots[at] = { value: init };
    const cell = activeSlots[at];
    return [cell.value, function (action) {
      cell.value = reducer(cell.value, action);
      pending = true;
    }];
  },
  useRef(init) {
    const at = hookIndex++;
    if (activeSlots[at] === undefined) activeSlots[at] = { value: { current: init === undefined ? null : init } };
    return activeSlots[at].value;
  },
  useEffect(fn, deps) {
    const at = hookIndex++;
    const previous = activeSlots[at];
    const same = previous !== undefined && Array.isArray(deps) && Array.isArray(previous.deps)
      && deps.length === previous.deps.length
      && deps.every((value, index) => value === previous.deps[index]);
    if (same) return;
    activeSlots[at] = { deps: deps };
    effects.push(fn);
  },
  useMemo(fn) { return fn(); },
  useCallback(fn) { return fn; },
  useLayoutEffect(fn, deps) { React.useEffect(fn, deps); },
};

let effects = [];
const classStore = new Map();
let seqs = new Map();

function expand(node, out) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) { for (const child of node) expand(child, out); return; }
  if (typeof node === 'string' || typeof node === 'number') { out.push({ type: '#text', text: String(node), props: {} }); return; }
  if (typeof node !== 'object') return;

  let type = node.type;
  if (type === React.Fragment || type === '__fragment__') { expand(node.props.children, out); return; }
  if (type && typeof type === 'object' && type.$$memo) type = type.fn;

  if (typeof type === 'function' && type.prototype && type.prototype instanceof Component) {
    const name = type.name || 'anon';
    const ordinal = seqs.get(name) || 0;
    seqs.set(name, ordinal + 1);
    const key = 'class:' + slotKey(type, ordinal);
    if (!classStore.has(key)) classStore.set(key, new type(node.props));
    expand(classStore.get(key).render(), out);
    return;
  }

  if (typeof type === 'function') {
    const name = type.name || 'anon';
    const ordinal = seqs.get(name) || 0;
    seqs.set(name, ordinal + 1);
    const key = slotKey(type, ordinal);
    if (!hookStore.has(key)) hookStore.set(key, []);
    const previous = activeSlots;
    const previousIndex = hookIndex;
    activeSlots = hookStore.get(key);
    hookIndex = 0;
    let produced;
    try {
      produced = type(node.props);
    } finally {
      const used = hookIndex;
      activeSlots = previous;
      hookIndex = previousIndex;
      if (used === 0) hookStore.get(key).length = 0;
    }
    expand(produced, out);
    return;
  }

  const element = { type: String(type), props: node.props || {}, children: [] };
  out.push(element);
  expand((node.props || {}).children, element.children);
}

function render(rootNode) {
  for (let pass = 0; pass < 24; pass += 1) {
    pending = false;
    effects = [];
    seqs = new Map();
    const out = [];
    expand(rootNode, out);
    const queued = effects;
    effects = [];
    for (const fn of queued) { try { fn(); } catch (e) {} }
    if (!pending) return out;
  }
  return [];
}

function walk(nodes, visit) {
  for (const node of nodes || []) { visit(node); walk(node.children, visit); }
}

function findAll(nodes, predicate) {
  const hits = [];
  walk(nodes, (node) => { if (predicate(node)) hits.push(node); });
  return hits;
}

function textOf(node) {
  if (node.type === '#text') return node.text;
  return (node.children || []).map(textOf).join('');
}

/* --------------------------------------------------------- window + load -- */

const calls = [];
// Text the plugin handed to the clipboard, in order.
const clipped = [];
let captured = null;

const uploadResponse = {
  ok: true,
  value: { receiptId: 'receipt-1', file: { attachmentId: 'att-9', name: 'notes.pdf', bytes: 2048 } },
};
const imageResponse = {
  ok: true,
  value: { receiptId: 'receipt-2', image: { attachmentId: 'img-1', width: 640, height: 480 } },
};

const statePayload = {
  sessionId: 'session-x',
  versions: [],
  turns: [
    { turn: 1, text: 'a question', time: 1, answered: true },
    { turn: 2, text: 'a deleted question', time: 2, answered: true },
    { turn: 3, text: 'another question', time: 3, answered: true },
    { turn: 4, text: 'a question', time: 4, answered: true },
    { turn: 5, text: 'the last question', time: 5, answered: true },
    // Turn 6 is the same question answered again, and that second answer failed:
    // the app draws no action row for a turn without an answer, so the card has to.
    { turn: 6, text: 'the last question', time: 6, answered: false, reason: 'error' },
    // Turn 7 references a file — the app turns `@path` into a highlighted chip.
    // Turn 8 is markdown with no reference, which is the only case this plugin
    // draws its own body for.
    { turn: 7, text: 'the report is here @C:\\workspace\\report.ips', time: 7, answered: true },
    { turn: 8, text: '## a heading\n\n- one\n- two', time: 8, answered: true },
  ],
  answers: { 1: { active: 'v-1', items: [{ id: 'v-1', kind: 'model', text: '另一个模型写的回答', at: 1 }] } },
  // Turn 2 was deleted and turn 4 is the replay of the question asked in turn 1.
  hidden: { turns: [2], answers: [], prompts: [4] },
  shown: {},
  origins: {},
  prompts: {},
  // Two answers to the last question: the original turn, and the one the reader
  // asked again in turn 6. Each remembers the model that wrote it.
  runs: {
    5: {
      turns: [5, 6],
      active: 6,
      models: { 6: { provider: 'p', model: 'deepseek-flash' } },
    },
  },
  model: null,
};

const fetchStub = async function (url, init) {
  calls.push({ url: String(url), init: init || {} });
  if (String(url).indexOf('/api/session/uploadFileBinary') === 0) {
    const body = String(url).indexOf('mediaType=') === -1 ? uploadResponse : imageResponse;
    return { ok: true, status: 200, json: async () => body };
  }
  if ((init && init.method) === 'POST') {
    let sent = {};
    try { sent = JSON.parse(String(init.body)); } catch (e) {}
    if (sent.action === 'prompt-save') {
      const entry = { text: sent.text, at: 1 };
      if (Array.isArray(sent.files) && sent.files.length > 0) entry.files = sent.files;
      // The save is durable: a later GET has to answer with it too.
      statePayload.prompts[String(sent.turn)] = entry;
      return { ok: true, status: 200, json: async () => ({ prompts: statePayload.prompts }) };
    }
    // The real host answers a run with its runs only: it never sends an empty
    // prompt table, which would read as "this question has no attachments".
    return { ok: true, status: 200, json: async () => ({ runs: {} }) };
  }
  return { ok: true, status: 200, json: async () => statePayload };
};

const windowStub = {
  fetch: fetchStub,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: { language: 'en', languages: ['en'], clipboard: { writeText: async (text) => { clipped.push(String(text)); } } },
  addEventListener: () => {},
  removeEventListener: () => {},
  setTimeout: (fn) => setTimeout(fn, 0),
  clearTimeout: (id) => clearTimeout(id),
  innerHeight: 900,
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
};
windowStub.window = windowStub;
windowStub.__ModuleLoader__ = { load(value) { captured = value; } };
globalThis.window = windowStub;
globalThis.MutationObserver = windowStub.MutationObserver;

globalThis.__ModuleLoader__ = windowStub.__ModuleLoader__;

URL.createObjectURL = function () { return 'blob:preview-1'; };

const ReactDom = {
  createPortal(node) { return node; },
  createRoot(container) {
    const slot = { element: null };
    ReactDom.roots.push(slot);
    return {
      render(element) { slot.element = element; ReactDom.last = element; },
      unmount() {},
    };
  },
};
ReactDom.last = null;
// Every root the plugin mounted, in mount order: the row's own, and the one that
// draws the question's attachments above the bubble.
ReactDom.roots = [];

const primitives = {
  // The menu is recorded rather than drawn: what matters is which rows the plugin
  // hands it, which one is ticked, and how it asked to be placed. The anchor is
  // rendered as a child because the real menu draws it as its trigger — without it
  // the count would be invisible to the test.
  Menu(props) {
    return React.createElement('div', {
      'data-native-menu': '',
      'data-count': String((props.items || []).length),
      'data-open': props.open === true ? '1' : '0',
      'data-items': JSON.stringify((props.items || []).map((item) => (item.type ? item.type + ':' + item.id : item.id + '=' + item.label))),
      'data-selected': props.selectedId === undefined ? '' : String(props.selectedId),
      'data-selection': props.selection === undefined ? '' : String(props.selection),
      'data-side': props.side === undefined ? '' : String(props.side),
      onSelect: props.onSelect,
      onClose: props.onClose,
    }, props.anchor === undefined ? null : props.anchor);
  },
  FileTypeIcon(props) { return React.createElement('span', { 'data-file-icon': props.path }); },
  fileExtension(name) { const dot = String(name).lastIndexOf('.'); return dot < 0 ? '' : String(name).slice(dot + 1); },
  fileSizeText(bytes) { return bytes < 1024 ? bytes + 'B' : (bytes / 1024).toFixed(1) + 'KB'; },
  Toast(props) { return React.createElement('div', { className: 'native-toast' }, props.text); },
  MarkdownText: { $$memo: true, fn: (props) => React.createElement('div', { className: 'native-md' }, props.text) },
  TextShimmer: { $$memo: true, fn: (props) => React.createElement('span', {}, props.children) },
};

// Load the built bundle exactly as the shell does.
new Function('window', 'self', 'globalThis', SOURCE)(windowStub, windowStub, globalThis);
const factory = captured.factory;
const module = factory(function require(name) {
  if (name === 'react') return React;
  if (name === 'react-dom') return ReactDom;
  if (name === 'react-dom/client') return { createRoot: ReactDom.createRoot };
  if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
  throw new Error('unexpected require: ' + name);
});

/* ------------------------------------------------------------- mount row -- */

const registered = [];
const slots = {
  register(descriptor, component) { registered.push({ descriptor, component }); return () => {}; },
  inject(name, factoryFn) { const disposer = factoryFn(); return disposer; },
};

const rowStub = makeElement('div');
rowStub.attrs['data-chat-turn'] = '1';
const stackStub = makeElement('div');
stackStub.className = 'abc_userStack';
const bubbleStub = makeElement('div');
bubbleStub.className = 'abc_bubble';
rowStub.querySelector = (selector) => (selector.indexOf('_userStack') !== -1 ? stackStub : selector.indexOf('_bubble') !== -1 ? bubbleStub : null);
document.querySelectorAll = (selector) => (String(selector).indexOf('data-chat-flow-kind="user"') !== -1 ? [rowStub] : []);

// A notice the app could not place in a turn: "context injected" and "asked to
// keep going" are rows of their own, and the frame only writes `data-chat-turn`
// when the node's location resolved. It sits above turn 2, which the fixture has
// deleted, so it has to leave with that turn.
function flowRow(kind, turn) {
  const row = makeElement('div');
  row.attrs['data-chat-flow-kind'] = kind;
  if (turn !== undefined) row.attrs['data-chat-turn'] = String(turn);
  return row;
}
// Turn 2 is deleted in the fixture, turn 3 is not.
const turnTwoRow = flowRow('assistant-step', 2);
// "Context injected" trailing the turn it was injected into: it belongs to turn 2.
const trailingNotice = flowRow('context');
// "Asked to keep going" opens the turn below it, and turn 3 is still there.
const openingNotice = flowRow('turn-trigger');
const turnThreeRow = flowRow('assistant-step', 3);
// The same notice in front of a turn that is gone has to leave with it.
const openingGone = flowRow('turn-trigger');
const turnTwoAgain = flowRow('assistant-step', 2);
document.querySelectorAll = (selector) => {
  const text = String(selector);
  if (text.indexOf('data-chat-flow-kind="user"') !== -1) return [rowStub];
  if (text === '[data-chat-flow-kind]') {
    return [turnTwoRow, trailingNotice, openingNotice, turnThreeRow, openingGone, turnTwoAgain];
  }
  return [];
};

// The host's projection store: one face per key, exactly as the app's own
// `ProjectionValueStore` answers them — a class instance whose `faceOf` lives on
// the prototype, because that is where the plugin's filter is installed.
const outlineValue = [1, 2, 3, 4, 5].map((turn) => ({
  turn: turn, seq: turn * 10, prompt: 'p' + String(turn), response: 'r' + String(turn),
}));

class ProjectionStore {
  constructor() { this.faces = new Map(); }
  faceOf(key) {
    if (!this.faces.has(key)) {
      this.faces.set(key, {
        getSnapshot: () => (key === 'turnOutline' ? outlineValue : undefined),
        subscribe: () => () => {},
      });
    }
    return this.faces.get(key);
  }
  get(key) { return key === 'turnOutline' ? outlineValue : undefined; }
  values() { return { turnOutline: outlineValue }; }
}

const projection = new ProjectionStore();

const sessionsStub = {
  list: { getSnapshot: () => ({ byId: { 'session-x': { id: 'session-x', running: false } } }), subscribe: () => () => {} },
  // The app reaches a session's projections through its binding, never through a
  // store lookup on the service: this is the shape the filter has to hook.
  binding: () => ({ session: { id: 'session-x', projections: projection } }),
};

// The chat target the rail reads: its items are the loaded Turns, and the app
// positions one mark per item in list order.
const navItems = [1, 2, 3, 4, 5].map((turn) => ({
  turn: turn, anchorKey: 'k' + String(turn), prompt: 'p' + String(turn), response: 'r' + String(turn),
}));
const chatSnapshot = {
  order: [], nodes: {}, locations: {}, timeline: {}, legacy: {},
  navigation: { items: () => navItems },
};
const chatTarget = { getSnapshot: () => chatSnapshot, subscribe: () => () => {} };
const uiConversationStub = {
  binding: () => ({ target: (name) => (name === 'chat' ? chatTarget : null) }),
};

const ctx = {
  effect(fn) { try { fn(); } catch (e) { console.log('effect threw: ' + e.message); } return () => {}; },
  get(name) {
    if (name === 'slots') return slots;
    if (name === 'sessions') return sessionsStub;
    if (name === 'uiConversation') return uiConversationStub;
    if (name === 'uiWorkspace') return { openSession: () => {} };
    if (name === 'locale') return { register: () => () => {}, subscribe: () => () => {}, getLocale: () => ({ active: 'en' }) };
    return undefined;
  },
  inject(names, fn) { fn(this); },
};

module.apply(ctx);

const rowElement = ReactDom.last;
if (rowElement === null) { console.log('FAIL the row was never decorated'); process.exit(1); }
check('the app row is decorated with the plugin row', typeof rowElement.type, 'function');

// Turn 9 asked a question that was answered twice, the second answer (turn 10)
// failed, and the reader deleted it: the group is down to the answer in turn 9,
// which is the one that has to keep its action row.
statePayload.turns.push(
  { turn: 9, text: 'a question', time: 9, answered: false },
  { turn: 10, text: 'a question', time: 10, answered: false, reason: 'error' },
);
statePayload.runs[9] = { turns: [9, 10], active: 10, models: {} };
statePayload.hidden.answers.push(10);
// Turn 11 is a replayed prompt whose turn did real work (tools and thinking), so
// its process group has something to list and must not be dropped wholesale.
statePayload.turns.push({ turn: 11, text: 'an edited question', time: 11, answered: true, tools: 2, reasoning: true });
statePayload.hidden.prompts.push(11);

const mount = { type: rowElement.type, props: Object.assign({}, rowElement.props, { sessionId: 'session-x', turn: 1 }) };
let tree = render(mount);
// The state of the turn arrives through the store, which loads it asynchronously.
await new Promise((resolve) => setTimeout(resolve, 10));
tree = render(mount);

// 0. deleting an answer does not strand the one that is left
//
// A group lists its members and names the one on screen. If a deleted answer
// stayed in that list, `active` could still name it — and a card stands down for
// every turn that is not the active one, so the surviving answer kept its rows
// and lost its toolbar, with nothing on screen saying why.
{
  const answersEntry = registered.filter((entry) => entry.descriptor.id === 'message-toolbar-answers')[0];
  const props = Object.assign({}, answersEntry.descriptor.inject('session-x'), { turn: 9, seq: 90 });
  const card = render({ type: answersEntry.component, props });
  const row = findAll(card, (node) => node.props && node.props.className === 'mtt-tail-actions')[0];
  check('the surviving answer keeps its action row', row !== undefined, true);
  const num = findAll(card, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('mtt-ring-num') !== -1)[0];
  check('the deleted answer is not counted any more', num, undefined);
}

// 0b. a turn whose answer never arrived always keeps a toolbar
//
// The app draws its action row only for a turn that produced an answer, so a
// failed answer has none — and the payload can lag behind a turn that opened a
// moment ago. The card therefore believes the page: no native row, draw ours.
{
  const answersEntry = registered.filter((entry) => entry.descriptor.id === 'message-toolbar-answers')[0];
  const savedQuery = document.querySelectorAll;
  const tailRow = makeElement('div');
  const mountTail = (hasNativeRow) => {
    tailRow.querySelector = () => (hasNativeRow ? makeElement('button') : null);
    document.querySelectorAll = (selector) => (String(selector).indexOf('turn-tail') !== -1 ? [tailRow] : savedQuery(selector));
  };
  const props = Object.assign({}, answersEntry.descriptor.inject('session-x'), { turn: 42, seq: 420 });

  mountTail(false);
  const withoutRow = render({ type: answersEntry.component, props });
  document.querySelectorAll = savedQuery;
  const drawn = findAll(withoutRow, (node) => node.props && node.props.className === 'mtt-tail-actions')[0];
  check('a failed answer still gets the row', drawn !== undefined, true);

  // ...and a turn the app *did* draw a row for is left alone, so a healthy
  // answer never grows a second toolbar.
  mountTail(true);
  const withRow = render({ type: answersEntry.component, props });
  document.querySelectorAll = savedQuery;
  const duplicate = findAll(withRow, (node) => node.props && node.props.className === 'mtt-tail-actions')[0];
  check('an answered turn keeps only the app row', duplicate, undefined);
}

// 1. the edit button opens the editor
const editButton = findAll(tree, (node) => node.props && node.props['data-mtt'] === 'edit')[0];
check('the row has an edit button', editButton !== undefined, true);
editButton.props.onClick();
tree = render(mount);
const editor = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('mtt-answer-edit-prompt') !== -1)[0];
check('the editor opened', editor !== undefined, true);
const area = findAll(tree, (node) => node.props && node.props.className === 'mtt-answer-edit-input')[0];
check('the editor holds the question', area !== undefined ? area.props.value : null, 'a question');
check('the editor accepts drops', typeof editor.props.onDrop, 'function');
check('the editor accepts pastes', typeof editor.props.onPaste, 'function');
check('the editor shows the drop hint', textOf(editor).indexOf('Drop files here') !== -1, true);

// 2. dropping a file uploads it through the app's own endpoint
const file = { name: 'notes.pdf', type: 'application/pdf', size: 2048 };
editor.props.onDragOver({ preventDefault() {}, stopPropagation() {}, dataTransfer: { dropEffect: '' } });
tree = render(mount);
const dropping = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('mtt-dropping') !== -1)[0];
check('dragging marks the box', dropping !== undefined, true);

editor.props.onDrop({ preventDefault() {}, stopPropagation() {}, dataTransfer: { files: [file] } });
await new Promise((resolve) => setTimeout(resolve, 10));
tree = render(mount);

const upload = calls.filter((call) => call.url.indexOf('/api/session/uploadFileBinary') === 0);
check('one upload was made', upload.length, 1);
check('it names the study session and the file', upload[0].url, '/api/session/uploadFileBinary?sessionId=session-x&name=notes.pdf');
check('it sends the bytes as a stream', upload[0].init.headers['content-type'], 'application/octet-stream');
check('it posts', upload[0].init.method, 'POST');

const rail = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-rail')[0];
check('the cards sit in a rail, as in the composer', rail !== undefined, true);
const cards = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-file');
check('the file shows as the app\'s own card', cards.length, 1);
check('the card is named', textOf(cards[0]).indexOf('notes.pdf') !== -1, true);
check('the card leads with the suffix and the size', textOf(cards[0]).indexOf('PDF 2.0KB') !== -1, true);
check('the card draws the category glyph', findAll([cards[0]], (node) => node.props && node.props['data-file-icon'] === 'notes.pdf').length, 1);
check('the card can be taken back out', findAll([cards[0]], (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-file-remove').length, 1);

// 3. an image is admitted as an image, not as a file
editor.props.onDrop({
  preventDefault() {}, stopPropagation() {},
  dataTransfer: { files: [{ name: 'shot.png', type: 'image/png', size: 4096 }] },
});
await new Promise((resolve) => setTimeout(resolve, 10));
tree = render(mount);
const imageUpload = calls.filter((call) => call.url.indexOf('mediaType=') !== -1)[0];
check('the image upload names its media type', imageUpload !== undefined ? imageUpload.url : null,
  '/api/session/uploadFileBinary?sessionId=session-x&name=shot.png&mediaType=image%2Fpng');
const tiles = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-tile');
check('the picture shows as a thumbnail', tiles.length, 1);
const picture = findAll([tiles[0]], (node) => node.type === 'img')[0];
check('the thumbnail carries the dropped bytes', picture === undefined ? null : picture.props.src, 'blob:preview-1');
check('both attachments are listed', findAll(tree, (node) => typeof node.props.className === 'string'
  && (node.props.className === 'mtt-file' || node.props.className === 'mtt-tile')).length, 2);

// 3b. a picture on the clipboard arrives the same way, through Ctrl+V
{
  const pasted = { name: 'image.png', type: 'image/png', size: 5120 };
  let prevented = false;
  editor.props.onPaste({
    clipboardData: {
      items: [{ kind: 'file', type: 'image/png', getAsFile: () => pasted }],
      files: [],
    },
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  check('a pasted picture takes over the keystroke', prevented, true);
  await new Promise((resolve) => setTimeout(resolve, 10));
  tree = render(mount);
  const pasteUpload = calls.filter((call) => call.url.indexOf('name=image.png') !== -1)[0];
  check('the paste uploads it as a picture', pasteUpload === undefined ? null : pasteUpload.url,
    '/api/session/uploadFileBinary?sessionId=session-x&name=image.png&mediaType=image%2Fpng');
  check('the pasted picture joins the rail', findAll(tree, (node) => typeof node.props.className === 'string'
    && node.props.className === 'mtt-tile').length, 2);

  // Text pastes are none of our business: the field keeps its own handling.
  let textPrevented = false;
  const uploadsBefore = calls.filter((call) => call.url.indexOf('/api/session/uploadFileBinary') === 0).length;
  editor.props.onPaste({
    clipboardData: { items: [{ kind: 'string', type: 'text/plain', getAsFile: () => null }], files: [] },
    preventDefault() { textPrevented = true; },
    stopPropagation() {},
  });
  check('a text paste is left to the field', textPrevented, false);
  check('a text paste uploads nothing',
    calls.filter((call) => call.url.indexOf('/api/session/uploadFileBinary') === 0).length, uploadsBefore);

  // Take it back out, so the cases below keep looking at the two attachments a
  // drop left behind.
  const removeTile = findAll(tree, (node) => typeof node.props.className === 'string'
    && node.props.className === 'mtt-tile-remove').slice(-1)[0];
  check('the pasted picture can be taken back out', removeTile !== undefined, true);
  if (removeTile !== undefined) removeTile.props.onClick({ preventDefault() {}, stopPropagation() {} });
  tree = render(mount);
  check('the rail is back to the two the drop left',
    findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-tile').length, 1);
}

// 4. sending replays the question with the files attached
const sendButton = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('mtt-btn-primary') !== -1)[0];
check('the editor has a send button', sendButton !== undefined, true);
sendButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
tree = render(mount);

const posts = calls.filter((call) => call.init.method === 'POST' && call.url.indexOf('/message-toolbar') === 0);
const saved = posts.filter((call) => {
  try { return JSON.parse(call.init.body).action === 'prompt-save'; } catch (e) { return false; }
}).pop();
check('saving the question also saves the rail', saved === undefined ? null : JSON.parse(saved.init.body).files.length, 2);
const run = posts.filter((call) => {
  try { return JSON.parse(call.init.body).action === 'answer-run'; } catch (e) { return false; }
}).pop();
check('the question was replayed', run !== undefined, true);
if (run !== undefined) {
  const body = JSON.parse(run.init.body);
  check('the run carries both attachments', body.files, [
    { type: 'file', attachment: { attachmentId: 'att-9', name: 'notes.pdf', bytes: 2048 } },
    { type: 'image', attachment: { attachmentId: 'img-1', width: 640, height: 480 } },
  ]);
  check('the run names the turn', body.turn, 1);
}

// 5. the question keeps showing its attachments, above the bubble
{
  const mounted = ReactDom.roots.map((slot) => slot.element).filter((element) => element !== null);
  // The row reads the plugin state through the store, which reloads the session
  // payload after a run: let that land, then draw again.
  await new Promise((resolve) => setTimeout(resolve, 30));
  const rows = mounted.flatMap((element) => {
    const one = render({ type: element.type, props: Object.assign({}, element.props, { sessionId: 'session-x', turn: 1 }) });
    return findAll(one, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-attach-row');
  });
  check('the question row draws its attachments', rows.length, 1);
  if (rows.length === 1) {
    check('the row shows the file card', findAll(rows, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-file').length, 1);
    check('the row shows the picture', findAll(rows, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-tile').length, 1);
    check('the row offers no remove button', findAll(rows, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-file-remove').length, 0);
  }
}

// 6. the right-hand rail lists the turns the transcript shows — and only those
{
  // The plugin wraps `sessions.projectionStore` during apply, so this is the
  // wrapped store: `turnOutline` must answer without the deleted turn and
  // without the replay of a question that was asked again.
  const store = sessionsStub.binding('session-x').session.projections;
  const face = store.faceOf('turnOutline');
  const first = face.getSnapshot();
  check('the outline drops the deleted turn and the replay', first.map((entry) => entry.turn), [1, 3, 5]);
  check('the outline also follows the saved question', first.map((entry) => entry.prompt), ['a question', 'p3', 'p5']);
  check('the filtered value keeps its identity', face.getSnapshot(), first);
  check('a plain key is passed through', store.faceOf('title').getSnapshot(), undefined);

  // The chat target's items are the other half of the merge; a turn missing from
  // one half still shows, so both have to agree.
  const bound = uiConversationStub.binding('session-x').target('chat');
  const patched = bound.getSnapshot();
  const items = patched.navigation.items();
  check('the rail drops the same turns', items.map((item) => item.turn), [1, 3, 5]);
  check('the rail describes the variant that is on screen', items[0].response, '另一个模型写的回答');
  check('the rail keeps the previews it did not touch', items[1].response, 'r3');
  check('the patched snapshot is cached for the same host frame', bound.getSnapshot(), patched);
  check('the untouched snapshot is left alone', chatTarget.getSnapshot(), chatSnapshot);
}

// 7. the count of an answer row opens the answers by name
{
  const answersEntry = registered.filter((entry) => entry.descriptor.id === 'message-toolbar-answers')[0];
  check('the answer card is registered', answersEntry !== undefined, true);
  const props = Object.assign({}, answersEntry.descriptor.inject('session-x'), { turn: 6, seq: 60 });
  let card = render({ type: answersEntry.component, props });

  // A group whose visible answer failed still gets a row of its own.
  const row = findAll(card, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-tail-actions')[0];
  check('the group row is drawn for a failed answer', row !== undefined, true);

  const num = findAll(card, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('mtt-ring-num') !== -1)[0];
  check('the count is a button', num !== undefined, true);
  check('the count reads the position', num === undefined ? null : textOf(num), '2/2');
  const ringMenu = findAll(card, (node) => node.props && node.props['data-native-menu'] !== undefined)[0];
  check('the count owns a menu', ringMenu !== undefined, true);
  check('the menu starts closed', ringMenu === undefined ? null : ringMenu.props['data-open'], '0');

  // Opening it lists the answers of this question, named after the model that
  // wrote them, with the one on screen ticked.
  num.props.onClick();
  card = render({ type: answersEntry.component, props });
  const openMenu = findAll(card, (node) => node.props && node.props['data-native-menu'] !== undefined && node.props['data-open'] === '1')[0];
  check('the count opens the list', openMenu !== undefined, true);
  check('every answer is a row', openMenu === undefined ? null : JSON.parse(openMenu.props['data-items']), [
    '5=1. model’s own answer',
    '6=2. deepseek-flash',
  ]);
  check('the answer on screen is ticked', openMenu === undefined ? null : openMenu.props['data-selected'], '6');
  check('the tick is a check, not a fill', openMenu === undefined ? null : openMenu.props['data-selection'], 'check');

  // Picking a row jumps straight to it — no stepping through the ones between.
  const postsBefore = calls.filter((call) => call.init.method === 'POST').length;
  await openMenu.props.onSelect('5');
  const jumped = calls.filter((call) => call.init.method === 'POST').slice(postsBefore).map((call) => JSON.parse(call.init.body));
  check('picking an answer selects it', jumped, [{ action: 'run-select', sessionId: 'session-x', turn: 5, active: 5 }]);
}

// 8. a variant on screen is what copy copies
{
  freshMount();
  const barEntry = registered.filter((entry) => entry.descriptor.id === 'message-toolbar'
    && entry.descriptor.name === 'conversation.chat.assistant-actions')[0];
  check('the action row is registered', barEntry !== undefined, true);
  // The row normally learns its turn from the message index; a turn handed in is
  // enough, which is also how the failed-answer row uses it.
  const props = Object.assign({}, barEntry.descriptor.inject('session-x'), { turn: 1, messageId: 'm-1' });
  const bar = render({ type: barEntry.component, props });
  const copyButton = findAll(bar, (node) => node.props && node.props['data-mtt'] === 'copy-answer')[0];
  check('a replaced answer offers its own copy', copyButton !== undefined, true);
  if (copyButton !== undefined) {
    const before = clipped.length;
    copyButton.props.onClick();
    check('it copies the answer on screen', clipped.slice(before), ['另一个模型写的回答']);
  }
}

// 9. an ordinary answer still draws its whole row
{
  freshMount();
  // The row that runs on every plain answer: no variant, no edit, no translation.
  // It used to read a variable that only existed inside the translator's closure,
  // so the whole slot threw and disappeared — which no assertion above noticed,
  // because each of them short-circuited before reaching that line.
  const barEntry = registered.filter((entry) => entry.descriptor.id === 'message-toolbar'
    && entry.descriptor.name === 'conversation.chat.assistant-actions')[0];
  const props = Object.assign({}, barEntry.descriptor.inject('session-x'), { turn: 3, messageId: 'm-3' });
  const bar = render({ type: barEntry.component, props });
  // Regenerate, edit, model, translate, trash — every button is an `.mtt-act`, and
  // all of them are live on a finished answer.
  const acts = findAll(bar, (node) => typeof node.props.className === 'string'
    && node.props.className.split(' ').indexOf('mtt-act') !== -1);

  check('a plain answer keeps its actions', acts.length, 5);
  check('none of them is greyed out', acts.map((node) => node.props.disabled === true), [false, false, false, false, false]);
  // Nothing was replaced and nothing was edited, so the app's own copy button is
  // already copying the right thing — no second one.
  const copyButton = findAll(bar, (node) => node.props && node.props['data-mtt'] === 'copy-answer')[0];
  check('a plain answer needs no second copy', copyButton, undefined);
}

// 10. a notice the frame could not place in a turn leaves with that turn
{
  // Turn 2 is deleted in the fixture. These rows carry no `data-chat-turn`, so no
  // stylesheet rule can name them; the sweep reads the order of the flow instead,
  // and the store subscription is what makes it run when a deletion changes
  // nothing in the DOM.
  check('a notice trailing a deleted turn goes with it', trailingNotice.style.display, 'none');
  check('a notice opening a live turn stays', openingNotice.style.display === 'none', false);
  check('a notice opening a deleted turn goes with it', openingGone.style.display, 'none');
}

// 11. a question that references a file keeps the app's own chip
{
  // `@C:\…\crash.ips` contains dots, so a naive "looks like markdown" test calls
  // it markdown and covers the app's bubble with a copy of the characters — and
  // the chip, its icon and its hover card go with it. The copy is only worth
  // drawing where it adds something.
  freshMount();
  const userRow = ReactDom.roots
    .map((slot) => slot.element)
    .filter((element) => element !== null && element.type && element.type.name === 'UserRow')[0];
  check('the question row is mounted', userRow !== undefined, true);

  const draw = (turn) => {
    const bubble = makeElement('div');
    bubble.className = 'abc_bubble';
    freshMount();
    const tree = render({
      type: userRow.type,
      props: Object.assign({}, userRow.props, { sessionId: 'session-x', turn: turn, bubble: bubble }),
    });
    const overlay = findAll(tree, (node) => typeof node.props.className === 'string'
      && node.props.className.split(' ').indexOf('mtt-bubble-md') !== -1);
    return { overlay: overlay.length, display: bubble.style.display };
  };

  const referenced = draw(7);
  check('a question that references a file is not covered', referenced.overlay, 0);
  check('the app keeps drawing that bubble', referenced.display, '');

  const markdown = draw(8);
  check('markdown without a reference is still drawn here', markdown.overlay, 1);
  check('and the app bubble steps aside for it', markdown.display, 'none');
}

// 12. a replayed turn does not announce the context it injected
{
  // Answering again makes the agent inject fresh time and runtime context, and the
  // app draws that as one process row titled "已注入上下文". That is plumbing of a
  // turn this plugin opened, not part of the conversation.
  freshMount();
  const tailEntry = registered.filter((entry) => entry.descriptor.id === 'message-toolbar-answers')[0];
  check('the answer card is registered', tailEntry !== undefined, true);
  render({ type: tailEntry.component, props: Object.assign({}, tailEntry.descriptor.inject('session-x'), { turn: 4 }) });
  const rules = styleTags.map((tag) => tag.textContent).join('\n');
  check('the replay hides its process group', rules.indexOf('[data-step-process][data-chat-turn="4"]{display:none}') !== -1, true);
  check('and the context rows that feed it', rules.indexOf('[data-chat-flow-kind="context"][data-chat-turn="4"]{display:none}') !== -1, true);
  // The card that opens onto the same nothing: "已完成 · Ns" with an empty body,
  // because the turn has no tools and no thinking to list.
  check('and the disclosure that opens onto nothing', rules.indexOf('[data-chat-flow-kind="turn-process"][data-chat-turn="4"]{display:none}') !== -1, true);
  // Even a replay that did real work must not head the answer with "已完成分析":
  // the question row is gone, so the group's own title reads as a stray heading.
  check('the replay drops the group title', rules.indexOf('[data-step-process][data-chat-turn="4"] > div:first-child{display:none}') !== -1, true);
  check('and keeps its steps reachable', rules.indexOf('[data-step-process][data-chat-turn="4"] [data-step-process-body]{max-height:none;overflow:visible}') !== -1, true);
  check('a turn the reader asked keeps its group', rules.indexOf('[data-step-process][data-chat-turn="1"]') === -1, true);
  check('and keeps its title', rules.indexOf('[data-step-process][data-chat-turn="1"] > div:first-child') === -1, true);

  // A replay that ran tools and thought about it: the group keeps its steps (so
  // the answer still shows its process), and loses only the title heading it.
  render({ type: tailEntry.component, props: Object.assign({}, tailEntry.descriptor.inject('session-x'), { turn: 11 }) });
  const worked = styleTags.map((tag) => tag.textContent).join('\n');
  check('a replay with steps keeps its group', worked.indexOf('[data-step-process][data-chat-turn="11"]{display:none}') === -1, true);
  check('but not its title', worked.indexOf('[data-step-process][data-chat-turn="11"] > div:first-child{display:none}') !== -1, true);
}

console.log(failures === 0 ? '\nall good' : '\n' + failures + ' failure(s)');process.exit(failures === 0 ? 0 : 1);
