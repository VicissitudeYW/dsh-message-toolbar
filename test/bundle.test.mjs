
// Loads the BUILT client bundle (lib/client.js) the way DSH does: through
// window.__ModuleLoader__ with React and the style helper injected. This
// catches bundling mistakes (stray `return`, missing exports, a factory that
// throws) before the plugin is installed and DSH is restarted.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const SOURCE = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

// The bundle's style helper talks to the DOM, so give it the smallest possible
// document stub and collect the injected <style> tags.
const styleTags = [];
globalThis.document = {
  querySelector(selector) {
    return styleTags.find((tag) => tag.selector === selector) ?? null;
  },
  createElement() {
    const tag = {
      dataset: {},
      textContent: '',
      selector: 'style[data-plugin="' + 'dsh-message-toolbar' + '"]',
      remove() {},
    };
    styleTags.push(tag);
    return tag;
  },
  head: { appendChild(tag) { tag.appended = true; } },
};

function loadBundle() {
  let entry;
  const window = { __ModuleLoader__: { load(value) { entry = value; } } };
  const React = {
    createElement(type, props, ...kids) {
      const merged = Object.assign({}, props);
      if (kids.length === 1) merged.children = kids[0];
      else if (kids.length > 1) merged.children = kids;
      return { type, props: merged };
    },
    useState(init) { return [typeof init === 'function' ? init() : init, function () {}]; },
    useReducer(reducer, init) { return [init, function () {}]; },
    useEffect() {},
  };
  new Function('window', SOURCE)(window);
  assert.ok(entry, 'the bundle must call window.__ModuleLoader__.load');
  const mod = entry.factory(function (name) {
    if (name === 'react') return React;
    throw new Error('unexpected require(' + name + ')');
  });
  return { entry, mod };
}

function applyToSlots() {
  const { mod } = loadBundle();
  const registrations = [];
  const services = {
    slots: {
      inject(name, factory) { return factory(); },
      register(descriptor, component) {
        registrations.push({ descriptor, component });
        return function () {};
      },
    },
    sessions: {
      list: {
        getSnapshot() { return { byId: {} }; },
        subscribe() { return function () {}; },
      },
    },
    locale: {
      register() { return function () {}; },
      bind() { return function (key) { return key; }; },
    },
    uiWorkspace: { openSession() {} },
  };
  const ctx = {
    get(name) { return services[name]; },
    effect(fn) { return fn(); },
  };
  mod.apply(ctx);
  return { mod, css: styleTags.map((tag) => tag.textContent), registrations };
}
test('the built bundle registers itself with the module loader', () => {
  const { entry, mod } = loadBundle();
  assert.equal(entry.id, 'dsh-message-toolbar');
  assert.equal(typeof mod.apply, 'function');
  assert.deepEqual(mod.inject, ['slots', 'sessions', 'locale', 'uiWorkspace']);
});

test('apply() injects styles and registers every slot', () => {
  const { css, registrations } = applyToSlots();
  assert.ok(css.length > 0, 'CSS must be inserted');
  assert.match(css.join('\n'), /\.mtt-bubble/);
  const counts = registrations.reduce((acc, r) => {
    acc[r.descriptor.name] = (acc[r.descriptor.name] ?? 0) + 1;
    return acc;
  }, {});
  assert.deepEqual(counts, {
    'conversation.chat.assistant-actions': 1,
    'conversation.chat.node': 1,
    'conversation.chat.turnTail': 2,
    'conversation.view': 1,
    'settings.section': 1,
  });
  // Two turnTail entries: the answer variant card sits where the answer lives,
  // the bilingual translation cards below it.
  const tails = registrations
    .filter((r) => r.descriptor.name === 'conversation.chat.turnTail')
    .map((r) => r.descriptor.id)
    .sort();
  assert.deepEqual(tails, ['message-toolbar-answers', 'message-toolbar-translations']);
  for (const entry of registrations) assert.equal(typeof entry.component, 'function');
});

test('the user bubble is shadowed at the lowest priority', () => {
  const { registrations } = applyToSlots();
  const node = registrations.find((r) => r.descriptor.name === 'conversation.chat.node');
  assert.equal(node.descriptor.key, 'user');
  assert.equal(node.descriptor.priority, -1);
});

// DSH's client-modules registry refuses to start when a package declares
// `dsh.client` but its `exports` has no `./client` entry:
//   client-modules: <pkg> declares dsh.client but exports no "./client" bundle
// That took a full restart to discover once, so pin the contract here.
test('package.json exposes the built client bundle through exports["./client"]', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const client = pkg.exports?.['./client'];
  const clientRel = typeof client === 'string' ? client : client?.default;
  assert.equal(typeof clientRel, 'string', 'exports["./client"] must be a string or { default: string }');
  assert.equal(clientRel, './lib/client.js');
  assert.ok(fs.existsSync(new URL('../lib/client.js', import.meta.url)), 'the exported client bundle must exist');
  assert.equal(pkg.exports?.['.']?.default ?? pkg.exports?.['.'], './lib/index.js');
  assert.equal(pkg.dsh?.client?.platform, 'web');
  assert.ok(pkg.dsh.client.inject.length > 0);
  for (const specifier of pkg.dsh.client.inject) assert.equal(typeof specifier, 'string');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
});

test('the assistant action row receives a session-scoped inject', () => {
  const { registrations } = applyToSlots();
  const actions = registrations.find((r) => r.descriptor.name === 'conversation.chat.assistant-actions');
  assert.equal(typeof actions.descriptor.inject, 'function');
  assert.deepEqual(actions.descriptor.inject('sess-1'), { sessionId: 'sess-1' });
});

// Mounting each component once catches typos and hook-order mistakes that a
// registration-only test cannot see (the host serves the bundle without any
// build-time type checking). The cache starts empty, so every component below
// takes its "no data yet" path — exactly what the first paint does.
test('every registered component mounts without throwing', () => {
  const { registrations } = applyToSlots();
  const props = {
    'conversation.chat.node': {
      node: {
        data: { content: [{ type: 'text', text: 'hello' }], seq: 1 },
        location: { kind: 'turn', turn: 1 },
      },
    },
    'conversation.chat.assistant-actions': { sessionId: 'sess-1', messageId: 'msg-1' },
    'conversation.chat.turnTail': { sessionId: 'sess-1', turn: 1, seq: 3 },
    'conversation.view': { sessionId: 'sess-1' },
    'settings.section': {},
  };
  for (const { descriptor, component } of registrations) {
    const injected = typeof descriptor.inject === 'function' ? descriptor.inject('sess-1') : {};
    const base = props[descriptor.name] ?? {};
    assert.doesNotThrow(
      () => component(Object.assign({}, base, injected)),
      descriptor.name + ' (' + (descriptor.id ?? descriptor.key ?? 'default') + ') must mount',
    );
  }
});

// An icon that paints nothing is worse than no icon. DSH's artwork relies on
// `stroke="currentColor"` being inherited from the <svg> (the two-slider glyph
// sets it there) or repeated on every child (all the other glyphs do). A shape
// with neither `stroke` nor `fill` inside a `fill="none"` svg is invisible —
// exactly how the model-switch button once lost its icon.
const SHAPES = new Set(['path', 'circle', 'rect', 'line', 'polyline', 'polygon']);

function flatten(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  out.push(node);
  if (node.props) flatten(node.props.children, out);
  return out;
}

// The React stub returns element descriptions, so local function components
// have to be invoked by hand before their markup is visible.
function expand(node, depth = 0) {
  if (node === null || node === undefined || typeof node !== 'object') return [];
  if (Array.isArray(node)) return node.flatMap((child) => expand(child, depth));
  if (typeof node.type === 'function') {
    if (depth > 16) return [];
    return expand(node.type(Object.assign({}, node.props)), depth + 1);
  }
  return [node, ...expand(node.props && node.props.children, depth + 1)];
}

test('every inline icon actually paints', () => {
  const { registrations } = applyToSlots();
  const props = {
    'conversation.chat.node': {
      node: {
        data: { content: [{ type: 'text', text: 'hello' }], seq: 1 },
        location: { kind: 'turn', turn: 1 },
      },
    },
    'conversation.chat.assistant-actions': { sessionId: 'sess-1', messageId: 'msg-1' },
    'conversation.chat.turnTail': { sessionId: 'sess-1', turn: 1, seq: 3 },
    'conversation.view': { sessionId: 'sess-1' },
    'settings.section': {},
  };
  const svgs = [];
  for (const { descriptor, component } of registrations) {
    const injected = typeof descriptor.inject === 'function' ? descriptor.inject('sess-1') : {};
    const tree = component(Object.assign({}, props[descriptor.name] ?? {}, injected));
    for (const node of expand(tree)) {
      if (node.type === 'svg') svgs.push(node);
    }
  }
  assert.ok(svgs.length > 0, 'the toolbar must render its icons');
  for (const svg of svgs) {
    const inherited = typeof svg.props.stroke === 'string' && svg.props.stroke !== 'none';
    for (const shape of expand(svg.props.children)) {
      if (!SHAPES.has(shape.type)) continue;
      const painted = inherited
        || typeof shape.props.stroke === 'string'
        || (typeof shape.props.fill === 'string' && shape.props.fill !== 'none');
      assert.ok(painted, '<' + shape.type + '> in an inline icon paints nothing: ' + JSON.stringify(shape.props));
    }
  }
});
