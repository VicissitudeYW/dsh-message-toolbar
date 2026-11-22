<h1 align="center">dsh-message-toolbar</h1>

<p align="center">A Cherry Studio-style toolbar for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a>. Regenerate, switch models, edit, translate, and <strong>pick an answer to continue from</strong>, right below your messages.</p>

<p align="center">
  <strong>English</strong> · <a href="README.md">简体中文</a> ·
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-111827.svg"></a>
</p>

## Install

Works with DSH Desktop and Web from `0.2.2-rc.5` through `0.2.x`. Check that `dsh --version` runs in your terminal first.

**Windows Desktop (PowerShell)**

```powershell
git clone https://github.com/VicissitudeYW/dsh-message-toolbar.git
cd dsh-message-toolbar
dsh plugin --profile desktop add "file:$($PWD.Path.Replace('\', '/'))"
```

<details>
<summary>Web or Bash</summary>

```bash
git clone https://github.com/VicissitudeYW/dsh-message-toolbar.git
cd dsh-message-toolbar
dsh plugin --profile web add "file:$(pwd)"
```

Use `--profile desktop` for Desktop in Bash, or `--profile web` for Web in PowerShell. If you start DSH with a custom profile, use that name instead.

</details>

Restart DSH after installing. The toolbar appears below your messages.

## Usage

- **Regenerate or switch models.** Keep several answers to one question in the current conversation. The toolbar leaves the sidebar and archive alone.
- **Pick an answer and keep chatting.** Use the arrows below an answer, or click `2/3` to pick one. The conversation returns to that answer and its follow-ups, and your next message uses that history.
- **Edit or delete.** When editing a question, **Save** keeps the edit and **Send** generates a reply. Deleting the current answer selects another available answer. The switcher disappears when only one remains.
- **Translate and copy.** Read the translation alongside the original and copy either one.

## Update

If you installed from a local folder using the steps above, run these commands in that folder, then fully quit and reopen DSH:

```powershell
git pull --ff-only
npm run sync -- desktop
```

Use `web` instead of `desktop` for the Web profile. The sync command requires Node.js and npm.

**Open older conversations as usual.** The toolbar uses your saved answer selections and edits without a separate sync step. Older versions that already exist as separate conversations are still available from the version tree.

For bugs and suggestions, open an [issue](https://github.com/VicissitudeYW/dsh-message-toolbar/issues).

## License

[MIT](LICENSE)
