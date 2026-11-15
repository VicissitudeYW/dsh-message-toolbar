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
  turns: [
    { turn: 1, text: 'a question', time: 1, answered: true },
    { turn: 2, text: 'a deleted question', time: 2, answered: true },
    { turn: 3, text: 'another question', time: 3, answered: true },
    { turn: 4, text: 'a question', time: 4, answered: true },
    { turn: 5, text: 'the last question', time: 5, answered: true },
  ],
  answers: { 1: { active: 'v-1', items: [{ id: 'v-1', kind: 'model', text: '另一个模型写的回答', at: 1 }] } },
  // Turn 2 was deleted and turn 4 is the replay of the question asked in turn 1.
  hidden: { turns: [2], answers: [], prompts: [4] },
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
  Menu(props) { return React.createElement('div', { 'data-native-menu': '', 'data-count': String((props.items || []).length) }); },
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
  projectionStore: () => projection,
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
  const face = sessionsStub.projectionStore('session-x').faceOf('turnOutline');
  const first = face.getSnapshot();
  check('the outline drops the deleted turn and the replay', first.map((entry) => entry.turn), [1, 3, 5]);
  check('the outline keeps its keepers', first.map((entry) => entry.prompt), ['p1', 'p3', 'p5']);
  check('the filtered value keeps its identity', face.getSnapshot(), first);
  check('a plain key is passed through', sessionsStub.projectionStore('session-x').faceOf('title').getSnapshot(), undefined);

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

console.log(failures === 0 ? '\nall good' : '\n' + failures + ' failure(s)');
process.exit(failures === 0 ? 0 : 1);
