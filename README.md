# dsh-message-toolbar

**简体中文** · [English](README.en.md)

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH 0.2.x](https://img.shields.io/badge/DSH-0.2.x-4d6bfe.svg)](https://github.com/deepseek-ai/dsh)
[![tests](https://img.shields.io/badge/tests-75%20passing-brightgreen.svg)](test)

DSH（DeepSeek Harness）消息工具栏插件。

![回答下方的工具栏，以及 ‹ 3/3 › 切换按钮](./docs/showcase/01-toolbar.png)

---

## 功能

| 操作 | 位置 | 效果 |
| --- | --- | --- |
| **编辑** | 用户消息 | 就地改写这一轮：对话回退到该轮之前，用编辑后的文本开启一个新的子会话并重新回答，原分支保留为版本卡片。 |
| **重新生成** | 助手消息 | 就地重答，不新开对话。同一个问题的新回答存成这一轮的一个「备选」，直接替换显示。`‹ 1/2 ›` 切换按钮就在这一轮的动作行里、删除按钮右边。 |
| **切换模型** | 助手消息 | 同一机制换 provider/模型：每个模型的回答都是同一轮的备选，`‹ 2/3 ›` 就地来回切换，不离开当前对话。模型选择器直接复用输入框右下角那个原生下拉（外观与键盘操作完全一致），它的最后一行则走真正的分支，用于需要调用工具的完整重跑。 |
| **回退文件改动** | 重新生成 / 切换模型之前 | 被替换的那条回答如果改过文件，会先列出这些文件问一句；确认后把文件恢复成回答之前的样子，再重答——重新生成走真正的 agent（有工具、原生流式），切换模型则在此基础上把新回答加进 `‹ 1/3 ›` 环里。有一处对不上就一个文件都不动，并告诉你哪些文件后来又被改过。 |
| **编辑回答** | 助手消息 / 回答卡片 | 点铅笔就在回答原来的位置变成编辑器：带边框的框里放这条回答的 markdown 源码。 |
| **翻译** | 助手回答 | 点翻译直接弹出语言下拉，选一种语言，回答就就地按段对照重画。 |
| **问题也走 markdown** | 你发的消息 | 和回答用同一个渲染器：`$…$` 公式、行内代码、加粗都正常显示（原生 DSH 把用户消息当纯文本画）。 |
| **删除** | 版本卡片 | 软删除：从版本徽标和版本树里隐藏，但会话日志不动，可随时恢复。根对话永远不可删除。 |
| **删除消息 / 回答** | 用户气泡 / 助手回答 | 把某一轮（消息、回答、工具卡片）或单独一条回答从对话里删掉。 |
| **版本左右翻** | `‹ 2/3 ›` 徽标 | 在不离开当前对话的情况下翻看这一轮的回答备选（第 1 位永远是模型原始回答）以及同轮的不同版本。 |
| **版本树** | 会话视图 | 整个会话家族的逐轮分支树，高亮当前路径，带模型标签、时间以及恢复/删除按钮。 |

> 回退文件用的是 DSH 自带的 `workspace-changes` 记录（git 快照 + 文件工具改动前的内容副本），
> 所以「这一轮改了什么」不需要本插件另存。宿主重启之后旧轮次的记录不再存在，那时按钮就退回成
> 不回退、只重答。

## 和其他编辑插件的关系

`dsh-message-toolbar` 把两条既有思路合成一个插件：`SpookySandwich/dsh-plugin-message-edit` 的
分支/版本树，和 `moton16/dsh-msg-edit` 的「就地改写这一轮」；再加上 Cherry Studio 那套日常操作
（复制、重新生成、切换模型、翻译对照、删除、编辑回答），并把用户消息也按 markdown 渲染。

它们都用 `conversation.chat.node` 遮蔽同一批聊天行（用户气泡、助手动作行），所以**不要和这两个
插件同时启用**——装本插件之前请先从 profile 里移除它们。

## 已知限制

- 备选回答是纯文本补全（一次 `llm.stream`，没有工具循环）。真正有工具的原生重跑只有两条路：
  回答改过文件时确认回退之后走 `answer-run`，或者模型菜单最后一行「…或新建回答卡片」。
- DSH 的会话日志只追加、不重写，所以「删除」是视图层隐藏；插件不删除任何事件，模型上下文里
  那条消息仍然在。
- 变体与翻译存在 `~/.dsh/message-toolbar/state.json`，不写进会话日志；换机器不会跟着走。
- 回退依赖 `workspace-changes` 的记录：没有 git 仓库时只覆盖文件工具的改动，宿主重启后旧轮次
  没有记录。

## 功能展示

| | |
| --- | --- |
| ![双语对照](./docs/showcase/02-translation.png) | ![编辑回答](./docs/showcase/03-edit-answer.png) |
| **翻译。** 原文与译文按段对照 | **编辑回答。** 点铅笔，回答在**原来的位置**变成编辑器，里面是 markdown 源码 |
| ![删除回答](./docs/showcase/04-delete.png) | ![失败的回答](./docs/showcase/05-failed.png) |
| **删除。** | **失败的回答**有工具栏：重新生成、换个模型、删除。 |

## 环境要求

- DSH `0.2.0-rc.2` … `0.2.x`

## 安装

从仓库直接装：

```bash
git clone https://github.com/<you>/dsh-message-toolbar.git
cd dsh-message-toolbar
npm run build                 # 从 plugin.client.js 重新生成 lib/client.js
dsh plugin --profile web add file:$(pwd)
```

或者用打好的包：

```bash
npm pack
dsh plugin --profile web add file:./dsh-message-toolbar-1.0.0.tgz
```

然后重启 DSH——宿主端和客户端都在启动时加载。

实现细节、HTTP 契约和槽位表见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

## 许可

MIT
