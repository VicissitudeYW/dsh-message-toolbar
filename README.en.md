# dsh-message-toolbar

[简体中文](README.md) · **English**

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH 0.2.x](https://img.shields.io/badge/DSH-0.2.x-4d6bfe.svg)](https://github.com/deepseek-ai/dsh)
[![tests](https://img.shields.io/badge/tests-77%20passing-brightgreen.svg)](test)

A message toolbar plugin for DSH (DeepSeek Harness).

![The toolbar under an answer, with the ‹ 3/3 › ring](./docs/showcase/01-toolbar.png)

---

## Features

| Action | Where | What happens |
| --- | --- | --- |
| **Edit** | user messages | Changes the text shown for that question. |
| **Regenerate** | assistant messages | Answers again in place, without opening a new conversation. The fresh answer to the same question is stored as a variant of that turn and swapped in for the logged one. `‹ 1/2 ›` switches between them. |
| **Switch model** | assistant messages | Every model's answer becomes a variant of the same turn; `‹ 2/3 ›` walks them without leaving the conversation. |
| **Undo file edits** | before regenerate / switch model | If the answer being replaced edited files, the row lists them and asks first. Confirming puts every file back the way it was before that answer; switching a model then adds the new answer to the `‹ 1/3 ›` ring. |
| **Edit answer** | assistant messages | The answer becomes an editor where it stands, holding the markdown source of its text. |
| **Translate** | assistant messages | Pressing translate opens a dropdown of target languages; pick one and the answer is redrawn block by block, original and translation side by side. |
| **Delete message / answer** | user messages / assistant messages | Removes a whole turn (message, answer, tool cards) or a single answer from the conversation. |
| **Version tree** | conversation view | A turn-level branching tree of the whole conversation family, with the active path highlighted, model labels, timestamps, and restore/delete controls. |

## Limits

- DSH session logs are append-only and cannot be rewritten, so "delete" hides rows in the view.
- Variants and translations live in `~/.dsh/message-toolbar/state.json`, not in the session log, so they do not travel with the conversation to another machine.
- Undoing depends on the `workspace-changes` record: without a git repository it only covers file-tool edits, and after a host restart older turns have no record.

## Screenshots

| | |
| --- | --- |
| ![Bilingual translation](./docs/showcase/02-translation.png) | ![Editing an answer](./docs/showcase/03-edit-answer.png) |
| **Translate.** Original and translation, block by block. | **Edit an answer.** The answer turns into an editor where it stands, holding its markdown source. |
| ![Deleting an answer](./docs/showcase/04-delete.png) | ![A failed answer](./docs/showcase/05-failed.png) |
| **Delete.** | **A failed answer** gets a toolbar too: regenerate, another model, delete. |

## Requirements

- DSH `0.2.0-rc.2` … `0.2.x`

## Install

From a checkout:

```bash
git clone https://github.com/VicissitudeYW/dsh-message-toolbar.git
cd dsh-message-toolbar
npm run build                 # regenerates lib/client.js from plugin.client.js
dsh plugin --profile web add file:$(pwd)
```

Or from a packed tarball:

```bash
npm pack
dsh plugin --profile web add file:./dsh-message-toolbar-1.0.0.tgz
```

Then restart DSH — host and client both load at startup.

## License

MIT
