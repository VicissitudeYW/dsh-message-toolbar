// Builds a throwaway visual harness for the plugin's CSS: pulls the real theme
// variables out of @deepseek-ai/dsh-client-ui-theme and the plugin stylesheet
// out of the built bundle, then paints the same menu markup twice — once on a
// light <body> and once on <body data-ds-dark-theme> — so a screenshot shows at
// a glance whether the plugin follows the theme.
//
//   node scripts/preview-menu.mjs [out.html]
//
// Then: msedge --headless=new --screenshot=out.png file:///.../preview-menu.html

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const out = process.argv[2] ?? path.join(root, 'test', 'preview-menu.html');

const themePackage = process.env.DSH_THEME_CLIENT
  ?? 'D:/Dev/npm/npm-global/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js';

function themeCss() {
  const source = fs.readFileSync(themePackage, 'utf8');
  const chunks = [];
  for (const match of source.matchAll(/"((?:[^"\\]|\\.){500,})"/g)) {
    let text;
    try { text = JSON.parse('"' + match[1] + '"'); } catch { continue; }
    if (text.includes('--dsw-alias-bg-base') || text.includes('--dsw-static-neutral-bluish-00')) chunks.push(text);
  }
  return chunks.join('\n');
}

function pluginCss() {
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

const markup = `
<div class="mock">
  <div class="mtt-row">
    <div class="mtt-line">
      <div class="mtt-bubble">帮我把深色模式适配一下，顺便看看用户消息的框为什么变灰了。</div>
    </div>
    <div class="mtt-actions">
      <span class="mtt-toolbar">
        <button class="mtt-act">copy</button><button class="mtt-act">✎</button>
        <span class="mtt-ring"><button class="mtt-ring-btn">‹</button>1/1<button class="mtt-ring-btn">›</button></span>
      </span>
    </div>
  </div>
  <div class="mock-row">
    <span class="mtt-toolbar">
      <button class="mtt-act" title="retry">↻</button>
      <button class="mtt-act" title="edit">✎</button>
      <button class="mtt-act mtt-act-on" title="model">⌥</button>
      <span class="mtt-menu-wrap">
        <div class="mtt-pop mtt-pop-wide">
          <div class="mtt-pop-title">Pick a model — its answer replaces this one in place</div>
          <div class="mtt-pop-group">DeepSeek</div>
          <button class="mtt-pop-item">deepseek-chat <span class="mtt-pop-item-sub">current</span></button>
          <button class="mtt-pop-item">deepseek-reasoner <span class="mtt-pop-item-sub">tools on</span></button>
          <div class="mtt-pop-group">OpenAI</div>
          <button class="mtt-pop-item">gpt-4o-mini</button>
          <div class="mtt-pop-foot">
            <button class="mtt-pop-item">Open a new branch instead…</button>
          </div>
        </div>
      </span>
      <button class="mtt-act" title="translate">文A</button>
      <button class="mtt-act" title="delete">🗑</button>
    </span>
  </div>

  <div class="mtt-alt">
    <div class="mtt-alt-head">
      <span class="mtt-alt-badge">Variants</span>
      <span class="mtt-ring"><button class="mtt-ring-btn">‹</button>2/3<button class="mtt-ring-btn">›</button></span>
      <span class="mtt-alt-tag">deepseek-reasoner</span>
      <span class="mtt-alt-tag mtt-alt-tag-edit">edited</span>
      <span class="mtt-alt-tools">
        <button class="mtt-act">copy</button><button class="mtt-act">✎</button><button class="mtt-act">↻</button>
      </span>
    </div>
    <div class="mtt-alt-body">The variant body sits here, on the same surface as the conversation.</div>
  </div>

  <div class="mtt-alt mtt-alt-native">
    <div class="mtt-alt-head"><span class="mtt-alt-badge">Variants</span><span class="mtt-ring">1/3</span></div>
    <div class="mtt-alt-note">Showing DSH's own answer for this turn.</div>
  </div>

  <div class="mtt-trans-card">
    <div class="mtt-trans-head"><span class="mtt-trans-badge">Translation</span><span class="mtt-trans-lang">zh</span>
      <span class="mtt-trans-model">deepseek-chat</span><button class="mtt-trans-toggle">hide</button></div>
    <div class="mtt-trans-body">这是译文，双语排版时原文保留在上方。</div>
  </div>

  <div class="mtt-pop mtt-pop-confirm mock-static">
    <div class="mtt-pop-title">Delete this version card?</div>
    <div class="mtt-pop-actions">
      <button class="mtt-btn mtt-btn-small">Cancel</button>
      <button class="mtt-btn mtt-btn-danger mtt-btn-small">Delete</button>
    </div>
  </div>

  <div class="mock-line"><span class="mtt-chip">deepseek-reasoner</span>
    <button class="mtt-btn">Neutral</button><button class="mtt-btn mtt-btn-primary">Save</button></div>
  <div class="mock-line"><textarea class="mtt-answer-textarea">Editable answer text…</textarea></div>
  <div class="mock-line"><span class="mtt-error">重答失败：模型返回了空内容</span>
    <span class="mtt-notice">已切换回答</span></div>
  <div class="mock-line"><div class="mtt-node-card">
    <div class="mtt-node-head"><span class="mtt-node-title">turn 2 · deepseek-reasoner</span>
      <span class="mtt-node-tag mtt-node-tag-current">current</span><span class="mtt-node-time">14:20</span></div>
    <div class="mtt-node-text">Version tree card preview…</div></div></div>
</div>`;

function frame(dark) {
  const body = dark ? '<body data-ds-dark-theme>' : '<body>';
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0}
body{background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#111);font:13px/1.5 system-ui,sans-serif;padding:14px}
.mock{display:flex;flex-direction:column;gap:10px}
.mock-row{display:flex;justify-content:flex-end}
.mock-line{display:flex;gap:8px;align-items:center}
.mock-static{position:static;right:auto;top:auto;max-width:none}
${dark ? '' : ''}
</style><style>${THEME}</style><style>${PLUGIN}</style></head>${body}${markup}</body></html>`;
}

const THEME = themeCss();
const PLUGIN = pluginCss();
if (!THEME.includes('--dsw-alias-bg-base')) throw new Error('theme variables not found');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;display:flex;gap:0;background:#666;font:12px system-ui}
section{flex:1;min-width:0}
h2{margin:0;padding:6px 10px;background:#333;color:#fff;font:600 12px system-ui}
iframe{border:0;width:100%;height:760px;display:block}
</style></head><body>
<section><h2>light</h2><iframe srcdoc="${frame(false).replace(/"/g, '&quot;')}"></iframe></section>
<section><h2>dark</h2><iframe srcdoc="${frame(true).replace(/"/g, '&quot;')}"></iframe></section>
</body></html>`;

fs.writeFileSync(out, html);
console.log('wrote ' + out + ' (' + Math.round(html.length / 1024) + ' kB, theme css ' + Math.round(THEME.length / 1024) + ' kB)');
