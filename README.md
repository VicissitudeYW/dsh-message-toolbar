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
| **Regenerate** | assistant messages | **In place, no new conversation.** A fresh answer to the same question is stored as a variant of that turn and swapped in for the logged one; flip back with `‹ 1/2 ›`. |
| **Switch model** | assistant messages | Same mechanism with another provider/model: every model's answer becomes a variant of the *same* turn, and `‹ 2/3 ›` walks them without leaving the conversation. The picker is DSH's own dropdown (the one under the composer), so it looks and keys exactly like the rest of the app; its last row instead opens a real branch when you want a full agent run with tools. |
| **Edit answer** | assistant messages & answer card | Your own rewrite of a model answer becomes another variant; the model's original text stays one `‹` away, and switching back is always possible. |
| **Translate** | assistant answers | Pressing translate opens a dropdown of target languages (the same native menu as the model picker) — pick one and the answer is translated; nothing has to be configured beforehand. The result is *bilingual*: the original stays, the translation sits underneath in a collapsible panel. Cached per session + turn + sequence, so it survives reloads without re-billing. |
| **Delete** | version cards | Soft-deletes a version: the card is hidden from the ring and the version tree but the session log is untouched and it can be restored. The root conversation can never be deleted. |
| **Delete message / answer** | user bubbles & assistant answers | Removes one turn (message, answer, tool cards) or just one answer from the transcript, e.g. to clear a pile of "continue" prompts left by a stalled turn. A `deleted · restore` row takes its place, so it is always one click back. |
| **Version ring** | `‹ 2/3 ›` chip | Walks the answer variants of a turn (`1` is always the model's logged answer) and the sibling versions of a turn, without leaving the conversation. |
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
dsh plugin --profile web add file:./dsh-message-toolbar-0.3.4.tgz
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
`‹ 1/2 ›` ring is always the model's original answer, so nothing is lost. Consequences, stated plainly:

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
  turn-tail row re-shown so the undo stays reachable, or only the `assistant-step` row for an answer);
- the deleted spot keeps a `deleted · restore` row, so the action is always reversible;
- the log is untouched, so **later turns still carry the deleted text in the model's context**.

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
| **重新生成** | 助手消息 | **就地重答，不新开对话。** 同一个问题的新回答存成这一轮的一个「备选」，直接替换显示；用 `‹ 1/2 ›` 翻回去。 |
| **切换模型** | 助手消息 | 同一机制换 provider/模型：每个模型的回答都是**同一轮**的备选，`‹ 2/3 ›` 就地来回切换，不离开当前对话。模型选择器直接复用输入框右下角那个原生下拉（外观与键盘操作完全一致），它的最后一行则走真正的分支，用于需要调用工具的完整重跑。 |
| **编辑回答** | 助手消息 / 回答卡片 | 你改写的回答作为另一个备选保存，模型原文始终在 `‹` 里可找回，随时能切回去。 |
| **翻译** | 助手回答 | 点翻译直接弹出语言下拉（就是切换模型那个原生菜单），选一种语言就翻，不需要事先在设置里配任何东西。结果是**双语排版**：原文保留，译文以可折叠面板放在下面。按 会话+轮次+序号 缓存，刷新页面不会重复计费。 |
| **删除** | 版本卡片 | 软删除：从版本徽标和版本树里隐藏，但会话日志不动，可随时恢复。根对话永远不可删除。 |
| **删除消息 / 回答** | 用户气泡 / 助手回答 | 把某一轮（消息、回答、工具卡片）或单独一条回答从对话里删掉，比如清掉某一轮卡住后连发的一串「继续」。原位留下「已删除 · 恢复」一行，随时能一键找回。 |
| **版本左右翻** | `‹ 2/3 ›` 徽标 | 在不离开当前对话的情况下翻看这一轮的回答备选（第 1 位永远是模型原始回答）以及同轮的不同版本。 |
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
dsh plugin --profile web add file:./dsh-message-toolbar-0.3.4.tgz
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
永远是模型原始回答，所以什么都不丢。需要说清的三点后果：

- 备选只是一次**纯文本生成**：不调工具、不读文件。它回答的是同一个问题、吃的是同一份纯对话转录
  ——这正是「对比模型」该有的样子；
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
- 用动态样式表只隐藏那几行（整轮用 `[data-chat-turn="N"]{display:none}`，同时把 turn-tail 行
  重新显示，保证「恢复」按钮还能点到；只删回答时只隐藏 `assistant-step` 那行）；
- 删除的位置留下「已删除 · 恢复」一行，所以这个操作永远可逆；
- 日志没有变，所以**后续轮次的模型上下文里仍然带着这段被删掉的内容**。

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
