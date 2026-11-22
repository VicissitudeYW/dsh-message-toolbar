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

## 用法

- **重答或换模型：** 同一个问题可保留多个回答。生成时留在当前会话，左侧栏不会多出会话，也不会触发归档。
- **选个回答接着聊：** 点击回答下方的箭头切换，或点 `2/3` 直接选。切换时会恢复该回答的后续问答，下一次追问也沿用这段历史。
- **编辑或删除：** 编辑提问时，点**保存**只修改内容，点**发送**会重答。删除当前回答后会切到另一条可用回答；只剩一条时隐藏切换器。
- **翻译和复制：** 在原文旁查看译文，也可以分别复制两种文本。

## 升级

如果用上面的命令从本地目录安装过，在原目录运行以下命令，再完全退出并重新打开 DSH：

```powershell
git pull --ff-only
npm run sync -- desktop
```

网页版把 `desktop` 改为 `web`。同步命令需要 Node.js 和 npm。

**旧会话可以直接继续。** 打开旧会话时，插件会沿用工具栏保存的回答选择和消息改动，无需点击「同步上下文」。旧版已创建的独立会话仍保留，可从版本树打开。

遇到问题或有建议，欢迎提交 [Issue](https://github.com/VicissitudeYW/dsh-message-toolbar/issues)。

## 许可证

[MIT](LICENSE)
