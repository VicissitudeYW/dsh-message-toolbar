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
  turns: [{ turn: 1, text: 'a question', time: 1, answered: true }],
  answers: {},
  hidden: {},
  shown: {},
  origins: {},
  prompts: {},
  runs: {},
  model: null,
};

const fetchStub = async function (url, init) {
  calls.push({ url: String(url), init: init || {} });
  if (String(url).indexOf('/api/session/uploadFileBinary') === 0) {
    const body = String(url).indexOf('mediaType=') === -1 ? uploadResponse : imageResponse;
    return { ok: true, status: 200, json: async () => body };
  }
  if ((init && init.method) === 'POST') {
    return { ok: true, status: 200, json: async () => ({ runs: {}, hidden: {}, prompts: {}, answers: {} }) };
  }
  return { ok: true, status: 200, json: async () => statePayload };
};

const windowStub = {
  fetch: fetchStub,
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  navigator: { language: 'en', languages: ['en'], clipboard: { writeText: async () => {} } },
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

const ReactDom = {
  createPortal(node) { return node; },
  createRoot(container) {
    return { render(element) { ReactDom.last = element; }, unmount() {} };
  },
};
ReactDom.last = null;

const primitives = {
  Menu(props) { return React.createElement('div', { 'data-native-menu': '', 'data-count': String((props.items || []).length) }); },
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

const ctx = {
  effect(fn) { try { fn(); } catch (e) { console.log('effect threw: ' + e.message); } return () => {}; },
  get(name) {
    if (name === 'slots') return slots;
    if (name === 'sessions') {
      return {
        list: { getSnapshot: () => ({ byId: { 'session-x': { id: 'session-x', running: false } } }), subscribe: () => () => {} },
        projectionStore: () => ({ values: () => ({}) }),
      };
    }
    if (name === 'uiWorkspace') return { openSession: () => {} };
    if (name === 'locale') return { register: () => () => {}, subscribe: () => () => {}, getLocale: () => ({ active: 'en' }) };
    return undefined;
  },
  inject() {},
};

module.apply(ctx);

const rowElement = ReactDom.last;
if (rowElement === null) { console.log('FAIL the row was never decorated'); process.exit(1); }
check('the app row is decorated with the plugin row', typeof rowElement.type, 'function');

const mount = { type: rowElement.type, props: Object.assign({}, rowElement.props, { sessionId: 'session-x', turn: 1 }) };
let tree = render(mount);
// The state of the turn arrives through the store, which loads it asynchronously.
await new Promise((resolve) => setTimeout(resolve, 10));
tree = render(mount);

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

const chips = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-attach');
check('the file shows as one chip', chips.length, 1);
check('the chip is named', textOf(chips[0]).indexOf('notes.pdf') !== -1, true);
check('the chip shows the size', textOf(chips[0]).indexOf('2.0 KB') !== -1, true);

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
const chipsNow = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className === 'mtt-attach');
check('both attachments are listed', chipsNow.length, 2);
check('the image chip shows its size in pixels', textOf(chipsNow[1]).indexOf('640 × 480') !== -1, true);

// 4. sending replays the question with the files attached
const sendButton = findAll(tree, (node) => typeof node.props.className === 'string' && node.props.className.indexOf('mtt-btn-primary') !== -1)[0];
check('the editor has a send button', sendButton !== undefined, true);
sendButton.props.onClick();
await new Promise((resolve) => setTimeout(resolve, 20));
tree = render(mount);

const posts = calls.filter((call) => call.init.method === 'POST' && call.url.indexOf('/message-toolbar') === 0);
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

console.log(failures === 0 ? '\nall good' : '\n' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
