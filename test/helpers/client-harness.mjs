import fs from 'node:fs';
import vm from 'node:vm';

export function element(tag = 'div') {
  return {
    tagName: tag.toUpperCase(), style: {}, dataset: {}, children: [], attrs: {}, isConnected: true, textContent: '',
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(key, value) { this.attrs[key] = String(value); },
    getAttribute(key) { return this.attrs[key] ?? null; },
    removeAttribute(key) { delete this.attrs[key]; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {}, remove() {}, focus() {},
  };
}

export function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export function state(extra = {}) {
  return {
    turns: [{ turn: 1, text: 'question', answered: true, answerText: 'original answer' }],
    versions: [], messages: [], answers: {}, prompts: {}, translations: {}, origins: {}, shown: {}, runs: {},
    hidden: { turns: [], answers: [], prompts: [] }, ...extra,
  };
}

export const jsonResponse = (value) => ({ ok: true, status: 200, json: async () => value });
export const streamResponse = (frames) => ({ ok: true, status: 200, text: async () => frames.map(JSON.stringify).join('\n') + '\n' });
export const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Execute the real source inside the same factory/IIFE shape as the shipped web
// bundle. Only the browser, React hooks and native primitives are test doubles.
// Extra exports are injected into this in-memory copy, never production code.
export function clientHarness(options = {}) {
  const hooks = new Map();
  const classes = new Map();
  let current, hookIndex, pending = false, effects = [], ordinals;
  class Component {
    constructor(props) { this.props = props; this.state = {}; }
    setState(next) { this.state = { ...this.state, ...next }; pending = true; }
  }
  const React = {
    Component, Fragment: 'fragment',
    createElement(type, props, ...children) {
      return { type, props: { ...props, children: children.length === 1 ? children[0] : children } };
    },
    memo: (fn) => fn,
    useState(initial) {
      const at = hookIndex++;
      if (!current[at]) current[at] = { value: typeof initial === 'function' ? initial() : initial };
      const cell = current[at];
      return [cell.value, (next) => {
        const value = typeof next === 'function' ? next(cell.value) : next;
        if (!Object.is(value, cell.value)) { cell.value = value; pending = true; }
      }];
    },
    useReducer(reducer, initial) {
      const [value, setValue] = React.useState(initial);
      return [value, (action) => setValue((old) => reducer(old, action))];
    },
    useRef(initial) { return React.useState(() => ({ current: initial }))[0]; },
    useEffect(fn, deps) {
      const at = hookIndex++, previous = current[at];
      if (previous && deps && previous.deps && deps.length === previous.deps.length
        && deps.every((value, index) => Object.is(value, previous.deps[index]))) return;
      const cell = { deps, cleanup: undefined };
      current[at] = cell;
      effects.push(() => { previous?.cleanup?.(); cell.cleanup = fn(); });
    },
    useMemo: (fn) => fn(), useCallback: (fn) => fn,
  };
  React.useLayoutEffect = React.useEffect;
  function expand(node) {
    if (node == null || typeof node === 'boolean') return [];
    if (Array.isArray(node)) return node.flatMap(expand);
    if (typeof node !== 'object') return [{ type: '#text', text: String(node), props: {}, children: [] }];
    const { type, props } = node;
    if (type === React.Fragment) return expand(props.children);
    if (typeof type === 'function') {
      const ordinal = ordinals.get(type) || 0;
      ordinals.set(type, ordinal + 1);
      const key = type.name + ':' + ordinal;
      if (type.prototype instanceof Component) {
        if (!classes.has(key)) classes.set(key, new type(props));
        const instance = classes.get(key); instance.props = props;
        return expand(instance.render());
      }
      if (!hooks.has(key)) hooks.set(key, []);
      const previous = current, previousIndex = hookIndex;
      current = hooks.get(key); hookIndex = 0;
      let result;
      try { result = type(props); } finally { current = previous; hookIndex = previousIndex; }
      return expand(result);
    }
    if (props.ref && typeof props.ref === 'object' && options.elementRef) props.ref.current = options.elementRef(type, props);
    return [{ type, props, children: expand(props.children) }];
  }
  function render(type, props) {
    for (let pass = 0; pass < 30; pass++) {
      pending = false; effects = []; ordinals = new Map();
      const tree = expand({ type, props });
      for (const effect of effects) effect();
      if (!pending) return tree;
    }
    throw new Error('Client render did not settle');
  }
  const document = {
    documentElement: { lang: 'en' }, head: element('head'), body: element('body'),
    createElement: element, querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, removeEventListener() {},
  };
  const timers = new Map(); let timerId = 0;
  const events = new EventTarget();
  const window = {
    fetch: async () => { throw new Error('Unexpected fetch'); }, document,
    localStorage: { getItem() { return null; }, setItem() {} },
    navigator: { language: 'en', clipboard: { writeText: async () => {} } },
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events), CustomEvent, innerHeight: 900,
  };
  const primitives = {
    MarkdownText: (props) => React.createElement('div', { className: 'native-md' }, props.text),
    TextShimmer: (props) => props.children,
    Menu: (props) => React.createElement('menu', props, props.anchor),
  };
  const require = (name) => {
    if (name === 'react') return React;
    if (name === 'react-dom') return { createPortal: (node) => node };
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return primitives;
    throw new Error('Unexpected require ' + name);
  };
  const exports = `store, AnswerCard, AssistantToolbar, UserRow, translateInto, cancelTranslation, contextRingChoices,
    nativeHideStyle, railTarget, outlineFace, streamOperation, patchRailItems, rerunAfterRevert,
    changeContext, switchToVersion, ContextFocus, VersionsView,
    __getNavigation: function() { return navigation; }, __setNavigation: function(value) { navigation = value; }`;
  const source = fs.readFileSync(new URL('../../plugin.client.js', import.meta.url), 'utf8')
    .replace(/\nreturn \{\r?\n  inject:/, '\nreturn { __test: { ' + exports + ' },\n  inject:');
  const context = vm.createContext({ window, document, require, console, TextDecoder, URL, AbortController,
    setTimeout: (fn) => { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout: (id) => timers.delete(id),
  });
  const module = vm.runInContext('(function(require){const React=require("react");const styles={insert(){return()=>{}}};return(function(){'
    + source + '\n})();})', context)(require);
  const opened = [];
  module.__test.__setNavigation({ openVersion(id) { opened.push(id); } });
  return { ...module.__test, window, document, render, timers, opened,
    installWorkspaceNavigation(byId = { source: {}, target: {} }) {
      const services = {
        slots: { inject() {}, register() {} },
        sessions: { list: { getSnapshot: () => ({ byId }), subscribe: () => () => {} } },
        uiWorkspace: { openSession: (id) => { opened.push(id); } },
      };
      module.apply({ get: (name) => services[name], effect() {} });
      return module.__test.__getNavigation();
    },
    unmount(type, ordinal = 0) {
      const selected = type ? [[type.name + ':' + ordinal, hooks.get(type.name + ':' + ordinal)]] : [...hooks];
      for (const [key, cells] of selected) {
        for (const cell of cells || []) {
          if (typeof cell.cleanup === 'function') { const cleanup = cell.cleanup; cell.cleanup = undefined; cleanup(); }
        }
        hooks.delete(key);
      }
    },
    mount(type, props) { return () => render(type, props); },
  };
}

export function findAll(nodes, predicate) {
  return nodes.flatMap((node) => [...predicate(node) ? [node] : [], ...findAll(node.children || [], predicate)]);
}
export const byClass = (tree, name) => findAll(tree, (node) => (node.props.className || '').split(' ').includes(name));
export const textOf = (node) => node.type === '#text' ? node.text : (node.children || []).map(textOf).join('');
