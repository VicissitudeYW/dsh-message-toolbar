
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
    createElement(type, props) { return { type, props }; },
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
  const slots = registrations.map((r) => r.descriptor.name).sort();
  assert.deepEqual(slots, [
    'conversation.chat.assistant-actions',
    'conversation.chat.node',
    'conversation.chat.turnTail',
    'conversation.view',
    'settings.section',
  ]);
  for (const entry of registrations) assert.equal(typeof entry.component, 'function');
});

test('the user bubble is shadowed at the lowest priority', () => {
  const { registrations } = applyToSlots();
  const node = registrations.find((r) => r.descriptor.name === 'conversation.chat.node');
  assert.equal(node.descriptor.key, 'user');
  assert.equal(node.descriptor.priority, -1);
});

test('the assistant action row receives a session-scoped inject', () => {
  const { registrations } = applyToSlots();
  const actions = registrations.find((r) => r.descriptor.name === 'conversation.chat.assistant-actions');
  assert.equal(typeof actions.descriptor.inject, 'function');
  assert.deepEqual(actions.descriptor.inject('sess-1'), { sessionId: 'sess-1' });
});
