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
| **Edit** | user messages | Saves a real context branch without generating. Send generates once from the revised question. Supports dropped/pasted attachments; the original question and continuation remain in the old version. |
| **Regenerate** | assistant messages | Creates a native session from the history before this question and sends it once. The replaced answer and its continuation are absent from the new request. `‹ 1/2 ›` selects the actual branch; the count opens model names and answer previews. |
| **Switch model** | assistant messages | Generates in a new branch with the chosen model, retaining native tools, reasoning and streaming. Answer selection also selects the context used by subsequent questions. |
| **Undo file edits** | before regenerate / switch model | Lists the files for confirmation and reverses only verifiable edits, preserving later changes outside the affected hunks. Conflicts or unverifiable files stop regeneration and report the outcome. |
| **Edit answer** | assistant messages | Edits markdown in place. Subsequent requests use the revised answer, without adding an answer choice. Paired tool records remain; later questions stay in the old version. |
| **Copy** | assistant messages | Once an answer has been replaced, edited or translated, the row carries a copy button of its own: it copies the answer on screen, while the app's copy button keeps copying the one in the log. |
| **Translate** | assistant messages | Pressing translate opens a dropdown of target languages; pick one and the answer is redrawn block by block, original and translation side by side. While it runs, the button becomes Stop translating. The same menu copies the translation on its own, or puts the answer back to the original. |
| **Delete message / answer** | user messages / assistant messages | Deleting a question removes that turn and its continuation from a new branch. Deleting an answer removes its assistant/tool history and continuation, selecting another answer if available or keeping the question alone. Original records remain recoverable in the version tree. |
| **Version tree** | conversation view | A turn-level branching tree of the whole conversation family, with the active path highlighted, model labels, timestamps, and restore/delete controls. |

While editing a question, **files dropped into the editor** leave with it; the paperclip in its
corner picks them too, and so does **Ctrl+V** — a screenshot on the clipboard becomes an image
attachment instead of a wall of pasted text. They go through DSH's own upload route and land in the
same attachment store as anything you attach in the composer — images stay images.

The editor is not its own design: it is the composer's. Same surface and panel radius, the rail above
the text, pictures as 64px thumbnails and files as the app's 240×64 cards (type glyph, name, and a
`PDF 4.2KB` line), with the remove button appearing on hover exactly as it does up there. A question
that already carried attachments replays with them.

Saving or sending stores attachment references in the branch's native `user/message`, so they
survive reloads and restarts. Older references in `~/.dsh/message-toolbar/state.json` participate in
migration too. Pending or failed uploads block saving and sending.

## Context branches and limits

- The plugin does not modify DSH. Each answer version uses a real DSH session, and selection navigates the native composer to it. Other toolbar-owned family entries are archived only after the target composer mounts. A running version can remain visible temporarily.
- Selecting an older answer restores its own continuation. Editing or deleting an earlier message truncates the new branch; the old continuation remains in its original version. Continuations from different branches are never spliced together.
- Branches increase session storage. Deletion changes the new branch's model context while retaining the original log for recovery in the version tree.
- Old display overrides and same-session retries are materialized on the first context operation. The composer also offers Sync context. Until synchronization, an old session still uses its old log. Unsafe migrations involving compacted or replaced history are rejected explicitly.
- Model switching uses the host's native selection. An explicit model-switch replay restores the prior selection after its matching turn ends (successfully, with an error, or by cancellation). A newer model choice made during the replay is preserved.
- New edits and answer identities live in session logs. Translations, deleted-version flags, navigation and legacy display state live in `~/.dsh/message-toolbar/state.json`. Moving machines requires sessions, plugin state and the DSH attachment store.
- Undoing depends on the `workspace-changes` record: without a git repository it only covers file-tool edits, and after a host restart older turns have no record.
- The host diff normalizes the final newline. Without exact snapshots, nonempty created/deleted files may be skipped rather than restored unsafely. Binary and oversized files are skipped too. Other safe files may already have been reverted; the UI reports counts and stops regeneration.
- Preflight, revalidation and rollback reduce risk but do not make filesystem operations transactional. Process death, storage faults and concurrent path changes can defeat rollback; errors expose retained recovery backup paths.
- State persistence uses an exclusive sibling lock, latest-state delta merging and atomic replacement, so multiple DSH processes can write the same state file. Lock timeouts and corrupt or future-schema state are reported and the original file is preserved. Network filesystems and hostile external writers are outside the guarantee.
- Locks are reclaimed only when their recorded owner has exited. Unknown or corrupt ownership metadata causes a conservative timeout. The state directory must support hard links; a process killed during a short cleanup window can leave a guard requiring inspection after the relevant DSH processes have been stopped.

## Native context branches in 1.11.0

Regeneration, answer selection, question/answer edits and deletion now use native DSH context branches.
They define the history used by subsequent requests while retaining native tools and streaming. Save
does not generate; Send generates once. Navigation failure keeps the source accessible, and legacy
display edits have an explicit migration path.

The installed DSH `0.2.2-rc.5` session engine with a scripted model verified actual request messages,
branch continuations, tool pairing, temporary model restoration and cold reload. Full DSH GUI and cloud
model acceptance testing remains outstanding; see the [verification report](docs/NATIVE-CONTEXT-2026-11-21.md).

## Cherry toolbar follow-up in 1.10.0

Compared with Cherry Studio's message toolbar, this release adds cancellable streaming translation: cancel reaches the HTTP request and the DSH provider signal, so partial text is never persisted; answer choices show the model and a short preview; clipboard success is awaited and failures are reported. Structured DSH error/aborted finishes are no longer treated as successful answers.

## Reliability follow-up in 1.9.1

Building on the 1.9.0 reliability refactor, this release restores the prior model after an explicit model-switch replay ends, including a claimed replay that fails before its user message is recorded. Restore errors are logged and contained so an asynchronous failure cannot escape and crash the host. Shared state writes use a cross-process lock, latest-state merge and stale-lock recovery. Concurrent answer deletion and replay preserve the still-visible original answer, while other concurrent fields, alternatives and translations are retained. `npm test` builds the current client and runs existing checks plus new regressions. Validation uses isolated state, temporary files and a client VM; real GUI and model-call acceptance testing remains outstanding.

## Screenshots

| | |
| --- | --- |
| ![Bilingual translation](./docs/showcase/02-translation.png) | ![Editing an answer](./docs/showcase/03-edit-answer.png) |
| **Translate.** Original and translation, block by block. | **Edit an answer.** The answer turns into an editor where it stands, holding its markdown source. |
| ![Deleting an answer](./docs/showcase/04-delete.png) | ![A failed answer](./docs/showcase/05-failed.png) |
| **Delete.** | **A failed answer** gets a toolbar too: regenerate, another model, delete. |

## Requirements

- DSH `>=0.2.2-rc.5 <0.3.0-0`. This release was verified against `0.2.2-rc.5`; later versions still require public API compatibility checks.

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
dsh plugin --profile web add file:./dsh-message-toolbar-1.11.0.tgz
```

Then restart DSH — host and client both load at startup.

## License

MIT
