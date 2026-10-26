# dsh-message-toolbar

<p align="center">
  <strong>English</strong> · <a href="README.md">简体中文</a>
</p>

---

A message toolbar plugin for DSH (DeepSeek Harness).

![The toolbar under an answer, with the ‹ 3/3 › ring](./docs/showcase/01-toolbar.png)

---

## Features

| Action | Where | What happens |
| --- | --- | --- |
| **Edit** | user messages | Changes the text shown for that question. |
| **Regenerate** | assistant messages | The agent answers again, in this conversation: a file it read is read again, a command it ran is run again, and the thinking, the tool cards and the stream are the same as the first time — nothing to tell apart. The fresh answer takes the answer's place; the one before it moves into `‹ 1/2 ›`. |
| **Switch model** | assistant messages | Also a real answer by the agent, pinned to the model you picked for that one answer; the conversation keeps its own model, and `‹ 2/3 ›` walks the answers without leaving the chat. |
| **Undo file edits** | before regenerate / switch model | If the answer being replaced edited files, those files are listed first; confirming puts them back the way they were before that answer, and only then is the question answered again. |
| **Edit answer** | assistant messages | The answer becomes an editor where it stands, holding the markdown source of its text. |
| **Translate** | assistant messages | Pressing translate opens a dropdown of target languages; pick one and the answer is redrawn block by block, original and translation side by side. |
| **Attachments** | user messages | A file sent with a message (a PDF, say) is drawn in the bubble as a file card — icon, name, size — so it never looks like it vanished on the way out. |
| **Delete message / answer** | user messages / assistant messages | Removes a whole turn (message, answer, tool cards) or a single answer from the conversation. |
| **Version tree** | conversation view | A turn-level branching tree of the whole conversation family, with the active path highlighted, model labels, timestamps, and restore/delete controls. |

## Limits

- DSH session logs are append-only and cannot be rewritten, so "delete" hides rows in the view.
- Variants and translations live in `~/.dsh/message-toolbar/state.json`, not in the session log, so they do not travel with the conversation to another machine.
- Undoing depends on the `workspace-changes` record: without a git repository it only covers file-tool edits, and after a host restart older turns have no record.
- Answering again appends another turn to the session log: that is the price of the agent really answering, and it is why one question can be seen twice by the model. The duplicate question row is hidden in the transcript.

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
