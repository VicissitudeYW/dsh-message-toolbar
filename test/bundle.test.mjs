
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
  // The bundle reaches the network through `realGlobal()`, so the harness window
  // doubles as the global: give it whatever this test wants it to have.
  const window = { __ModuleLoader__: { load(value) { entry = value; } } };
  if (options.fetch !== undefined) window.fetch = options.fetch;
  const React = {
    createElement(type, props, ...kids) {
      const merged = Object.assign({}, props);
      if (kids.length === 1) merged.children = kids[0];
      else if (kids.length > 1) merged.children = kids;
      return { type, props: merged };
    },
    useState(init) { return [typeof init === 'function' ? init() : init, function () {}]; },
    useReducer(reducer, init) { return [init, function () {}]; },
    // Refs are read by the portalled confirmation popovers (they measure the
    // button they belong to); a plain box is enough for a single-pass mount.
    useRef(init) { return { current: init === undefined ? null : init }; },
    // Effects run once, immediately: a mount in this harness is a single render,
    // and the ones that matter here (style insertion, the first cache load) are
    // exactly the side effects a real mount would perform.
    useEffect(fn) { try { fn(); } catch (e) { /* a stub render tolerates a broken effect */ } },
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
      // The session controller keeps the projection values the rail folds; tests
      // hand in a `turnOutline` (one entry per turn) the same way the host does.
      projectionStore() {
        return {
          values() { return options.projections === undefined ? {} : { turnOutline: options.projections }; },
        };
      },
    },
    locale: {
      register() { return function () {}; },
      bind() { return function (key) { return key; }; },
    },
    uiWorkspace: { openSession() {} },
  };
  if (options.conversation !== undefined) services.uiConversation = options.conversation;
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
    'conversation.chat.turnTail': 1,
    'conversation.view': 1,
  });
  // One turnTail entry: the answer card, which also draws a translation in
  // place — and it must stay above the deliverables card ("files changed"),
  // which registers at the default order 0.
  const tails = registrations.filter((r) => r.descriptor.name === 'conversation.chat.turnTail');
  assert.deepEqual(tails.map((r) => r.descriptor.id), ['message-toolbar-answers']);
  for (const entry of tails) {
    assert.ok(entry.descriptor.order < 0, 'a negative order keeps the answer above its file changes');
  }
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

test('a translation replaces the answer in place instead of opening a panel', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  const source = SOURCE;
  // The old bilingual card and the little preview popover are gone: the answer
  // area itself draws the translation, through the same markdown body.
  assert.doesNotMatch(sheet, /\.mtt-trans-card/);
  assert.doesNotMatch(source, /TranslationTail/);
  assert.doesNotMatch(source, /TranslationPanel/);
  assert.match(source, /function translationOf\(state, turn\)/);
  assert.match(source, /function shownLangOf\(state, turn\)/);
  assert.match(source, /const translation = translationOf\(state, turn\);/);
  assert.match(source, /: translation !== null \? translation\.text : '';/);
  // ...and the way back is a host call, so it survives a reload.
  assert.match(source, /action: 'translate-off'/);
  assert.match(source, /store\.patchShown\(sessionId, turn, null\)/);
});

test('the language menu offers the way back to the original', () => {
  const source = SOURCE;
  assert.match(source, /const ORIGINAL_ROW = 'message-toolbar\/original';/);
  assert.match(source, /if \(id === ORIGINAL_ROW\) \{ props\.onOriginal\(\); return; \}/);
  assert.match(source, /original: shownLang !== null,/);
});

// A translation is read against its original, paragraph by paragraph, the way an
// immersive translator lays a page out — so the answer stays where it was and the
// other language is drawn under each block of it.
test('a translation is drawn beside the original, block by block', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  const source = SOURCE;
  assert.match(sheet, /\.mtt-pair\{display:flex;flex-direction:column;gap:18px/);
  // The two halves of one paragraph stay tight together; the next paragraph gets
  // air, so the eye follows original → translation and then breaks.
  assert.match(sheet, /\.mtt-pair-block\{display:flex;flex-direction:column;gap:2px/);
  assert.match(sheet, /\.mtt-pair-tr\{padding-left:10px;border-left:2px solid var\(--mtt-line-strong\)/);
  assert.match(source, /function textBlocks\(text\)/);
  assert.match(source, /function pairParagraphs\(source, translated\)/);
  assert.match(source, /className: 'mtt-pair-tr'/);
  // Block counts disagree often enough that pairing them anyway would mislead;
  // then the whole translation goes under the whole original.
  assert.match(source, /if \(left\.length === 0 \|\| right\.length === 0 \|\| left\.length !== right\.length\) \{/);
  // ...and being on screen is not a variant: only the logged body makes way.
  assert.match(source, /: showingVariant \? 'answer' : \(translation !== null \|\| liveTranslation !== null\) \? 'translate' : null,/);
  assert.match(source, /\} else if \(mark\.mode === 'translate'\) \{/);
});

// Picking a language is a command, not a setting — nothing is "currently
// selected", so the list carries no tick and no highlighted row.
test('the language menu ticks nothing', () => {
  const source = SOURCE;
  assert.doesNotMatch(source, /selectedId: props\.current/);
  assert.doesNotMatch(source, /mtt-pop-item-on/);
  assert.match(source, /hideTranslation: 'Hide the translation'/);
  assert.match(source, /hideTranslation: '隐藏译文'/);
});

test('a confirmation is portalled instead of being painted inside the row', () => {
  const source = SOURCE;
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  // DSH's flow rows paint over absolutely positioned children and clip them, so
  // every confirm box goes through the portal helper, anchored to its button.
  assert.equal((source.match(/h\(Popover, \{/g) || []).length, 4);
  assert.match(source, /function Popover\(props\) \{/);
  assert.match(source, /dom\.createPortal\(node, document\.body\)/);
  assert.match(source, /position: 'fixed',/);
  assert.equal((source.match(/className: 'mtt-anchor', ref:/g) || []).length, 4);
  assert.doesNotMatch(source, /mtt-pop mtt-pop-confirm/);
  assert.match(sheet, /\.mtt-pop-float\{position:fixed;right:auto;top:auto\}/);
  assert.match(sheet, /\.mtt-anchor\{display:inline-flex\}/);
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
  // Deleting leaves nothing behind: no placeholder row, no restore affordance.
  assert.doesNotMatch(sheet, /\.mtt-hidden/);
  assert.match(sheet, /\.mtt-pop-note/);
});

// A version card is an entry of the version family, so it carries the
// delete-the-version action. The row-level delete has to step aside there: two
// identical trash icons in one row (seen on sub-agent replies, which are version
// cards) left the user guessing which one did what.
test('a row never offers two delete buttons', () => {
  const guarded = SOURCE.match(/isVersion\s*\n\s*\? null\s*\n\s*: h\('span', \{ className: 'mtt-menu-wrap'/g) || [];
  assert.equal(guarded.length, 2, 'the user row and the assistant row both guard their delete');
  assert.equal((SOURCE.match(/h\(TrashIcon\)/g) || []).length, 4, 'two row deletes and two card deletes, nothing more');
  assert.match(SOURCE, /act: 'delete-card'/);
  assert.match(SOURCE, /act: 'delete-turn'/);
  assert.match(SOURCE, /act: failed \? 'delete-turn' : 'delete-answer'/);
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
// styling), and no extra line is added under it.
test('an edited answer renders through the normal markdown body', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  assert.doesNotMatch(sheet, /\.mtt-answer-note/, 'no restore line lives under the answer');

  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /function answerOverride\(/, 'the override is read from the turn record');
  assert.match(source, /const shownText = live !== null/, 'one text feeds the body for every case');
  assert.match(source, /h\(AnswerBody, \{ text: shownText, streaming: live !== null \}\)/);
  assert.doesNotMatch(source, /OverrideNote/, 'nothing is drawn next to an overwritten answer');
  assert.doesNotMatch(source, /kind: 'edit'/, 'saving no longer creates an alternative');
});

// `MarkdownText` is a `memo()` object, not a function: a typeof-based guard sent
// every answer down the plain-text fallback, which is what "saved but not
// rendered" looked like.
test('the markdown renderer accepts a memo component', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /typeof candidate === 'function' \|\| \(candidate !== null && typeof candidate === 'object'\)/);
  assert.doesNotMatch(source, /typeof primitives\.MarkdownText === 'function'/);
});

// The editor must not re-measure itself on every keystroke: collapsing the field
// to `height:auto` and growing it again scrolled the page to the caret on each
// character, which is the jitter the reader reported.
test('the edit field scrolls internally instead of growing per keystroke', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  assert.match(sheet, /\.mtt-answer-edit-input\{[^}]*overflow:auto/);
  assert.match(sheet, /\.mtt-answer-edit-input\{[^}]*height:clamp\(/);

  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /scrollHeight/, 'the field is not measured while typing');
  assert.doesNotMatch(source, /style\.height = 'auto'/);
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

// A confirm box is portalled to `document.body`, so it lives outside the row
// that opened it. The dismiss-on-outside-pointer listener has to know that, or
// the pointerdown on "delete" unmounts the box before its click is dispatched
// and the button appears to do nothing.
test('a click inside a portalled confirmation does not dismiss it', () => {
  const source = SOURCE;
  assert.match(source, /const OWN_SURFACE = '\.mtt-menu-wrap, \.mtt-pop, \.mtt-pop-float';/);
  assert.match(source, /target\.closest\(OWN_SURFACE\)/);
  assert.doesNotMatch(source, /target\.closest\('\.mtt-menu-wrap'\)/);
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

// A turn that ended without an answer has no native action row (DSH renders that
// row only for a turn with a closing message), so the failed answer would have no
// toolbar at all. The turn tail draws one instead, with retry / model switch /
// delete and none of the actions that need text.
test('a turn without an answer still gets a toolbar', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  assert.match(sheet, /\.mtt-tail-actions/);
  assert.match(sheet, /\.mtt-tail-actions\{display:flex;justify-content:flex-start/, 'an answer row starts at the left edge, like the native one');

  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /function turnInfo\(state, turn\)/, 'the host reports per-turn answered/open');
  assert.match(source, /info\.answered === false && info\.open !== true/, 'only a closed, unanswered turn gets one');
  assert.match(source, /h\(AssistantToolbar, \{ sessionId: sessionId, turn: turn, failed: true \}\)/);
  assert.match(source, /const failed = props\.failed === true;/);
  assert.match(source, /typeof props\.turn === 'number' \? props\.turn/, 'the row takes a turn, not only a messageId');
  assert.match(source, /else if \(failed\) \{/, 'deleting a failed turn hides the whole turn');
  assert.match(source, /showToast\(t\('turnHidden'\)\)/);
});

// Deleting is a removal, not a tombstone: nothing of ours may be left in the flow.
test('a deleted row leaves no placeholder behind', () => {
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /HiddenRow/, 'no restore row is drawn anywhere');
  assert.doesNotMatch(source, /mtt-hidden/);
  assert.doesNotMatch(source, /display:revert/, 'a deleted turn hides its own tail row too');
});

// The rail on the right folds the log like everything else, so an answer variant
// (never logged) and a deleted turn (never logged either) are invisible to it.
// Its loaded entries come from the chat target, which is the seam we patch.
test('the turn rail follows the transcript', async () => {
  const railItems = [
    { turn: 1, prompt: '第一个问题', response: '模型原本的回答', anchorKey: 'a' },
    { turn: 2, prompt: '第二个问题', response: '要被删掉的一轮', anchorKey: 'b' },
    { turn: 3, prompt: '第三个问题', response: '原样保留', anchorKey: 'c' },
  ];
  const snapshot = { order: [], nodes: {}, navigation: { items: () => railItems } };
  const target = { getSnapshot: () => snapshot, subscribe: () => function () {} };
  const conversation = { binding: () => ({ target: () => target }) };

  // Populate the plugin's own cache the way the real client does: one GET.
  const state = {
    sessionId: 'sess-1',
    versions: [],
    messages: {},
    model: null,
    translations: {},
    turns: [{ turn: 1 }, { turn: 2 }, { turn: 3 }],
    answers: { 1: { active: 'v2', items: [{ id: 'v2', kind: 'model', text: '另一个模型写的回答' }], override: null } },
    hidden: { turns: [2], answers: [] },
  };
  const fetch = async () => ({ ok: true, json: async () => state });
  // The host's `turnOutline` keeps one entry per turn — including the deleted
  // one, which is exactly why its mark has to be hidden by position.
  const projections = [{ turn: 1 }, { turn: 2 }, { turn: 3 }];
  const { registrations } = applyToSlots({ conversation, fetch, projections });
  const registration = registrations.find((r) => r.descriptor.name === 'conversation.chat.assistant-actions');
  const injected = registration.descriptor.inject('sess-1');
  expand(registration.component(Object.assign({ sessionId: 'sess-1', messageId: 'msg-1' }, injected)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const patched = conversation.binding('sess-1').target('chat').getSnapshot().navigation.items();
  assert.equal(patched.length, 2, 'the deleted turn is gone from the rail');
  assert.deepEqual(patched.map((item) => item.turn), [1, 3]);
  assert.equal(patched[0].response, '另一个模型写的回答', 'the rail previews the answer on screen');
  assert.equal(patched[1], railItems[2], 'an untouched entry keeps its identity');
  assert.equal(conversation.binding('sess-1').target('chat').getSnapshot().navigation.items(), patched, 'the patched list is memoized');
  const railSheet = styleTags.find((tag) => tag.dataset.plugin === 'dsh-message-toolbar-rail');
  assert.ok(railSheet, 'the rail sheet is injected');
  assert.equal(railSheet.textContent, 'nav button[data-index="1"]{display:none}', 'the deleted turn keeps its projection entry, so its mark is hidden by ladder position');
});

// A switched-in answer has to read as a turn that was never answered and is
// being answered now: the logged answer goes, and so does its process card
// ("已完成 · Xs"). The run's own thinking is what stands above the text instead.
test('a switched-in answer replaces the logged one entirely', () => {
  const { css } = applyToSlots();
  const sheet = css.join('\n');
  assert.match(sheet, /\.mtt-think-body/, 'thinking has a body to fold into');
  // The ring is one more action button, not a chip: same box, same icon size.
  assert.match(sheet, /\.mtt-ring-btn\{[^}]*width:calc\(28px \+ var\(--dsh-content-font-delta,0px\)\)/);
  assert.match(sheet, /\.mtt-ring-btn svg\{width:calc\(17px \+ var\(--dsh-content-font-delta,0px\)\)/);

  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  assert.match(source, /function ThinkingBlock\(/);
  assert.match(source, /\[data-chat-flow-kind="turn-process"\]\[data-chat-turn="' \+ turn \+ '"\]\{display:none\}/, 'the old process card goes with the old answer');
  assert.match(source, /value\.type === 'reasoning'/, 'reasoning frames reach the card while the answer is written');
  assert.match(source, /reasoning: \(live\.reasoning \|\| ''\) \+ text/);
});

// A turn whose answer is gone is a question without an answer: regenerating it
// has to produce a real agent run (thinking, tool cards, streaming) rather than an
// in-place text variant. A closed turn cannot take a second answer, so the prompt
// is replayed as a new turn in the same session and that turn's prompt is hidden —
// the question stays put, and DSH's own live page streams under it.
test('regenerating a deleted answer runs a real turn in the same session', () => {
  const source = SOURCE;
  assert.match(source, /const gone = rows\.answer \|\| \(info !== undefined && info\.answered === false\);/);
  assert.match(source, /action: 'answer-run', sessionId: sessionId, turn: turn, stopPrevious: prefs\.stopPrevious/);
  assert.match(source, /action: 'hide', sessionId: sessionId, turn: result\.turn, scope: 'prompt', hidden: true/);
  // The replayed prompt never shows up as a second question of its own.
  assert.match(source, /if \(rows\.prompt\) return null;/);
  // Its rail mark is hidden by ladder position, not by dropping the entry (that
  // would shift every index after it).
  assert.match(source, /gonePrompts\.length === 0 \? goneTurns : goneTurns\.concat\(gonePrompts\)/);
  // The ladder is the union of the projection and the log's own turn list, so a
  // turn created a moment ago is still counted before the projection catches up.
  assert.match(source, /const outline = railOutline\(sessionId\);/);
  assert.match(source, /if \(state && Array\.isArray\(state\.turns\)\) {/);
  // The local cache keeps the new list too, or the prompt would flash back.
  assert.match(source, /prompts: Array\.isArray\(hidden\.prompts\) \? hidden\.prompts : \[\]/);
  // A turn that still has an answer keeps the in-place variant path.
  assert.match(source, /await generateInto\(sessionId, turn, undefined\);/);
});

// "Delete this answer" must leave nothing of that answer behind — including the
// tail row, which is where the action row and the file-change card live. The
// prompt is a different thing: it keeps its own row and its own toolbar.
test('a deleted answer takes its whole answer side with it', () => {
  const source = SOURCE;
  assert.match(source, /const DELETED_ANSWER_KINDS = \[/);
  for (const kind of ['assistant-step', 'turn-process', 'tool', 'turn-error', 'turn-tail']) {
    assert.ok(
      source.includes("'" + kind + "'"),
      'a deleted answer must hide the ' + kind + ' row too',
    );
  }
  assert.match(source, /mark\.mode === 'deleted'/);
  // ...but only while nothing of ours stands in its place: a fresh answer brings the
  // answer area (and the tail row this card lives in) back.
  assert.match(source, /const answerGone = hidden\.answer && !showingVariant;/);
  assert.match(source, /: answerGone\s*\n\s*\? 'deleted'/);
  // A switched-in or translated answer keeps the tail row (file changes belong to
  // the turn, not to the answer that was replaced).
  // One owner per turn: the toolbar no longer registers a hide mark of its own,
  // so a fresh answer can never be hidden by the mark left from its deletion.
  assert.doesNotMatch(source, /hiddenRows\.turn \? 'turn'/);
  assert.match(source, /Hiding the turn's rows is the answer card's job/);
  // Only the user row deletes a whole turn; every answer-side delete (including
  // a failed one) stays on the answer scope, so the prompt survives.
  assert.equal((source.match(/scope: 'turn', hidden: true/g) || []).length, 1);
  assert.match(source, /scope: 'answer', hidden: true/);
});

// A translation is drawn by this card as a paired page, so the card has to keep
// painting the answer area while it is on. When it did not, the logged body was
// hidden by the `translate` mark and the card returned null: a blank answer.
test('a translated answer paints the paired page instead of a blank area', async () => {
  const state = {
    sessionId: 'sess-1',
    versions: [], messages: {}, model: null,
    turns: [{ turn: 1, answered: true }],
    translations: { 18: { zh: { text: '**中文标题**\n\n第二段译文', provider: 'p', model: 'm', turn: 1, role: 'assistant', at: 1 } } },
    origins: { 1: '**German title**\n\nZweiter Absatz' },
    shown: { 1: 'zh' },
    answers: {},
    hidden: { turns: [], answers: [], prompts: [] },
  };
  const fetch = async () => ({ ok: true, json: async () => state });
  const { registrations } = applyToSlots({ fetch });
  const card = registrations.find((r) => r.descriptor.name === 'conversation.chat.turnTail');
  const injected = card.descriptor.inject('sess-1');
  const props = Object.assign({ sessionId: 'sess-1', turn: 1, seq: 20, openFile() {} }, injected);
  // The card loads its payload on mount; render again once the store has it.
  card.component(props);
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const nodes = expand(card.component(props));
  const classes = nodes.map((n) => n.props && n.props.className).filter(Boolean);
  assert.ok(classes.indexOf('mtt-pair') !== -1, 'the paired page is drawn: ' + classes.join(' | '));
  assert.ok(classes.indexOf('mtt-pair-src') !== -1, 'the original paragraph stays on screen');
  assert.ok(classes.indexOf('mtt-pair-tr') !== -1, 'and its translation follows it');
});

// A translation is as long as the answer it translates, so it is streamed: the
// page appears at the first token and grows, with the waiting dots standing where
// the words are not yet.
test('a translation streams into the paired page', () => {
  const source = SOURCE;
  const { css } = applyToSlots();
  const sheet = Array.isArray(css) ? css.join('\n') : css;
  // One reader serves both writers, and the translation has its own live cell.
  assert.match(source, /async function streamOperation\(operation, handlers\)/);
  assert.match(source, /async function translateInto\(sessionId, turn, body\)/);
  assert.match(source, /store\.setLiveTranslation\(sessionId, turn, seed\)/);
  assert.match(source, /function useLiveTranslation\(sessionId, turn\)/);
  // The card decides from the translation it is streaming as well...
  assert.match(source, /const drawing = showingVariant \|\| translation !== null \|\| liveTranslation !== null;/);
  // ...and draws the whole original in one block while the translation grows,
  // so text does not jump between blocks mid-stream.
  assert.match(source, /const pairs = streaming\s*\n\s*\? \[\{ source: source, translation: liveTranslation\.text \|\| '' \}\]/);
  assert.match(source, /streaming && last \? h\(Dots, null\) : null/);
  assert.match(sheet, /\.mtt-dots\{display:inline-flex/);
  assert.match(sheet, /@keyframes mtt-dot\{/);
  assert.match(sheet, /prefers-reduced-motion:reduce\)\{\.mtt-dots i\{animation-duration:2\.4s/);
  // A translation is never given a token cap: any cap is a guess that cuts a long
  // answer mid-sentence, so the provider's own window is the only limit.
  assert.doesNotMatch(source, /maxTokens/);
});
// Text must never be painted with a literal colour: every value has to come
// from a theme alias, otherwise dark mode keeps light-mode ink. `CanvasText`
// and friends are system colours, so they follow the app's colour scheme too.
// A translation takes a moment, and the button that started it is the only place
// that can say so: the glyph becomes the app's own loading arc while it waits, the
// menu cannot open meanwhile, and the glyph comes back when the answer lands.
test('the translate button spins while a translation is on its way', () => {
  const source = SOURCE;
  const { css } = applyToSlots();
  const sheet = Array.isArray(css) ? css.join('\n') : css;
  assert.match(source, /function LoadingIcon\(\)/);
  assert.match(source, /props\.busy === true \? h\(LoadingIcon\) : h\(TranslateIcon\)/);
  assert.match(source, /const \[translating, setTranslating\] = React\.useState\(false\);/);
  assert.match(source, /setTranslating\(true\);/);
  assert.match(source, /setTranslating\(false\);/);
  assert.match(source, /busyTitle: t\('translating'\)/);
  assert.match(sheet, /\.mtt-spin\{animation:mtt-spin 900ms linear infinite/);
  assert.match(sheet, /@keyframes mtt-spin\{/);
});
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


