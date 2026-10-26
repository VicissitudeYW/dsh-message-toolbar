# dsh-message-toolbar

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

---


DSH（DeepSeek Harness）消息工具栏插件。

![回答下方的工具栏，以及 ‹ 3/3 › 切换按钮](./docs/showcase/01-toolbar.png)

---

## 功能

| 操作 | 位置 | 效果 |
| --- | --- | --- |
| **编辑** | 用户消息 | 修改回复的显示内容。 |
| **重新生成** | 助手消息 | 新的回答占据回答的位置，之前的那份收进 `‹ 1/2 ›`，随时点回去。 |
| **切换模型** | 助手消息 | 换成所选模型回答；会话本身的模型不变，`‹ 2/3 ›` 就地切换不同模型的回答。 |
| **回退文件改动** | 重新生成 / 切换模型之前 | 被替换的那条回答如果改过文件，会先列出这些文件问一句；确认后把文件恢复成回答之前的样子，再重新作答。 |
| **编辑回答** | 助手消息 | 在回答原来的位置变成编辑器，显示这条回答的 markdown 源码。 |
| **翻译** | 助手消息 | 点翻译直接弹出语言下拉，选一种语言，回答按段对照。 |
| **附件** | 用户消息 | 发出去的文件（PDF 等）在气泡里显示成文件卡片（图标、文件名、大小），不会看起来凭空消失。 |
| **删除消息 / 回答** | 用户消息 / 助手消息 | 把某一轮（消息、回答、工具卡片）或单独一条回答从对话里删掉。 |
| **版本树** | 会话视图 | 整个会话家族的逐轮分支树，高亮当前路径，带模型标签、时间以及恢复/删除按钮。 |



## 限制
- DSH 的会话日志只追加、不重写，所以「删除」是视图层隐藏
- 变体与翻译存在 `~/.dsh/message-toolbar/state.json`，不写进会话日志；换机器不会跟着走。
- 回退依赖 `workspace-changes` 的记录：没有 git 仓库时只覆盖文件工具的改动，宿主重启后旧轮次没有记录。
- 重新作答会往会话日志里再追加一轮提问：这是让 agent 真的重跑的代价，界面里那条重复的提问行是隐藏的，但日志里确实多了一轮（模型上下文因此能看到两次同一个问题）。

## 功能展示

| | |
| --- | --- |
| ![双语对照](./docs/showcase/02-translation.png) | ![编辑回答](./docs/showcase/03-edit-answer.png) |
| **翻译。** 原文与译文按段对照 | **编辑回答。** 回答在**原来的位置**变成编辑器，里面是 markdown 源码 |
| ![删除回答](./docs/showcase/04-delete.png) | ![失败的回答](./docs/showcase/05-failed.png) |
| **删除。** | **失败的回答**有工具栏：重新生成、换个模型、删除。 |

## 环境要求

- DSH `0.2.0-rc.2` … `0.2.x`

## 安装

从仓库直接装：

```bash
git clone https://github.com/VicissitudeYW/dsh-message-toolbar.git
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

## 许可

MIT
