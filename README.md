# dsh-message-toolbar

[English](#english) · [中文](#中文)

---

## English

A message toolbar plugin for [DSH](https://github.com/deepseek-ai/dsh) (DeepSeek Harness) 0.2.x, built as a
single self-contained bundle. It merges the features of
[`dsh-plugin-message-edit`](https://github.com/SpookySandwich/dsh-plugin-message-edit) and
[`dsh-msg-edit`](https://github.com/moton16/dsh-msg-edit) with the per-message actions users expect from
Cherry Studio.

### Features

| Action | Where | What happens |
| --- | --- | --- |
| **Copy** | user & assistant messages | Copies the message text to the clipboard. |
| **Edit** | user messages | Rewrites the turn in place: the conversation is rewound to just before that turn, a new child session is seeded with the edit, and the answer is regenerated. The original branch is preserved as a version card. |
| **Regenerate** | assistant messages | **In place, no new conversation.** A fresh answer to the same question is stored as a variant of that turn and swapped in for the logged one. The `‹ 1/2 ›` control lives in the answer's action row, next to delete, and walks the variants in place. |
| **Failed answers** | turns that ended in an error | DSH draws an action row only for a turn that has a closing message, so a failed answer would have none. The toolbar draws one itself for that turn: regenerate, regenerate with another model, delete. No edit or translate — there is no text to work on. |
| **Switch model** | assistant messages | Same mechanism with another provider/model: every model's answer becomes a variant of the *same* turn, and `‹ 2/3 ›` walks them without leaving the conversation. The picker is DSH's own dropdown (the one under the composer), so it looks and keys exactly like the rest of the app; its last row instead opens a real branch when you want a full agent run with tools. |
| **Edit answer** | assistant messages & answer card | The pencil turns the answer into an editor *where the answer stands*: a bordered box holding the markdown source of its text (tool and file-change blocks are not part of it, so they stay on screen), labelled `Editing` with a ✕ to leave and a save button on the right. Esc closes, ⌘/Ctrl+Enter saves. **Saving overwrites what was on screen** — the ring does not grow a second answer — and the result is rendered by the same markdown body as a generated answer, so it looks unchanged. A logged answer that no API can rewrite takes an override instead, with one muted line (Edited by you · Restore the original) to give the model's text back. |
| **Translate** | assistant answers | Pressing translate opens a dropdown of target languages (the same native menu as the model picker) — pick one and the answer is translated; nothing has to be configured beforehand. The result is *bilingual*: the original stays, the translation sits underneath in a collapsible panel. Cached per session + turn + sequence, so it survives reloads without re-billing. |
| **Delete** | version cards | Soft-deletes a version: the card is hidden from the ring and the version tree but the session log is untouched and it can be restored. The root conversation can never be deleted. |
| **Delete message / answer** | user bubbles & assistant answers | Removes one turn (message, answer, tool cards) or just one answer from the transcript, e.g. to clear a pile of "continue" prompts left by a stalled turn. It is gone: no placeholder row is left behind, and a toast confirms what happened. |
| **Version ring** | `‹ 2/3 ›` chip | Walks the answer variants of a turn (`1` is always the model's logged answer) and the sibling versions of a turn, without leaving the conversation. |
| **Turn rail** | the outline on the right | Follows what is on screen instead of the log: a deleted turn leaves the ladder, and a turn showing another model's answer (or your own edit) previews that text — including an answer still being written. |
| **Version tree** | conversation view | A turn-level branching tree of the whole conversation family, with the active path highlighted, model labels, timestamps, and restore/delete controls. |

### Requirements

- DSH `0.2.0-rc.2` … `0.2.x`
- A configured LLM provider (the translation feature calls `llm.stream` with the provider of the turn)

### Install

From a checkout:

```bash
npm run build                 # regenerates lib/client.js from plugin.client.js
dsh plugin --profile web add file:$(pwd)
```

Or from a packed tarball:

```bash
npm pack
dsh plugin --profile web add file:./dsh-message-toolbar-0.4.0.tgz
```

Then add `dsh-message-toolbar` to `dsh.profile.bundles` in the profile `package.json`
(`~/.dsh/profiles/<profile>/package.json`) if the plugin manager did not do it, and restart DSH —
host and client both load at startup.

> **Replacing `dsh-plugin-message-edit`:** both plugins shadow the same
> `conversation.chat.node` `user` slot, so only one of them should be loaded. Remove
> `dsh-plugin-message-edit` from `dsh.profile.bundles` before enabling this plugin.
> Existing branches keep working: this plugin also *reads* the older `message-tree/version`
> markers, so previously created version cards still show up in the ring and the tree.

> **Packaging requirement:** `package.json` must export the built client bundle, otherwise
> DSH refuses to start with `client-modules: dsh-message-toolbar declares dsh.client but
> exports no "./client" bundle`:
>
> ```json
> "exports": {
>   ".": { "default": "./lib/index.js" },
>   "./client": { "default": "./lib/client.js" },
>   "./cordis.patch.yml": "./cordis.patch.yml",
>   "./package.json": "./package.json"
> }
> ```
>
> `test/bundle.test.mjs` pins this contract, so `npm test` catches a regression before install.

### How answers are replaced in place

A closed turn can never gain a second answer: DSH's session log requires an open step to append an
`assistant/message`, and a turn's step numbers only grow. So "answer again with another model" cannot
be written into the log. This plugin therefore does two different things:

**1 · Answer variants (default: regenerate / switch model / edit answer).** The new answer is stored
in the plugin's own state file (`~/.dsh/message-toolbar/state.json`), keyed by session and turn, with
its provider, model and text. The client renders it in the conversation flow exactly where the answer
belongs and hides the logged answer of that turn with a generated stylesheet
(`[data-chat-flow-kind="assistant-step"][data-chat-turn="N"]{display:none}`). Slot `1` of the
`‹ 1/2 ›` ring is always the model's original answer, so nothing is lost.

Switching is instant and it *looks* like answering: `answer-generate` is streamed as NDJSON frames
(`start` → `reasoning`… → `delta`… → `done`), so the old answer is hidden the moment you pick a model and
the new one is written into its place word by word by the app's own renderer (MarkdownText with streaming,
and DSH's shimmer line until the first token), so a variant and a logged answer look the same. Everything
the old answer left behind goes too — the logged row, its tool cards and the "finished in *N*s" line are
hidden, so the turn reads as if it had never been answered. When the model streams reasoning it appears in
a collapsible *thinking* block above the answer and folds itself away once the answer starts; the reasoning
is stored with the variant, so it comes back when you do.
Deleting the answer you are looking at moves you to the one before it in the ring — `<2/3>` becomes
`<1/2>` — and the ring disappears when a turn has only one answer left. The ring keeps the action row's
metrics (a 28px box with a 17px glyph), because it sits in that row.

Consequences, stated plainly:

- a variant is a **pure text generation**: no tools, no file reads. It answers the same question from
  the same plain-chat transcript, which is what a model comparison should be;
- the log is not modified, so **later turns still see the original answer** in their context. Editing
  an answer changes what *you* read, not what the model remembers;
- if a future DSH changes those `data-chat-*` attributes, the rule stops matching and both answers
  render — a visible degradation, never a crash.

**2 · Real branches (the model menu's last row, and user-message edits).** These seed a **new child
session** instead: the child inherits the parent's events up to the boundary, then carries an
`ignorable` marker event of type `message-toolbar/version` describing the operation and its inverse.
That marker is what the version ring, the tree view and delete/restore are built from. Consequently:

- branches are real sessions — they can be continued independently, tools and all, and are never
  `origin: 'subagent'` (that would fence them from model selection);
- only one member of a family is visible at a time: switching archives the others. The hidden ones
  stay one click away in the version ring, and the workspace's archived filter always lists them;
- deleting a card only flips a flag in the plugin's state file, it never destroys a session;
- switching between versions is navigation, not mutation, so it is always reversible.

### Deleting a message

DSH's transcript is append-only: an `assistant/message` may only be appended while its turn's step is
open, and surface replacements change the model's view, never the human transcript. So **deleting a
message cannot rewrite the conversation** — no DSH API removes events from a live session. What this
plugin does instead:

- `hidden.turns` and `hidden.answers` in `~/.dsh/message-toolbar/state.json` record what you deleted;
- a generated stylesheet hides exactly those rows (`[data-chat-turn="N"]{display:none}`, with the
  turn-tail row included, or only the `assistant-step` row for an answer);
- nothing is drawn where the row was — deletion is not a tombstone, and the confirmation is a toast;
- the log is untouched, so **later turns still carry the deleted text in the model's context**.

The button asks one question (`Delete this answer?`) and nothing else: confirmations are reported by a
banner at the top of the window — DSH's own `Toast` when the primitives package is present, a copy of
its stylesheet otherwise — so the action row stays a row of icons and never grows status text.
Success and failure take the same route: a failure keeps the host's sentence (it names what broke),
holds longer, and carries the warning glyph instead of the check.

Copy follows the reader, not a stored flag: the plugin speaks Chinese when the browser or the document
does, English otherwise, and consults the app's locale service last — that value is provisional and can
still read `en` while the page is Chinese, which is exactly how `Answer deleted` once showed up under a
Chinese UI.

Clearing a message out of the model's memory for good would need a rewritten session (a new child
session seeded without that turn). That is a separate, much larger operation, and it is not part of
this feature.

### Development

```bash
npm run build                      # plugin.client.js -> lib/client.js (__ModuleLoader__ wrapper)
node --test test/host.test.mjs     # host HTTP contract
node --test test/logic.test.mjs    # pure tree logic
node scripts/preview-menu.mjs      # test/preview-menu.html: same CSS on light and dark
```

`plugin.client.js` is an IIFE body (it ends with `return { inject, apply }`), so `node --check`
only makes sense on the built `lib/client.js`.

`scripts/preview-menu.mjs` pulls the real variables out of `@deepseek-ai/dsh-client-ui-theme` and
the plugin stylesheet out of the bundle, then paints the menus, cards and buttons twice — once on
`<body>` and once on `<body data-ds-dark-theme>`. Screenshot that page after touching the CSS: a
colour that ignores the theme shows up immediately. [docs/theme-preview.png](docs/theme-preview.png)
is that screenshot (light on the left, dark on the right).

### License

MIT

---

## 中文

一个 DSH（DeepSeek Harness）0.2.x 的消息工具栏插件，单包自带宿主端与客户端。
它把 [`dsh-plugin-message-edit`](https://github.com/SpookySandwich/dsh-plugin-message-edit) 与
[`dsh-msg-edit`](https://github.com/moton16/dsh-msg-edit) 的能力合并到一起，并补上了 Cherry Studio
里常见的逐条消息操作。

### 功能

| 操作 | 位置 | 效果 |
| --- | --- | --- |
| **复制** | 用户 / 助手消息 | 把消息正文复制到剪贴板。 |
| **编辑** | 用户消息 | 就地改写这一轮：对话回退到该轮之前，用编辑后的文本开启一个新的子会话并重新回答，原分支保留为版本卡片。 |
| **重新生成** | 助手消息 | **就地重答，不新开对话。** 同一个问题的新回答存成这一轮的一个「备选」，直接替换显示。`‹ 1/2 ›` 切换按钮就在这一轮的动作行里、删除按钮右边，可以就地来回翻。 |
| **失败的回答** | 报错结束的轮次 | DSH 只为有收尾消息的轮次画动作行，所以失败的回答本来没有工具栏。插件给这种轮次自己补一行：重新生成、换个模型重答、删除。没有编辑和翻译——没有文本可编辑、也没有内容可翻译。 |
| **切换模型** | 助手消息 | 同一机制换 provider/模型：每个模型的回答都是**同一轮**的备选，`‹ 2/3 ›` 就地来回切换，不离开当前对话。模型选择器直接复用输入框右下角那个原生下拉（外观与键盘操作完全一致），它的最后一行则走真正的分支，用于需要调用工具的完整重跑。 |
| **编辑回答** | 助手消息 / 回答卡片 | 点铅笔就在**回答原来的位置**变成编辑器：带边框的框里放这条回答的 markdown 源码（工具调用、文件改动不属于它的文本，所以留在框外照常显示），左上角写「编辑中」，右上角是 ✕（退出）和保存。Esc 退出，⌘/Ctrl+Enter 保存。**保存是直接覆盖你正在看的那份**——环里不会多出一个回答——而且用同一个 markdown 正文渲染器显示，所以样式和模型生成的一模一样；只有模型原本那条（日志改不了）会改成一条覆盖文本存在这一轮的记录里，下方不再多任何一行。 |
| **翻译** | 助手回答 | 点翻译直接弹出语言下拉（就是切换模型那个原生菜单），选一种语言就翻，不需要事先在设置里配任何东西。结果是**双语排版**：原文保留，译文以可折叠面板放在下面。按 会话+轮次+序号 缓存，刷新页面不会重复计费。 |
| **删除** | 版本卡片 | 软删除：从版本徽标和版本树里隐藏，但会话日志不动，可随时恢复。根对话永远不可删除。 |
| **删除消息 / 回答** | 用户气泡 / 助手回答 | 把某一轮（消息、回答、工具卡片）或单独一条回答从对话里删掉，比如清掉某一轮卡住后连发的一串「继续」。删掉就真的没了，原位不留任何东西（结果用顶部提示条告诉你）。 |
| **版本左右翻** | `‹ 2/3 ›` 徽标 | 在不离开当前对话的情况下翻看这一轮的回答备选（第 1 位永远是模型原始回答）以及同轮的不同版本。 |
| **右侧大纲** | 右侧的目录 | 跟着屏幕上的内容走，而不是跟着日志：删掉的轮次从大纲里消失，换成别的模型回答（或你自己改过）的轮次显示的是屏上那段文字——连正在生成的那份也会同步。 |
| **版本树** | 会话视图 | 整个会话家族的逐轮分支树，高亮当前路径，带模型标签、时间以及恢复/删除按钮。 |

### 环境要求

- DSH `0.2.0-rc.2` … `0.2.x`
- 已配置好的 LLM provider（翻译会使用该轮次的 provider 调用 `llm.stream`）

### 安装

从源码目录安装：

```bash
npm run build                 # 由 plugin.client.js 重新生成 lib/client.js
dsh plugin --profile web add file:$(pwd)
```

或先打包再安装：

```bash
npm pack
dsh plugin --profile web add file:./dsh-message-toolbar-0.4.0.tgz
```

如果插件管理器没有自动登记，请手动把 `dsh-message-toolbar` 加进 profile 的 `package.json`
里的 `dsh.profile.bundles`（路径：`~/.dsh/profiles/<profile>/package.json`），然后**重启 DSH**——
宿主端和客户端都在启动时加载。

> **替换 `dsh-plugin-message-edit`：** 两个插件都占用同一个
> `conversation.chat.node` 的 `user` slot，只能启用一个。启用本插件前，请先把
> `dsh-plugin-message-edit` 从 `dsh.profile.bundles` 中移除。
> 已有的分支不会失效：本插件同时**读取**旧的 `message-tree/version` 标记，
> 之前创建的版本卡片依然会出现在版本徽标和版本树里。

> **打包硬性要求：** `package.json` 必须用 `exports` 暴露构建好的客户端 bundle，否则 DSH 启动直接失败并报
> `client-modules: dsh-message-toolbar declares dsh.client but exports no "./client" bundle`：
>
> ```json
> "exports": {
>   ".": { "default": "./lib/index.js" },
>   "./client": { "default": "./lib/client.js" },
>   "./cordis.patch.yml": "./cordis.patch.yml",
>   "./package.json": "./package.json"
> }
> ```
>
> `test/bundle.test.mjs` 已经把这个契约钉死，`npm test` 会在安装前拦住回归。

### 就地替换回答是怎么实现的

一个已结束的轮次永远不可能再获得第二份回答：DSH 的会话日志要求 `assistant/message` 落在自己
还没关闭的 `turn`/`step` 里，而 `step` 编号只增不减。所以「换个模型再答一次」写不进日志。
本插件因此做的是两件不同的事：

**1 · 回答备选（默认行为：重新生成 / 切换模型 / 编辑回答）。** 新回答存在插件自己的状态文件
（`~/.dsh/message-toolbar/state.json`）里，按 会话 + 轮次 归档，带 provider、模型和正文。客户端把
它渲染在会话流里该回答本该在的位置，并用一张动态生成的样式表把日志里的那份回答隐藏起来
（`[data-chat-flow-kind="assistant-step"][data-chat-turn="N"]{display:none}`）。`‹ 1/2 ›` 的第 1 位
永远是模型原始回答，所以什么都不丢。

切换是即时的，而且看起来就像「在回答」：`answer-generate` 以 NDJSON 帧流式返回（`start` →
若干 `reasoning` → 若干 `delta` → `done`），所以你一选模型旧回答立刻消失，新回答逐字写进同一个位置，
用的还是应用自带的那套渲染（`MarkdownText` + `streaming`，第一个字到达前显示 DSH 自己的 shimmer 行），
所以备选和原生日志回答看起来一模一样，插件不额外加任何装饰。旧回答留下的痕迹也一并消失：日志里那行、
它的工具卡片、以及「已完成 · N 秒」那一行都藏起来，整轮读起来就像还没被回答过。模型如果流式吐思维链，
它会在回答上方展开成可折叠的「思考过程」，正文开始后自动收起；思维链跟着备选一起存下来，切回来还在。
切换按钮本身会自动算上「正在生成的那一份」，所以点第二个模型时当场就是 `<2/2>`。删除你正在看的那一份，
会落到切换环里的前一份——`<2/3>` 变成 `<1/2>`；一轮只剩一份回答时，切换按钮就不显示了。切换按钮沿用
动作行的规格（28px 的盒子、17px 的图标），因为它就长在这一行里。

需要说清的三点后果：

- 备选只是一次**纯文本生成**：不调工具、不读文件（思维链会显示，但工具调用不会发生）。它回答的是同一个
  问题、吃的是同一份纯对话转录——这正是「对比模型」该有的样子；
- 日志没有被改动，所以**后续轮次的模型上下文里仍然是原始回答**。编辑回答改变的是你读到的内容，
  不是模型记住的内容；
- 如果将来 DSH 改了这些 `data-chat-*` 属性，规则就不再命中，于是两份回答都显示出来——是可见的
  退化，而不是崩掉。

**2 · 真分支（模型菜单最后一行，以及编辑用户消息）。** 这条路才是**派生子会话**：子会话继承父会话
到边界为止的事件，再写入一条 `ignorable` 的 `message-toolbar/version` 标记事件，记录操作类型及其
逆向操作。版本徽标、版本树、删除/恢复都建立在这条标记之上。因此：

- 分支就是真实会话——可以带着工具独立继续，且绝不会被标成 `origin: 'subagent'`
  （那会让它被模型选择限制在 "agent-busy" 之外）；
- 同一家族里同一时刻只显示一个会话：切换时把其余成员归档，因为 DSH 的会话日志不允许
  一个已结束的轮次存在两份回答（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）。
  被收起的版本在版本徽标里一点即到，侧边栏的「已归档」筛选里也始终找得到；
- 删除卡片只是在插件状态文件里翻一个标志位，从不销毁会话；
- 在版本之间切换属于导航而不是修改，随时可逆。

### 删除消息是怎么实现的

DSH 的会话日志是 append-only 的：`assistant/message` 只能追加到还没关闭的 `turn`/`step` 里，
而 surface 替换只改模型视图、不改人类看到的转录。所以**删除消息没法真的重写对话**——DSH 也没有
任何 API 能从活着的会话里抹掉事件。本插件实际做的是：

- 在 `~/.dsh/message-toolbar/state.json` 里记下 `hidden.turns` 与 `hidden.answers`；
- 用动态样式表只隐藏那几行（整轮用 `[data-chat-turn="N"]{display:none}`，连这一轮自己的 tail 行
  一起隐藏；只删回答时只隐藏 `assistant-step` 那行）；
- 删除的位置什么都不留——删除不是立碑，结果由顶部提示条告知；
- 日志没有变，所以**后续轮次的模型上下文里仍然带着这段被删掉的内容**。

确认框只问一句「删除这条回答？」，不再附带说明；删完的结果由窗口顶部的横幅提示——装了
primitives 就用 DSH 自己的 `Toast`，否则用一份照它的样式表画的副本——所以动作行永远只是图标，
不会长出状态文字。成功和失败走同一条路：失败会把宿主给出的那句话原样显示（说明是哪一步坏了），
停留更久，并且用的是警示图标而不是对勾。插件所有颜色都走主题别名，浅色/深色切换时文字、边框、
弹层、卡片一起跟着变。

文案跟着读者走，不看存储的开关：浏览器或文档是中文就说中文，否则说英文；应用自己的 locale 服务
最后才参考——那个值是临时的、由浏览器推导，页面明明是中文它也可能还写着 `en`，之前工具栏里冒出
一句英文 `Answer deleted` 就是这么来的。

要让某条消息真正从模型记忆里消失，需要重写会话（用一个不带该轮的种子开子会话）。那是另一个大得
多的操作，不在这个功能的范围内。

### 开发

```bash
npm run build                      # plugin.client.js -> lib/client.js（__ModuleLoader__ 包装）
node --test test/host.test.mjs     # 宿主端 HTTP 契约
node --test test/logic.test.mjs    # 纯版本树逻辑
```

`plugin.client.js` 是一段 IIFE 函数体（结尾是 `return { inject, apply }`），
所以 `node --check` 只对构建产物 `lib/client.js` 有意义。

### 许可

MIT