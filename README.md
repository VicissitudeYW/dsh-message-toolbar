<h1 align="center">dsh-message-toolbar</h1>

<p align="center">给 <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> 加上 Cherry Studio 风格的消息工具栏。重答、换模型、编辑、翻译，以及<strong>选一个回答接着聊</strong>，都可以在消息下方完成。</p>

<p align="center">
  <strong>简体中文</strong> · <a href="README.en.md">English</a> ·
  <a href="LICENSE"><img alt="许可证：MIT" src="https://img.shields.io/badge/license-MIT-111827.svg"></a>
</p>

## 安装

支持 DSH `0.2.2-rc.5` 至 `0.2.x` 的桌面版和网页版。先确认终端能运行 `dsh --version`。

**Windows 桌面版（PowerShell）**

```powershell
git clone https://github.com/VicissitudeYW/dsh-message-toolbar.git
cd dsh-message-toolbar
dsh plugin --profile desktop add "file:$($PWD.Path.Replace('\', '/'))"
```

<details>
<summary>网页版或使用 Bash</summary>

```bash
git clone https://github.com/VicissitudeYW/dsh-message-toolbar.git
cd dsh-message-toolbar
dsh plugin --profile web add "file:$(pwd)"
```

在 Bash 中安装到桌面版，把 `web` 改成 `desktop`；在 PowerShell 中安装到网页版则反过来。使用过自定义配置名称时，填写自己的名称。

</details>

安装后重启 DSH，在消息下方就能看到工具栏。

![消息下方的工具栏和回答切换按钮](./docs/showcase/01-toolbar.png)

## 用法

- **选个回答接着聊：** 点击回答下方的箭头切换，或点击数字直接选。下一次追问会沿着选中的回答和它所在的对话继续。
- **调整已有对话：** 可以重答、换模型，也可以编辑或删除消息。编辑提问时，点**保存**只修改内容，点**发送**才会生成回答。旧版本可以从版本树找回。
- **翻译和复制：** 在原文旁查看译文，也可以分别复制两种文本。

![回答的原文与译文按段显示](./docs/showcase/02-translation.png)

**探索子卡：** 配合 `dsh-btw-explore 0.3.4` 或更新版本，本插件从 `1.11.1` 起会在卡片内保存编辑和切换回答，保留来源引用。保存过程中关掉或换卡片，也不会把主窗口跳到别处。

## 常见问题

**旧版改过的会话怎么继续？** 打开会话时，插件会自动同步当时选中的回答和消息改动，原会话会保留。同步后的版本已归档时，点**取消归档并打开**。看到同步失败提示时，点**重试同步**。

**重答或切换回答会归档会话吗？** 从 `1.11.3` 起，工具栏不会自动归档会话。不同版本可能各自在 DSH 侧栏显示，也能在版本树中切换。已经归档的旧版本可以从版本树选中并打开。

遇到问题或有建议，欢迎提交 [Issue](https://github.com/VicissitudeYW/dsh-message-toolbar/issues)。

## 许可证

[MIT](LICENSE)
