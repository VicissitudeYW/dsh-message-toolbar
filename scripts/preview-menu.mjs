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
import { root, themeCss, pluginCss } from './preview-assets.mjs';

const out = process.argv[2] ?? path.join(root, 'test', 'preview-menu.html');

const markup = `
<div class="mock">
  <div class="mtt-row">
    <div class="mtt-line">
      <div class="mtt-stack">
        <div class="mtt-attach-row">
          <div class="mtt-tile">
            <img class="mtt-tile-img" alt="shot.png" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%237aa7f7'/%3E%3Cstop offset='1' stop-color='%234b6fa8'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='64' height='64' fill='url(%23g)'/%3E%3Ccircle cx='46' cy='18' r='7' fill='%23ffffff' opacity='.75'/%3E%3Cpath d='M0 52l20-16 14 11 12-8 18 13v12H0z' fill='%23ffffff' opacity='.35'/%3E%3C/svg%3E">
          </div>
          <div class="mtt-file" title="CV.pdf">
            <span class="mtt-file-icon mtt-file-icon-plain">PDF</span>
            <div class="mtt-file-body">
              <div class="mtt-file-name">CV.pdf</div>
              <div class="mtt-file-meta">PDF 248.6KB</div>
            </div>
          </div>
        </div>
        <div class="mtt-bubble">帮我把深色模式适配一下，顺便看看用户消息的框为什么变灰了。</div>
      </div>
    </div>
    <div class="mtt-actions">
      <span class="mtt-toolbar">
        <button class="mtt-act">copy</button><button class="mtt-act">✎</button>
        <span class="mtt-ring"><button class="mtt-ring-btn"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12"></path></svg></button><button class="mtt-ring-btn mtt-ring-num">1/1</button><button class="mtt-ring-btn"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4"></path></svg></button></span>
      </span>
    </div>
  </div>
  <div class="mock-row">
    <span class="mtt-toolbar">
      <button class="mtt-act" title="retry">↻</button>
      <button class="mtt-act" title="edit">✎</button>
      <button class="mtt-act mtt-act-on" title="model">⌥</button>
      <span class="mtt-menu-wrap">
        <div class="mtt-pop mtt-pop-wide mock-static">
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
      <span class="mtt-ring"><button class="mtt-ring-btn"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12"></path></svg></button><button class="mtt-ring-btn mtt-ring-num">2/2</button><button class="mtt-ring-btn"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4"></path></svg></button></span>
    </span>
  </div>

  <div class="mtt-answer">
    <div class="mtt-think">
      <button class="mtt-think-head mtt-think-open">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4L9.5 8L6 12"></path></svg>
        <span>思考过程</span>
      </button>
      <div class="mtt-think-body">用户要我把深度模式的对比度调好，先看现在用了哪些 token……</div>
    </div>
    <div class="mtt-answer-body">The answer body sits here, rendered by the same Markdown component the chat view uses.</div>
  </div>

  <div class="mtt-answer">
    <div class="mtt-answer-wait">
      <span class="mtt-wait-text">正在生成…</span>
    </div>
  </div>

  <div class="mtt-answer">
    <div class="mtt-pair">
      <div class="mtt-pair-block">
        <div class="mtt-pair-src">这段回答被翻译成中文之后，原文并没有被换掉——它留在这里，译文跟在下面。</div>
        <div class="mtt-pair-tr">The original is not replaced once it has been translated — it stays here, and the translation follows it.</div>
      </div>
      <div class="mtt-pair-block">
        <div class="mtt-pair-src">段落一段对一段，所以读的时候不需要来回找。</div>
        <div class="mtt-pair-tr">Paragraph sits beside paragraph, so nothing has to be hunted for.<span class="mtt-dots" aria-hidden="true"><i></i><i></i><i></i></span></div>
      </div>
    </div>
  </div>

  <div class="mtt-pop mtt-pop-confirm mock-static">
    <div class="mtt-pop-title">Delete this answer?</div>
    <div class="mtt-pop-actions">
      <button class="mtt-btn mtt-btn-small">Cancel</button>
      <button class="mtt-btn mtt-btn-danger mtt-btn-small">Delete</button>
    </div>
  </div>

  <div class="mtt-answer"><div class="mtt-answer-body">A plain answer body — this text has to follow the theme, never the browser's default ink.</div>
  </div>

  <!-- A turn that ended without an answer: the row our plugin draws, which has to
       start at the same x as the text above it rather than hug the right edge. -->
  <div class="mtt-answer">
    <div class="mtt-tail-actions">
      <span class="mtt-toolbar">
        <button class="mtt-act" title="Regenerate">&#8635;</button>
        <button class="mtt-act" title="Switch model">&#8644;</button>
        <button class="mtt-act" title="Delete">&#128465;</button>
      </span>
    </div>
  </div>

  <div class="mtt-answer">
    <div class="mtt-answer-edit mtt-answer-edit-prompt">
      <div class="mtt-answer-edit-head">
        <span class="mtt-answer-edit-label">Editing · 编辑中</span>
        <span class="mtt-answer-edit-tools">
          <button class="mtt-act" title="Close">✕</button>
          <button class="mtt-btn mtt-btn-small mtt-btn-primary">Save</button>
        </span>
      </div>
      <div class="mtt-rail">
        <div class="mtt-tile">
          <img class="mtt-tile-img" alt="drop.png" src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Crect width='64' height='64' fill='%23d8e3f6'/%3E%3Cpath d='M8 46l14-14 10 8 9-7 15 13v10H8z' fill='%236f8fbd'/%3E%3Ccircle cx='44' cy='18' r='6' fill='%23f2f6ff'/%3E%3C/svg%3E">
          <button class="mtt-tile-remove" type="button" title="Remove">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"></path></svg>
          </button>
        </div>
        <div class="mtt-file" title="notes.pdf">
          <span class="mtt-file-icon mtt-file-icon-plain">PDF</span>
          <div class="mtt-file-body">
            <div class="mtt-file-name">notes.pdf</div>
            <div class="mtt-file-meta">PDF 4.2KB</div>
          </div>
          <button class="mtt-file-remove" type="button" title="Remove">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"></path></svg>
          </button>
        </div>
        <div class="mtt-file mtt-file-busy" title="Uploading">
          <span class="mtt-file-spin"></span>
          <div class="mtt-file-body"><div class="mtt-file-name">Uploading…</div></div>
        </div>
      </div>
      <textarea class="mtt-answer-edit-input" rows="7">### 一、你的清单里漏了刷题

你上一条自己说的是 "每天刷题 + Zero to Hero + 项目"，这一条却把刷题丢了。刷题是**唯一一个必须每天碰**的东西。

把它当成刷牙：**不看心情，每天 1–2 题**，Hot 100 为主。</textarea>
    </div>
  </div>

  <div class="mtt-toast mtt-toast-ok mock-static">Answer deleted</div>
  <div class="mtt-toast mtt-toast-bad mock-static">删除失败：正在运行的宿主插件还是旧版本。</div>

  <div class="mock-line"><span class="mtt-chip">deepseek-reasoner</span>
    <button class="mtt-btn">Neutral</button><button class="mtt-btn mtt-btn-primary">Save</button></div>
  <div class="mock-line"><textarea class="mtt-answer-textarea">Editable answer text…</textarea></div>
  <div class="mock-line"><span class="mtt-error">重答失败：模型返回了空内容</span></div>
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
.mock-static{position:static!important;right:auto;top:auto;max-width:none;inset:auto}
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
iframe{border:0;width:100%;height:700px;display:block}
</style></head><body>
<section><h2>light</h2><iframe srcdoc="${frame(false).replace(/"/g, '&quot;')}"></iframe></section>
<section><h2>dark</h2><iframe srcdoc="${frame(true).replace(/"/g, '&quot;')}"></iframe></section>
</body></html>`;

fs.writeFileSync(out, html);
console.log('wrote ' + out + ' (' + Math.round(html.length / 1024) + ' kB, theme css ' + Math.round(THEME.length / 1024) + ' kB)');