// Builds the figures used by the README.
//
// These are *not* screenshots of anybody's conversation: each scene is a
// standing demo painted with the plugin's own stylesheet (`lib/client.js`) on the
// app's own theme variables, so what the image shows is exactly the CSS and the
// icon geometry that ships. Nothing personal, nothing to redact, and it stays
// reproducible — which is why the scenes live in the repository.
//
//   node scripts/showcase.mjs              # writes test/showcase/*.html
//   node scripts/showcase.mjs --dark       # dark variants, same scenes
//
// Then render one page per figure (Edge, headless, window width 1000) and trim
// the leftover background below the scene:
//
//   msedge --headless=new --disable-gpu --hide-scrollbars --no-first-run \
//     --user-data-dir=<tmp> --window-size=1000,1200 \
//     --screenshot=out.png "file:///<repo>/test/showcase/01-toolbar.html"

import fs from 'node:fs';
import path from 'node:path';
import { root, themeCss, pluginCss } from './preview-assets.mjs';

const DARK = process.argv.includes('--dark');
const outDir = path.join(root, 'test', 'showcase');
fs.mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------------ icons -- */
// Copied from plugin.client.js on purpose: the README figure has to show the
// real 16-unit glyphs, not stand-ins, and an SVG is the whole definition.

const wrap = (children, extra = '') => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke-width="1" aria-hidden="true"${extra}>${children}</svg>`;

const ICONS = {
  copy: wrap('<rect x="1.52075" y="4.07373" width="10.3932" height="10.3932" rx="2" stroke="currentColor"/><path fill="currentColor" d="M11.9792 1.53296C13.36 1.53296 14.4792 2.65225 14.4792 4.03296V9.42847C14.4792 10.3756 13.9521 11.1987 13.1755 11.6228V10.3298C13.3652 10.0787 13.4792 9.7674 13.4792 9.42847V4.03296C13.4792 3.20453 12.8077 2.53296 11.9792 2.53296H6.58374C6.27966 2.53301 5.99684 2.6235 5.7605 2.77905H4.42358C4.85652 2.03463 5.66056 1.53304 6.58374 1.53296H11.9792Z"/>'),
  pencil: wrap('<path fill="currentColor" d="M8.85596 2.69971H4.19971C3.37141 2.69971 2.69992 3.37146 2.69971 4.19971V11.8003C2.69992 12.6285 3.37141 13.3003 4.19971 13.3003H11.8003C12.6283 13.2999 13.3001 12.6283 13.3003 11.8003V7.89893H14.3003V11.8003C14.3001 13.1806 13.1806 14.2999 11.8003 14.3003H4.19971C2.81913 14.3003 1.69992 13.1808 1.69971 11.8003V4.19971C1.69992 2.81918 2.81913 1.69971 4.19971 1.69971H8.85596V2.69971Z"/><path d="M7.7849 8.23878L13.888 2.13574" stroke="currentColor"/>'),
  retry: wrap('<path stroke="currentColor" d="M14.5001 8C14.5 9.28552 14.1188 10.5422 13.4045 11.611C12.6903 12.6799 11.6752 13.5129 10.4875 14.0049C9.29982 14.4968 7.99295 14.6255 6.73212 14.3747C5.4713 14.124 4.31314 13.505 3.4041 12.596C2.49514 11.687 1.87614 10.5288 1.62537 9.26798C1.37459 8.00716 1.50331 6.70028 1.99525 5.51261C2.48719 4.32494 3.32025 3.30981 4.3891 2.59557C5.45795 1.88134 6.71458 1.50008 8.0001 1.5C9.9001 1.5 11.7001 2.3 13.0001 3.6L14.5001 5.1"/><path d="M14.4999 1.5V5.1H10.8999" stroke="currentColor"/>'),
  sliders: wrap('<path d="M2.3 5h5.85M12.05 5h1.65" stroke="currentColor" stroke-linecap="round"/><circle cx="9.95" cy="5" r="1.45" stroke="currentColor" stroke-linecap="round"/><path d="M2.3 11h1.65M7.85 11h5.85" stroke="currentColor" stroke-linecap="round"/><circle cx="5.75" cy="11" r="1.45" stroke="currentColor" stroke-linecap="round"/>'),
  translate: wrap('<path d="M2 4.6h7M5.6 2.4v2.2M2.9 6.9c.9 2.4 2.4 4.4 4.4 6.1M8.2 6.9c-1 2.6-2.8 4.9-5.6 6.7" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/><path d="M12.4 3.1L10.3 13.6h4.4L12.4 3.1M11.1 10.4h2.9" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>'),
  trash: wrap('<path d="M1.28149 3.88831H14.7187" stroke="currentColor"/><path stroke="currentColor" d="M5.41602 3.88833V2.47962C5.41602 2.29282 5.52492 2.11366 5.71876 1.98157C5.9126 1.84948 6.17551 1.77527 6.44964 1.77527H9.55053C9.82466 1.77527 10.0876 1.84948 10.2814 1.98157C10.4753 2.11366 10.5842 2.29282 10.5842 2.47962V3.88833"/><path stroke="currentColor" d="M2.57349 3.88831L3.19366 13.2943C3.21937 13.5502 3.33952 13.7872 3.53065 13.9593C3.72178 14.1313 3.97016 14.2259 4.22729 14.2246H11.7728C12.0299 14.2259 12.2783 14.1313 12.4694 13.9593C12.6605 13.7872 12.7807 13.5502 12.8064 13.2943L13.4266 3.88831"/><path d="M6.44946 6.98926V11.1238" stroke="currentColor"/><path d="M9.55054 6.98926V11.1238" stroke="currentColor"/>'),
  close: wrap('<path d="M2.5 2.5L13.5 13.5" stroke="currentColor"/><path d="M13.5 2.5L2.5 13.5" stroke="currentColor"/>'),
  left: wrap('<path d="M10 4L6.70711 7.29289C6.31658 7.68342 6.31658 8.31658 6.70711 8.70711L10 12" stroke="currentColor"/>'),
  right: wrap('<path d="M6 12L9.29289 8.70711C9.68342 8.31658 9.68342 7.68342 9.29289 7.29289L6 4" stroke="currentColor"/>'),
  chevron: wrap('<path d="M6 4L9.5 8L6 12" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"/>'),
};

const act = (icon, title, extra = '') => `<button class="mtt-act" type="button" title="${title}"${extra}>${ICONS[icon]}</button>`;

const ring = (count) => `<span class="mtt-ring">`
  + `<button class="mtt-ring-btn" type="button" title="上一个回答">${ICONS.left}</button>`
  + `<span class="mtt-ring-count">${count}</span>`
  + `<button class="mtt-ring-btn" type="button" title="下一个回答">${ICONS.right}</button>`
  + `</span>`;

const toolbar = (inner) => `<span class="mtt-toolbar">${inner}</span>`;

/* ---------------------------------------------------------------- chrome -- */
// The pane around the plugin's own surfaces: a neutral chat column and plain
// markdown typography. Deliberately plain — the point of the figure is the
// toolbar, not the surrounding application.

const CHROME = `
html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base,#fff)}
body{
  color:var(--dsw-alias-label-primary,#111);
  font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans SC",system-ui,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.scene{width:1000px;padding:26px 0 24px}
.column{width:760px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
/* The action row is hover-only in the product; a figure has no pointer. */
.mock-hover .mtt-actions{opacity:1}
.mtt-answer-body{font-size:var(--dsh-content-font-size,14px);line-height:1.7}
.mtt-answer-body> :first-child{margin-top:0}
.mtt-answer-body> :last-child{margin-bottom:0}
.mtt-answer-body p{margin:0 0 10px}
.mtt-answer-body h3{margin:0 0 8px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary,#111)}
.mtt-answer-body ul{margin:0 0 10px;padding-left:20px}
.mtt-answer-body li{margin:2px 0}
.mtt-answer-body code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;
  background:var(--dsw-alias-bg-layer-2,#f2f3f5);border-radius:4px;padding:1px 4px}
.mtt-answer-body pre{margin:0 0 10px;padding:12px 14px;overflow:hidden;border-radius:10px;
  background:var(--dsw-alias-bg-layer-2,#f2f3f5);border:.5px solid var(--dsw-alias-border-l2,#0000000f)}
.mtt-answer-body pre code{background:none;padding:0;font-size:12.5px;line-height:1.65;display:block}
.mtt-answer-body .cmt{color:var(--dsw-alias-label-tertiary,#8a8f98)}
.mock-static{position:static!important;top:auto;left:auto;right:auto;bottom:auto;transform:none!important;margin:0;max-width:none}
.mock-wrap{display:flex;justify-content:flex-end}
.mock-failed{font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary,#5a6270);
  background:var(--dsw-alias-bg-layer-2,#f2f3f5);border-radius:10px;padding:10px 14px}
`;

/* ---------------------------------------------------------------- scenes -- */

const hero = `
<div class="scene mock-hover"><div class="column">
  <div class="mtt-row"><div class="mtt-line">
    <div class="mtt-bubble">把这个递归改成尾递归，并说明为什么。</div>
  </div></div>

  <div class="mtt-answer">
    <div class="mtt-think">
      <button class="mtt-think-head" type="button">${ICONS.chevron}<span>思考过程</span></button>
    </div>
    <div class="mtt-answer-body">
      <h3>尾递归</h3>
      <p>尾递归要求递归调用是函数的<strong>最后一个动作</strong>：返回值直接就是下一次调用的结果，回来之后不再需要做任何计算。这样解释器可以复用同一个栈帧，把递归写成循环。</p>
      <pre><code>def factorial(n, acc=1):
    if n &lt;= 1:
        return acc
    return factorial(n - 1, n * acc)   <span class="cmt"># 尾调用：回来后无事可做</span></code></pre>
      <p>注意 Python 并不做尾调用优化，这里交换的是<strong>可读性</strong>：累加器把「剩下要乘的东西」显式写了出来，一眼能看出它是从 1 乘到 n。</p>
    </div>
  </div>

  <div class="mtt-actions">${toolbar(
    act('pencil', '编辑这条回答')
    + act('retry', '重新生成这一轮')
    + act('sliders', '换一个模型回答这一轮')
    + act('translate', '翻译')
    + act('trash', '删除这条回答')
    + ring('3/3'),
  )}</div>
</div></div>`;

const translation = `
<div class="scene mock-hover"><div class="column">
  <div class="mtt-row"><div class="mtt-line">
    <div class="mtt-bubble">把这段翻译成英文。</div>
  </div></div>

  <div class="mtt-answer">
    <div class="mtt-pair">
      <div class="mtt-pair-block">
        <div class="mtt-pair-src">尾递归要求递归调用是函数的最后一个动作：返回值直接就是下一次调用的结果，回来之后不再需要做任何计算。</div>
        <div class="mtt-pair-tr">A tail call requires the recursive call to be the function's last action: its return value is the result of the next call, so nothing is left to compute once it comes back.</div>
      </div>
      <div class="mtt-pair-block">
        <div class="mtt-pair-src">累加器把「剩下要乘的东西」显式写了出来。</div>
        <div class="mtt-pair-tr">The accumulator makes "what is left to multiply" explicit.</div>
      </div>
    </div>
    <div class="mtt-answer-body">
      <pre><code>return factorial(n - 1, n * acc)   <span class="cmt"># code is lifted out of the request</span></code></pre>
    </div>
  </div>

  <div class="mtt-actions">${toolbar(
    act('pencil', '编辑这条回答')
    + act('retry', '重新生成这一轮')
    + act('sliders', '换一个模型回答这一轮')
    + act('translate', '隐藏译文', ' data-mtt="translate"')
    + act('trash', '删除这条回答')
    + ring('3/3'),
  )}</div>
</div></div>`;

const editing = `
<div class="scene mock-hover"><div class="column">
  <div class="mtt-answer">
    <div class="mtt-answer-edit">
      <div class="mtt-answer-edit-head">
        <span class="mtt-answer-edit-label">编辑中</span>
        <span class="mtt-answer-edit-tools">
          <button class="mtt-act" type="button" title="退出编辑">${ICONS.close}</button>
          <button class="mtt-btn mtt-btn-small mtt-btn-primary" type="button">保存</button>
        </span>
      </div>
      <textarea class="mtt-answer-edit-input" rows="8">### 尾递归

尾递归要求递归调用是函数的**最后一个动作**：返回值直接就是下一次调用的结果。

\`\`\`python
def factorial(n, acc=1):
    if n &lt;= 1:
        return acc
    return factorial(n - 1, n * acc)
\`\`\`

Python 不做尾调用优化，这里交换的是可读性。</textarea>
    </div>
  </div>

  <div class="mtt-actions">${toolbar(
    act('pencil', '编辑这条回答')
    + act('retry', '重新生成这一轮')
    + act('sliders', '换一个模型回答这一轮')
    + act('translate', '翻译')
    + act('trash', '删除这条回答')
    + ring('2/2'),
  )}</div>
</div></div>`;

const deleting = `
<div class="scene mock-hover"><div class="column">
  <div class="mtt-answer">
    <div class="mtt-answer-body"><p>尾递归要求递归调用是函数的最后一个动作……</p></div>
  </div>

  <div class="mtt-actions">${toolbar(
    act('pencil', '编辑这条回答')
    + act('retry', '重新生成这一轮')
    + act('sliders', '换一个模型回答这一轮')
    + act('translate', '翻译')
    + act('trash', '删除这条回答')
    + ring('2/2'),
  )}</div>

  <div class="mock-wrap">
    <div class="mtt-pop mtt-pop-float mtt-pop-confirm mock-static">
      <div class="mtt-pop-title">删除这条回答？</div>
      <div class="mtt-pop-actions">
        <button class="mtt-btn mtt-btn-small" type="button">取消</button>
        <button class="mtt-btn mtt-btn-danger mtt-btn-small" type="button">删除</button>
      </div>
    </div>
  </div>
</div></div>`;

const failed = `
<div class="scene mock-hover"><div class="column">
  <div class="mock-failed">这条回答在结束前报错了，没有留下正文。</div>

  <div class="mtt-tail-actions">${toolbar(
    act('retry', '重新生成')
    + act('sliders', '换个模型重答')
    + act('trash', '删除这条消息'),
  )}</div>
</div></div>`;

const SCENES = [
  ['01-toolbar', hero],
  ['02-translation', translation],
  ['03-edit-answer', editing],
  ['04-delete', deleting],
  ['05-failed', failed],
];

const THEME = themeCss();
const PLUGIN = pluginCss();
if (!THEME.includes('--dsw-alias-bg-base')) throw new Error('theme variables not found');

const body = DARK ? '<body data-ds-dark-theme>' : '<body>';

for (const [name, scene] of SCENES) {
  const file = path.join(outDir, `${name}${DARK ? '-dark' : ''}.html`);
  fs.writeFileSync(file, `<!doctype html><html lang="zh"><head><meta charset="utf-8">`
    + `<style>${CHROME}</style><style>${THEME}</style><style>${PLUGIN}</style>`
    + `</head>${body}<div class="page">${scene}</div></body></html>`);
  console.log('wrote ' + path.relative(root, file));
}
