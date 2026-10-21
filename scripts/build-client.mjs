
// Wrap plugin.client.js into the DSH web module format (lib/client.js).
// The factory provides `React` and `styles` to the plugin body, which is an
// IIFE returning `{ inject, apply }` — the Cordis client plugin shape.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const src = path.join(root, 'plugin.client.js');
const dst = path.join(root, 'lib', 'client.js');

const body = fs.readFileSync(src, 'utf8');

const output = `window.__ModuleLoader__.load({
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
${body}
    })();
  }
});
`;

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, output, 'utf8');
console.log('built lib/client.js (' + output.length + ' bytes)');
