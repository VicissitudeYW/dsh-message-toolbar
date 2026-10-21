
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

function loadBundle(options = {}) {
  let entry;
  const withPrimitives = options.primitives !== false;
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
  // A stand-in for the shell seed package: only `Menu` is used, and the fake
  // records the data rows it was handed so tests can read them.
  const primitives = {
    Menu(props) {
      return React.createElement('div', {
        'data-native-menu': props.open ? 'open' : 'closed',
        'data-menu-items': (props.items || []).map((item) => item.id).join(','),
        'data-menu-selected': props.selectedId,
        'data-menu-side': props.side,
        'data-menu-footer': (props.footer || []).map((item) => item.id).join(','),
      }, null);
    },
  };
  new Function('window', SOURCE)(window);
  assert.ok(entry, 'the bundle must call window.__ModuleLoader__.load');
  const mod = entry.factory(function (name) {
    if (name === 'react') return React;
    if (withPrimitives && name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error('unexpected require(' + name + ')');
  });
  return { entry, mod };
}

function applyToSlots(options = {}) {
  const { mod } = loadBundle(options);
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

function assistantToolbarNodes(options = {}) {
  const { registrations } = applyToSlots(options);
  const registration = registrations.find((r) => r.descriptor.name === 'conversation.chat.assistant-actions');
  assert.ok(registration, 'the assistant action row must be registered');
  const injected = typeof registration.descriptor.inject === 'function' ? registration.descriptor.inject('sess-1') : {};
  return expand(registration.component(Object.assign({ sessionId: 'sess-1', messageId: 'msg-1' }, injected)));
}

// The composer's model picker is the primitives `Menu`; ours must be the same
// component, not a look-alike, or the two dropdowns drift apart.
test('the model picker is the host dropdown when the primitives package is present', () => {
  const menu = assistantToolbarNodes().find((node) => node.props && node.props['data-native-menu'] !== undefined);
  assert.ok(menu, 'the model picker must render through the primitives Menu');
  assert.equal(menu.props['data-native-menu'], 'closed');
  assert.equal(menu.props['data-menu-side'], 'bottom');
  assert.ok(menu.props['data-menu-items'].length > 0, 'the menu must always offer at least a placeholder row');
  assert.ok(
    menu.props['data-menu-footer'].includes('message-toolbar/branch'),
    'the branch row must stay one click away',
  );
});

test('without the primitives package the picker falls back to the built-in popover', () => {
  const nodes = assistantToolbarNodes({ primitives: false });
  assert.equal(nodes.some((node) => node.props && node.props['data-native-menu'] !== undefined), false);
  assert.ok(nodes.some((node) => String(node.props && node.props.className || '').includes('mtt-menu-wrap')));
});

/** Every tooltip/aria title rendered by a subtree, in document order. */
function titlesOf(nodes) {
  return nodes.map((node) => node.props && node.props.title).filter((title) => typeof title === 'string');
}

// Translating must not need configuring first: pressing translate opens the
// same native dropdown as the model picker and lists nothing but languages.
test('translate picks the target language in the native dropdown', () => {
  const menus = assistantToolbarNodes().filter(
    (node) => node.props && node.props['data-native-menu'] !== undefined,
  );
  assert.ok(menus.length >= 2, 'model picker and language picker both use the primitives Menu');
  const languages = menus.find((menu) => String(menu.props['data-menu-items']).includes('ja'));
  assert.ok(languages, 'the language dropdown lists the target languages');
  assert.ok(String(languages.props['data-menu-items']).includes('zh-TW'));
  assert.equal(languages.props['data-menu-side'], 'bottom');
});

test('the plugin ships no settings panel', () => {
  const { registrations, css } = applyToSlots();
  assert.equal(
    registrations.some((r) => r.descriptor.name === 'settings.section'),
    false,
    'translation options live in the translate menu, not in settings',
  );
  assert.equal(/\.mtt-settings/.test(css.join('\n')), false);
});

// Deleting a message is the whole point of a toolbar for a stalled turn, so
// both rows must expose it — and the stylesheet must carry the hidden-row rule
// that a deleted turn needs to keep its restore affordance clickable.
test('both rows offer a delete action and the sheet knows how to hide a turn', () => {
  const { registrations, css } = applyToSlots();
  const node = registrations.find((r) => r.descriptor.name === 'conversation.chat.node');
  const userTitles = titlesOf(expand(node.component({
    sessionId: 'sess-1',
    node: { data: { content: [{ type: 'text', text: 'hi' }], seq: 1 }, location: { kind: 'turn', turn: 1 } },
  })));
  assert.ok(userTitles.includes('Delete this message'), 'the user row must offer "delete this message"');

  const assistantTitles = titlesOf(assistantToolbarNodes());
  assert.ok(assistantTitles.includes('Delete this answer'), 'the assistant row must offer "delete this answer"');

  const sheet = css.join('\n');
  assert.match(sheet, /\.mtt-hidden/);
  assert.match(sheet, /\.mtt-pop-note/);
});

// Copy follows the reader, not a stored preference: a Chinese document must
// produce Chinese rows even when the locale service reports nothing, which is
// how "Answer deleted" once showed up as English under a Chinese UI.
test('rows read Chinese when the document is Chinese', () => {
  globalThis.document.documentElement = { lang: 'zh-CN' };
  try {
    const { registrations } = applyToSlots();
    const node = registrations.find((r) => r.descriptor.name === 'conversation.chat.node');
    const titles = titlesOf(expand(node.component({
      sessionId: 'sess-1',
      node: { data: { content: [{ type: 'text', text: 'hi' }], seq: 1 }, location: { kind: 'turn', turn: 1 } },
    })));
    assert.ok(titles.includes('删除这条消息'), 'a Chinese document gets Chinese copy: ' + titles.join(' | '));
    assert.ok(titles.includes('编辑消息'), 'the edit action is localized too: ' + titles.join(' | '));
  } finally {
    delete globalThis.document.documentElement;
  }
});

// Editing an answer happens where the answer is: the box opens between the
// action row and the answer it replaces, so it must be a real slot component
// (not a popover) driven through the store the row writes to.
test('the editor opens in the answer area, not in a popover', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  assert.match(sheet, /\.mtt-answer-edit/);
  assert.match(sheet, /\.mtt-answer-edit-input/);
  assert.doesNotMatch(sheet, /\.mtt-pop-answer/, 'the popover editor is gone');

  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /function AnswerEditBox\(/);
  assert.match(source, /store\.setEdit\(props\.sessionId, props\.turn, null\)/, 'the box closes itself');
  assert.match(source, /action: 'answer-save'/, 'the box saves into a variant');
  assert.match(source, /const edit = useAnswerEdit\(sessionId, turn\);/, 'the card owns the open editor');
});

// Saving an edit is an overwrite, not a new answer: the render path must be the
// same Markdown body a generated answer uses (so an edited answer keeps its
// styling), and the only extra affordance is the one-line way back.
test('an edited answer renders through the normal markdown body', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  assert.match(sheet, /\.mtt-answer-note/);

  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /function answerOverride\(/, 'the override is read from the turn record');
  assert.match(source, /const shownText = live !== null/, 'one text feeds the body for every case');
  assert.match(source, /h\(AnswerBody, \{ text: shownText, streaming: live !== null \}\)/);
  assert.match(source, /action: 'answer-restore'/, 'an overwritten answer can be given back');
  assert.doesNotMatch(source, /kind: 'edit'/, 'saving no longer creates an alternative');
});

// A variant being written must look like the app generating, not like a plugin
// widget: the request asks for NDJSON frames, the empty state is the native
// shimmer line, and the body is plain flow text with no card chrome of ours.
test('the answer stream is NDJSON and the empty state uses the native shimmer', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /accept: 'application\/x-ndjson'/);
  assert.match(source, /stream: true/);
  assert.match(source, /function WaitLine/);
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  assert.match(sheet, /\.mtt-answer-wait/);
  assert.doesNotMatch(sheet, /\.mtt-live-caret/);
});

// Deleting is confirmed with a question and reported with a banner: the action
// row stays a row of icons, so nothing may write status text into it, and the
// banner is the app's own Toast when the primitives package is around.
test('a delete is confirmed with one question and reported through a toast', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  assert.match(sheet, /\.mtt-toast/);
  assert.doesNotMatch(sheet, /\.mtt-notice/, 'the row must not print "deleted" text any more');

  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /function useToast\(/, 'confirmations go through the toast hook');
  assert.match(source, /tone: 'success'/, 'the native toast confirms the deletion');
  assert.match(source, /holdMs: success \? 2200 : 4200/, 'and disappears on its own, a failure lingering longer');
  assert.match(source, /function failureText\(/, 'a failed delete is reported, not swallowed');
  assert.match(source, /showToast\(failureText\(e\), 'error'\)/, 'delete failures land in the same banner');
  assert.doesNotMatch(source, /hideNote/, 'the confirm popover asks the question only');
  assert.doesNotMatch(source, /deleteVariantNote/, 'the confirm popover asks the question only');
});

// Text must never be painted with a literal colour: every value has to come
// from a theme alias, otherwise dark mode keeps light-mode ink. `CanvasText`
// and friends are system colours, so they follow the app's colour scheme too.
test('every colour in the sheet resolves through a theme alias', () => {
  const { css } = applyToSlots();
  const literals = [];
  for (const rule of css) {
    for (const match of rule.matchAll(/(?:^|[;{])color:([^;}]+)/g)) {
      const value = match[1].trim();
      if (value.startsWith('var(--')) continue;
      if (value === 'inherit' || value === 'transparent' || value === 'currentColor') continue;
      literals.push(value);
    }
  }
  assert.deepEqual(literals, [], 'these rules paint a hard-coded colour');
});

