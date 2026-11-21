# Architecture

`dsh-message-toolbar` ships a dependency-free ESM host and a browser client. Version 1.11.0 uses native DSH sessions for every consequential message operation. Display overlays remain for translation and for reading old plugin state before migration.

| File | Responsibility |
| --- | --- |
| `lib/index.js` | `/message-toolbar` HTTP route, native agent creation, version families, focus and translation |
| `lib/context-branches.js` | Copied seed construction, legacy normalization, stable question/answer identities |
| `lib/session-record.js` | Live/cold log reads and public seed options |
| `lib/toolbar-logic.js` | Family traversal and turn tree helpers |
| `lib/state-store.js` | Validated plugin state, translation task ownership and durable navigation |
| `lib/durable-state.js` | Cross-process file locking, mutation deltas and atomic replacement |
| `lib/model-selection.js` | Native pending/last-used model selection fold |
| `lib/workspace-revert.js` | Validated inverse hunks, staging, revalidation and recovery |
| `plugin.client.js` | Toolbar, editors, answer selection, translation, navigation and version tree |
| `lib/client.js` | Generated `window.__ModuleLoader__` bundle; never edited directly |
| `test/native-context.integration.mjs` | Optional installed DSH engine verification using a scripted model and temporary storage |

`package.json` points to `cordis.patch.yml` for the host plugin and declares the client service dependencies. `npm run build` wraps the source client with the host's React and stylesheet factory. `npm test` and `prepack` rebuild it automatically.

## Native context branches

DSH's append-only source log remains unchanged. The plugin calls public `agents.create({ seed, ... })` with an independently copied history and writes an ignorable `message-toolbar/version` marker into that seed. It does not import private DSH packages, patch the installation, replace a provider's request history, or use persistent surface replacements as temporary masks.

The source session is a recoverable version. The newly opened native session is the composer's real destination, so its `deriveMessages()` determines subsequent model requests. Native tools, reasoning, attachments and streaming continue through DSH's ordinary agent loop.

| Operation | Child history and generation |
| --- | --- |
| `retry` | Copy events before the target `turn/start`, then queue exactly one question with the selected text/attachments. The old answer and all later turns are absent. |
| `edit-prompt` | Copy through the target closed turn, rewrite its user message, keep the current answer, and truncate later turns. Save makes no model request. |
| `edit-answer` | Copy through the target closed turn and replace its final assistant text, retaining paired tool work. Clear the edited message's stream and opaque provider replay state so old text cannot override the edit. Later turns are truncated. |
| `delete-answer` | Copy through the question, remove all assistant/tool history in that turn and later turns, then close the prompt-only lifecycle in child setup. Select another surviving answer if available; otherwise open the question-only child. |
| `delete-question` | Copy only the history before the target turn. Its answer and continuation remain in the old version. |
| `adopt` / `adopt-all` | Materialize the selected legacy display history as native messages without generation. A selected answer can be adopted through its turn, or the whole visible legacy history can be synchronized. |

The Session constructor owns its `session/end-seed` boundary. The plugin supplies the complete copied seed as inherited history; prompt-only step/turn closers are appended in the public agent setup hook after that boundary. Setup clears inherited queued inbox entries before the child driver starts. The installed-runtime test checks that these histories persist and can resume cold.

Every created branch is flushed before success. Retry also flushes its queued prompt. A `false` flush result is an error, not an acknowledgement. Failure cancels/disposes the child and leaves the source available. A later state persistence failure cannot undo a model run already queued; HTTP success is never claimed for that failure.

The branch inherits the source workspace, cwd, preset and title. `sessionTitle.rename` pins the existing title when available, with the same public `session/title` event as fallback. It is an ordinary session, not a subagent. File changes are not automatically undone by branching.

### Stable answer choices

Schema-2 markers carry the owning session ID, effect, inverse source session, and a complete per-turn `context` snapshot. An entry records a logical question ID and answer ID. Question grouping also hashes the exact prior message history and question content; equal turn numbers or repeated wording alone never join unrelated choices.

A retry allocates a new answer ID. Editing the same answer retains its ID, so inherited copies and saved edits deduplicate instead of growing the selector. Deleting an answer records a durable identity tombstone, excluding that answer from all live choices while retaining old logs for explicit recovery.

`GET` builds `contextChoices[turn] = { active, questionKey, items }`. An item names the real session and includes model and preview metadata. The current copy wins deduplication, followed by newer branch metadata and continuation information. Selecting an answer restores that branch's own continuation; it never splices the continuation of a different answer into it.

A marker context is a complete snapshot, not a partial merge: deletions and rewinds must not resurrect identities from earlier markers. Schema-1 `message-toolbar/version` and older `message-tree/version` markers remain readable.

### Legacy display history

Versions before 1.11.0 used `runs`, `replays`, `prompts`, `answers` and `hidden` in plugin state. Those records remain readable. Normalization selects one real replay or text variant per question, applies prompt/answer overrides and hidden flags, remaps event references, and excludes discarded replay turns. Text-only legacy alternatives do not inherit the native alternative's discarded tool work.

The first context mutation normalizes its source before building a seed. Selecting a legacy answer materializes that choice. The composer also provides Sync context (`context-normalize`) for all current selections. Until synchronization the old session still uses its original log; the UI says so explicitly. Histories whose compaction/replacement or cross-answer references prevent safe migration fail visibly. There is no silent fallback to display-only mutation.

The retired mutation endpoints reject stale clients with a restart/update error. Read and translation APIs continue to support old data.

## Navigation and version ownership

A context operation prepares a durable `{ token, root, source, target, completed, archived }` navigation job. The client activates an archived target through public `workspaceRegistry.unarchiveSession`, waits for the session list, then calls `uiWorkspace.openSession`. Missing APIs, activation failure and the 15-second navigation timeout are visible errors.

Only after the target's `conversation.composer.dock` component mounts does it send `focus` with that token. This also works when deletion left an empty transcript. Focus unarchives the target and archives other toolbar-owned family members. Archiving a still-visible source would clear DSH's main pane, so creation and navigation preparation never archive the source. A running member that refuses archival is left visible.

Navigation serials discard obsolete client completions. Per-family host locks serialize focus and preparation; a newer handoff cannot overtake an archive already in progress. Tokens reject superseded focus requests. Pending jobs are exposed by GET so reload can finish a handoff. Failed focus is shown in the composer, not swallowed.

Native DSH forks/subagents sharing `parentSession` are separate conversations unless they have a recognized own toolbar marker. Family consolidation never archives those unrelated sessions. Deleting the currently open version marks it deleted and prepares navigation to its parent; archival waits for target mount. Deleting another version focuses the still-open source.

Branches increase session storage. Archiving and deleting a version in plugin UI do not physically erase its log.

## HTTP contract

The plugin owns the same-origin `/message-toolbar` route.

`GET ?sessionId=<id>` returns:

- `sessionId`, `rootSessionId`, `versions`, message index and per-turn text/tool/finish facts;
- `contextChoices`, `promptAttachments`, `pendingFocus`, `needsContextMigration`, `contextError`;
- `model`, `translations`, `shown`, `origins`, deleted-version IDs;
- legacy `answers`, `runs`, `replays`, `prompts`, `hidden` for compatibility and migration.

`GET ?models=1` returns the native provider/model catalog. `GET ?rows=1` enables a diagnostic DOM-row report, capped at 400 rows on upload.

| POST action | Payload and effect |
| --- | --- |
| `context-branch` | `sessionId, turn, operation, text?, files?, model?, stopPrevious?`; creates and flushes a native branch, returns its navigation target/token and created session ID |
| `context-select` | `sessionId, turn, id`; resolves a live answer choice and prepares navigation, or materializes a legacy choice |
| `context-normalize` | `sessionId`; materializes the current legacy selections without a model request |
| `prepare-focus` | `sessionId, sourceSessionId`; validates same-family ownership and prepares a durable job |
| `activate` | `sessionId`; publicly unarchives the target when necessary |
| `focus` | `sessionId, token`; commits the prepared handoff after target mount |
| `delete-version` | `sessionId, sourceSessionId?`; flags a non-root version and prepares safe navigation |
| `restore-version` | `sessionId`; clears its deleted flag and attempts activation |
| `translate` | `sessionId, lang, eventSeq? / turn?, text?, model?, stream?, force?`; auxiliary LLM translation, cached independently of model history |
| `translate-off` | `sessionId, turn`; cancels the task and hides the pair while retaining the translation cache |
| `answer-source` | `sessionId, turn`; reads the current editor baseline, including legacy display state |
| `changes` | `sessionId, turn`; lists recorded workspace changes and whether they can be verified |
| `revert` | `sessionId, turn`; explicitly reverses verifiable file changes before a requested retry |
| `models` | Same catalog as GET `?models=1` |
| `rows` | Diagnostic client flow-row report |

`edit`, `retry`, `answer-run`, `answer-generate`, `prompt-save`, `prompt-restore`, `answer-save`, `answer-select`, `answer-delete`, `answer-restore`, `run-select`, `run-delete` and `hide` are retired mutation actions. Type errors return HTTP 400; operational failures return 409. A stream already started returns an error frame instead of another JSON header.

## Client rendering

| Native slot | Component |
| --- | --- |
| `conversation.chat.assistant-actions` | `AssistantToolbar`: regenerate/model/edit/translate/delete and the real answer selector |
| `conversation.chat.turnTail` | `AnswerCard`: bilingual translation, legacy overlays, editor and failed-turn actions |
| `conversation.view` | `VersionsView`: branch tree and branch-level delete/restore |
| `conversation.composer.dock` | `ContextFocus`: mount acknowledgement, migration prompt and focus errors |

The source client is an IIFE returning `{ inject, apply }`. `TurnLocation` inputs are normalized with `turnNumberOf`. Model and language menus use DSH's native `Menu` when available, including keyboard navigation and checked rows; the count menu shows a model label and at most 120 characters of answer preview. The selector is immediately after the delete button and only appears with multiple live choices.

User messages retain native attachment/reference rendering. A DOM decorator adds the question toolbar through a React root, identified by `data-chat-flow-kind`, `data-chat-turn` and the native bubble/stack class suffixes. It overlays the editor or suitable markdown while keeping reference chips native. `BodyBoundary` restores the native bubble on markdown-render failure; answer rendering falls back to plain text. DOM changes in future DSH releases may require decorator updates.

Legacy display state still uses generated hide rules, stray-notice sweeps and outline filtering before migration. New edits/deletions do not depend on CSS to change model context. The outline follows the active native branch; old hidden/replay facts remain supported until synchronization.

The store rejects stale GET snapshots after mutations and coalesces invalidation. HTTP streams validate NDJSON frames, UTF-8 boundaries and terminal status, release their reader, and settle on `done` without waiting for a connection close. Clipboard actions wait for the actual write and report failure; operation identities prevent old success feedback from replacing a newer error.

### Attachments

Drop, paste and file picker use DSH's own binary upload route. The editor owns the whole attachment list, including removals; pending/failed uploads block Save and Send. Native branch messages retain uploaded file/image references, so normal DSH persistence and rendering serve them after reload. Legacy attachment overrides are normalized into those messages.

The editor follows native geometry (64px image tiles and 240x64 file cards), uses the host's file icon/size helpers, and releases object URLs. A picture can use its object URL until the attachment service provides a stored image URL.

### Translation

Translation is auxiliary: it does not change native model history. It sends text through the host LLM service without an artificial max-token cap. Structured error/aborted finishes reject partial output; max-token finishes mark truncation. Cache entries include source identity so changed text cannot silently reuse an old translation.

The client sends an AbortSignal through fetch; HTTP response closure cancels the host task and provider. Per-session/turn task identities and request order reject old deltas, errors and completions. Editing, deletion and explicit dismissal cancel the matching task. Cancelled partial text is not persisted.

Code fences, inline code and math are protected with numbered placeholders. Target-language script detection can preserve already translated sentences for Han, Kana, Hangul and Cyrillic scripts; Latin-script language detection is deliberately omitted. The client pairs completed paragraphs, keeps fenced blocks intact, and falls back to whole-text pairing when block counts disagree. During streaming it avoids re-pairing mid-sentence. The translation menu supports copying only the translated side.

## Plugin state and file recovery

`~/.dsh/message-toolbar/state.json` remains schema 1. It contains deleted-version flags, translation cache/shown/origin text, legacy answers/prompts/runs/replays/hidden, and pending navigation. Native edits and identities are durable session events. Moving installations requires session logs, plugin state and the attachment store.

Reads validate JSON, schema and nested dictionaries, including navigation fields. Invalid input is reported and preserved. Mutations use detached drafts; successful HTTP/stream completion flushes before acknowledgement. A sibling cross-process lock, newest-state delta merge, fsync and atomic replacement preserve unrelated concurrent updates. Answer/attachment lists merge by stable ID, hidden lists by value, scalar conflicts by last commit. Unknown lock owners are not reclaimed speculatively; local hard-link/rename support is required. A process killed in the cleanup window may leave a guard needing offline inspection.

Workspace undo is separate from history branching and requires an explicit user choice. `workspaceChanges` supplies diffs/snapshots; no-service and unavailable old records are reported. The revert engine verifies paths, aliases, encodings, hunks and EOF evidence, stages writes and rechecks all files before committing. Later edits outside matched hunks remain. Unverifiable files are skipped, and the client stops regeneration if any consequential skip remains. I/O failure attempts compensation and reports retained recovery files. This is not a filesystem transaction and cannot undo arbitrary tool side effects or process death.

## Verification and compatibility

The supported package range is `@deepseek-ai/dsh >=0.2.2-rc.5 <0.3.0-0`; this release was exercised with `0.2.2-rc.5`. Public APIs reduce dependence on implementation details but do not guarantee compatibility with every future version. Unsupported APIs produce explicit errors.

`npm test` runs source/bundle checks plus isolated host, client, state, seed, navigation, workspace recovery and sync tests. The optional installed-runtime runner imports DSH packages only inside the test, uses a temporary home and scripted LLM, observes actual `GenerateOptions.messages`, and verifies cold persisted resumes. It does not call a cloud model or change personal sessions. See [the 1.11.0 verification report](NATIVE-CONTEXT-2026-11-21.md) for final commands and limits.
