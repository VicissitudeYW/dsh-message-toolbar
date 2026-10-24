// Shared plumbing for the visual harnesses (scripts/preview-menu.mjs and
// scripts/showcase.mjs): the app's theme variables and this plugin's stylesheet,
// both read from the packages that actually ship, so a rendered preview can
// never drift from what the plugin does.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.dirname(here);

const THEME_CLIENT = process.env.DSH_THEME_CLIENT
  ?? 'D:/Dev/npm/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js';

/**
 * Every light and dark token block from the theme plugin. Declared on `body` and
 * `body[data-ds-dark-theme]`, which is exactly why the plugin's own aliases live
 * on `body` too — a `:root` alias would resolve once, at parse time, and freeze
 * the light values.
 */
export function themeCss() {
  const source = fs.readFileSync(THEME_CLIENT, 'utf8');
  const chunks = [];
  for (const match of source.matchAll(/"((?:[^"\\]|\\.){500,})"/g)) {
    let text;
    try { text = JSON.parse('"' + match[1] + '"'); } catch { continue; }
    if (text.includes('--dsw-alias-bg-base') || text.includes('--dsw-static-neutral-bluish-00')) chunks.push(text);
  }
  return chunks.join('\n');
}

/**
 * The plugin's own stylesheet, captured by running the built bundle against a
 * document stub: `apply()` inserts it through the module loader's `styles` slot,
 * so whatever this returns is byte for byte what the app injects.
 */
export function pluginCss() {
  const source = fs.readFileSync(path.join(root, 'lib', 'client.js'), 'utf8');
  const captured = [];
  globalThis.document = {
    querySelector() { return null; },
    createElement() { return { dataset: {}, textContent: '' }; },
    head: { appendChild(tag) { captured.push(tag.textContent); } },
  };
  let entry;
  const window = { __ModuleLoader__: { load(value) { entry = value; } } };
  new Function('window', source)(window);
  const React = {
    createElement(type, props, ...kids) {
      const merged = Object.assign({}, props);
      if (kids.length) merged.children = kids;
      return { type, props: merged };
    },
    useState(init) { return [typeof init === 'function' ? init() : init, function () {}]; },
    useReducer(reducer, init) { return [init, function () {}]; },
    useEffect() {},
    useRef(init) { return { current: init === undefined ? null : init }; },
  };
  const mod = entry.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unexpected require(' + name + ')');
  });
  const services = {
    slots: { inject(name, factory) { return factory(); }, register() { return function () {}; } },
    sessions: { list: { getSnapshot() { return { byId: {} }; }, subscribe() { return function () {}; } } },
    locale: { register() { return function () {}; }, bind() { return function (key) { return key; }; } },
    uiWorkspace: { openSession() {} },
  };
  mod.apply({ get: (name) => services[name], effect: (fn) => fn() });
  return captured.join('\n');
}
