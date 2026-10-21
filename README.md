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
| **Regenerate** | user & assistant messages | Re-asks the same question in a new child session (no text change). |
| **Switch model** | assistant messages | Re-asks the same turn with another provider/model. Every model answer becomes a card you can flip through, and the sidebar keeps showing only the one you are reading. |
| **Translate** | assistant answers | Translates the message with an auxiliary model call and renders it *bilingual*: the original text stays, the translation sits underneath in a collapsible panel. Cached per session + turn + sequence, so it survives reloads without re-billing. |
| **Delete** | version cards | Soft-deletes a version: the card is hidden from the ring and the version tree but the session log is untouched and it can be restored. The root conversation can never be deleted. |
| **Version ring** | `‹ 2/3 ›` chip | Walks the sibling versions of a turn without leaving the conversation. |
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
dsh plugin --profile web add file:./dsh-message-toolbar-0.1.0.tgz
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

### Notes on how editing works

Every edit / regenerate / model switch seeds a **new child session** instead of mutating the log
(DSH session logs are append-only). The child inherits the parent's events up to the boundary,
then carries an `ignorable` marker event of type `message-toolbar/version` describing the operation
and its inverse. That marker is what the version ring, the tree view and delete/restore are built
from. Consequently:

- branches are real sessions — they can be continued independently and are
  never `origin: 'subagent'` (that would fence them from model selection);
- only one member of a family is visible at a time: switching archives the others, because
  DSH's session log cannot hold two answers for one closed turn (see
  [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)). The hidden ones stay one click away in the
  version ring, and the workspace's archived filter always lists them;
- deleting a card only flips a flag in the plugin's state file, it never destroys a session;
- switching between versions is navigation, not mutation, so it is always reversible.

### Development

```bash
npm run build                      # plugin.client.js -> lib/client.js (__ModuleLoader__ wrapper)
node --test test/host.test.mjs     # host HTTP contract
node --test test/logic.test.mjs    # pure tree logic
```

`plugin.client.js` is an IIFE body (it ends with `return { inject, apply }`), so `node --check`
only makes sense on the built `lib/client.js`.

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
| **重新生成** | 用户 / 助手消息 | 不改文本，在新的子会话里重问同一个问题。 |
| **切换模型** | 助手消息 | 用另一个 provider/模型重问这一轮。每个模型的回答都是一张可以来回翻的卡片，而侧边栏始终只显示你正在读的那一张。 |
| **翻译** | 助手回答 | 用一次辅助模型调用翻译该消息，并做**双语排版**：原文保留，译文以可折叠面板放在下面。按 会话+轮次+序号 缓存，刷新页面不会重复计费。 |
| **删除** | 版本卡片 | 软删除：从版本徽标和版本树里隐藏，但会话日志不动，可随时恢复。根对话永远不可删除。 |
| **版本左右翻** | `‹ 2/3 ›` 徽标 | 不离开当前对话就能在同轮的不同版本之间切换。 |
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
dsh plugin --profile web add file:./dsh-message-toolbar-0.1.0.tgz
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

### 编辑机制说明

编辑 / 重新生成 / 切换模型都不会改动历史日志（DSH 的会话日志是只追加的），而是**派生一个新的子会话**：
子会话继承父会话到边界为止的事件，再写入一条 `ignorable` 的 `message-toolbar/version` 标记事件，
记录操作类型及其逆向操作。版本徽标、版本树、删除/恢复都建立在这条标记之上。因此：

- 分支就是真实会话——可以独立继续，且绝不会被标成 `origin: 'subagent'`
  （那会让它被模型选择限制在 "agent-busy" 之外）；
- 同一家族里同一时刻只显示一个会话：切换时把其余成员归档，因为 DSH 的会话日志不允许
  一个已结束的轮次存在两份回答（见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)）。
  被收起的版本在版本徽标里一点即到，侧边栏的「已归档」筛选里也始终找得到；
- 删除卡片只是在插件状态文件里翻一个标志位，从不销毁会话；
- 在版本之间切换属于导航而不是修改，随时可逆。

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
