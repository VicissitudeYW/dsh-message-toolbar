# dsh-message-toolbar

<p align="center">
  给 DSH 增加 Cherry Studio 风格的消息工具栏
  <br>
  <strong>简体中文</strong> · <a href="README.en.md">English</a>
</p>

[![许可证：MIT](https://img.shields.io/badge/license-MIT-111827.svg)](LICENSE)
[![支持 DSH 0.2.2-rc.5 至 0.2.x](https://img.shields.io/badge/DSH-0.2.2--rc.5%20to%200.2.x-4b5563.svg)](package.json)

在 DSH 的消息下方加入回答切换、重答、换模型、编辑、翻译、复制和删除等操作。

![回答下方的工具栏，以及回答切换按钮](./docs/showcase/01-toolbar.png)

## 安装

适用于 DSH `0.2.x`（最低版本为 `0.2.2-rc.5`）。克隆仓库后，在项目目录中执行：

```powershell
git clone https://github.com/VicissitudeYW/dsh-message-toolbar.git
cd dsh-message-toolbar
dsh plugin --profile web add file:$((Get-Location).Path)
```

Bash、macOS 或 Linux：

```bash
git clone https://github.com/VicissitudeYW/dsh-message-toolbar.git
cd dsh-message-toolbar
dsh plugin --profile web add file:$(pwd)
```

安装后重启 DSH。

## 功能

| 操作 | 作用 |
| --- | --- |
| **切换回答** | 在同一个问题的多个回答之间切换。 |
| **重新生成** | 重新回答当前问题。 |
| **切换模型** | 用另一个模型重新回答。 |
| **编辑提问** | 修改问题后保存，或带附件发送。 |
| **编辑回答** | 在原位置修改回答的 Markdown。 |
| **翻译与复制** | 显示译文，并分别复制原文或译文。 |
| **删除与版本树** | 删除问题或回答，同时保留旧版本以便恢复。 |
| **回退文件改动** | 重新生成或换模型前，回退这次回答产生的安全文件改动。 |

## 用法

1. 打开 DSH 会话，在消息下方找到工具栏。
2. 点击回答两侧的箭头切换回答，点击数字查看其他回答。
3. 需要新回答时使用重新生成或切换模型；需要修改问题时点击编辑。
4. 编辑问题后，点击**保存**只保存修改，点击**发送**才会生成回答。
5. 点击版本树查看或恢复旧版本。

配合 **dsh-btw-explore 0.3.4 或更新版本**，本插件从 **1.11.1** 起会在探索子卡内完成编辑保存和回答版本切换，保留卡片及来源引用。保存时关闭或切换卡片，迟到结果也不会把主窗口带走。

![按段显示原文与译文](./docs/showcase/02-translation.png)

## 需要知道的事

- 切换回答会切换后续提问使用的上下文。选择哪个回答，下一次提问就从哪个回答继续。
- 编辑或删除较早的问题、回答会建立新的分支；原来的版本仍保留在版本树中。
- 原来的会话记录仍保留在版本树中；分支会占用额外的会话空间。
- 某些经过压缩或替换、无法安全辨认的旧历史不能编辑，插件会直接提示并拒绝操作。
- 回退文件改动时，只会撤销能够确认的内容；无法确认的文件会保留。

遇到问题或有建议，请提交 [Issue](https://github.com/VicissitudeYW/dsh-message-toolbar/issues)。

## 许可证

[MIT](LICENSE)
