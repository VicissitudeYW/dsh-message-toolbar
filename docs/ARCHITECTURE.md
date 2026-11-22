# Architecture

`dsh-message-toolbar` ships a dependency-free ESM host and a browser client. In 1.12, the original DSH agent generates every new answer. The plugin records the selected answer and its follow-ups separately from DSH's append-only log.

| File | Responsibility |
| --- | --- |
| `lib/index.js` | HTTP route, same-agent retry, model request hook, legacy navigation and translation |
| `lib/in-session-context.js` | Selected answer history, legacy display compatibility, model and UI projections |
| `lib/context-history.js` | Native turn reader and legacy state detection |
| `lib/session-record.js` | Live and persisted session reads |
| `lib/toolbar-logic.js` | Family traversal and turn tree helpers |
| `lib/state-store.js` | Validated plugin state, translation task ownership and durable navigation |
| `lib/durable-state.js` | Cross-process file locking, mutation deltas and atomic replacement |
| `lib/model-selection.js` | Native pending/last-used model selection fold |
| `lib/workspace-revert.js` | Validated inverse hunks, staging, revalidation and recovery |
| `plugin.client.js` | Toolbar, editors, answer selection, translation, navigation and version tree |
| `lib/client.js` | Generated `window.__ModuleLoader__` bundle; never edited directly |
| `test/in-session-context.integration.mjs` | Installed DSH engine verification with a scripted model and temporary storage |

`package.json` points to `cordis.patch.yml` for the host plugin and declares the client service dependencies. `npm run build` wraps the source client with the host's React and stylesheet factory. `npm test` and `prepack` rebuild it automatically.

## Same-session answer history

Message operations use the current session ID throughout. Regeneration admits a new prompt through the existing agent's `followup`. The plugin associates the new answer with its question by the admitted prompt's ID. It records the current path and each answer's continuation in `state.json`. Selecting a different answer restores that answer's own follow-ups. Saving an edit keeps the surrounding messages and makes no model call. Deleting a question removes that turn from the selected history and keeps the later messages. Deleting an answer selects the preceding available answer and its continuation when possible. If there is no other answer, the question and its subsequent messages remain. The native events are preserved.

DSH's loop builds a frozen request from the native surface. Before it reaches a provider, the plugin's `llm/stream` listener forwards a projected request with the selected messages, current model controls, tool information and the original cancellation signal. DSH receives the normal stream and executes tools through the same agent. This extension runs only on changed or legacy toolbar sessions. Consumers of the raw DSH log, including native replay and export, still see the physical history.

The projection retains automatic turns and the selected tool calls and results. A historical compaction checkpoint is reused only if it covers the same unchanged messages in the same order. Otherwise the projection uses the selected source messages. The plugin rejects a native compaction model request that includes discarded answers; a long selected history can still hit the model's context limit.

Older display edits and choices are interpreted on first read and first model request. This path reads existing `runs`, `replays`, `prompts`, `answers` and `hidden` without rewriting DSH events or opening a migration session. Text-only legacy answers exclude the discarded answer's tool work. The first new toolbar mutation stores the selection in the current format.

## Navigation and version ownership

Navigation jobs remain for selecting an already existing conversation from the legacy version tree, or deleting a historical version card. The client waits for the session list, then calls `uiWorkspace.openSession`. Opening a selected archived conversation requires an explicit action and uses `workspaceRegistry.unarchiveSession`.

The target's `conversation.composer.dock` component acknowledges the handoff with `focus` after it mounts, even when deletion left an empty transcript. Completion and cancellation only update pending navigation state. No toolbar action submits a new archive request to DSH.

Navigation serials discard obsolete client completions. Per-family host locks serialize handoff preparation, completion and cancellation. Tokens reject superseded focus requests. GET exposes pending jobs so reload can complete a handoff. The client shows activation failures and navigation errors, including the 15-second timeout.

Native DSH forks and subagents sharing `parentSession` remain separate conversations unless they have a recognized toolbar marker. Deleting the open version returns to its parent when available, or to another available version. If there is no other openable version, the deletion waits for the reader to open one. Deleting another version leaves the current conversation open.

Historical versions created by 1.11 are native sessions and may appear separately in the DSH sidebar. Deleting or restoring their version cards changes availability in the toolbar and preserves the session log.

## HTTP contract

The plugin owns the same-origin `/message-toolbar` route.

`GET ?sessionId=<id>` returns:

- `sessionId`, `rootSessionId`, `versions`, message index and per-turn text/tool/finish facts;
- `contextChoices`, `promptAttachments`, `pendingFocus`, `contextError`, and `contextOrder` when legacy replies need to be placed earlier in the transcript;
- `model`, `translations`, `shown`, `origins`, deleted-version IDs;
- `answers`, `runs`, `replays`, `prompts`, `hidden` for rendering and compatibility.

`GET ?models=1` returns the native provider/model catalog. `GET ?rows=1` enables a diagnostic DOM-row report, capped at 400 rows on upload.

| POST action | Payload and effect |
| --- | --- |
| `context-update` | `sessionId, turn, operation, id?, text?, files?, model?, stopPrevious?`; mutates the selected history and returns the same `sessionId` with `inPlace: true` |
| `context-branch` / `context-select` | Compatibility aliases for in-session mutations; never navigate or create a session |
| `context-normalize` | Compatibility acknowledgement for a session already interpreted in place |
| `prepare-focus` | `sessionId, sourceSessionId`; validates same-family ownership and prepares a durable job |
| `activate` | `sessionId`. Reopens the selected archived session via the public workspace registry. |
| `focus` | `sessionId, token`; commits the prepared handoff after target mount |
| `cancel-focus` | `sessionId, token`. Cancels the prepared handoff. |
| `delete-version` | `sessionId, sourceSessionId?`; flags a non-root version and prepares safe navigation |
| `restore-version` | `sessionId`. Clears its deleted flag in the toolbar. |
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
| `conversation.view` | `VersionsView`: navigation and card management for earlier native versions |
| `conversation.composer.dock` | `ContextFocus`: mount acknowledgement and focus errors for legacy navigation |

The source client is an IIFE returning `{ inject, apply }`. `TurnLocation` inputs are normalized with `turnNumberOf`. Model and language menus use DSH's native `Menu` when available, including keyboard navigation and checked rows; the count menu shows a model label and at most 120 characters of answer preview. The selector is immediately after the delete button and only appears with multiple live choices.

User messages retain native attachment/reference rendering. A DOM decorator adds the question toolbar through a React root, identified by `data-chat-flow-kind`, `data-chat-turn` and the native bubble/stack class suffixes. It overlays the editor or suitable markdown while keeping reference chips native. `BodyBoundary` restores the native bubble on markdown-render failure; answer rendering falls back to plain text. DOM changes in future DSH releases may require decorator updates.

The transcript and outline read the selected path. Visibility rules, including notices next to a hidden turn, are scoped to each conversation pane so the same turn number in a separate card is unaffected.

The store rejects stale GET snapshots after mutations and coalesces invalidation. HTTP streams validate NDJSON frames, UTF-8 boundaries and terminal status, release their reader, and settle on `done` without waiting for a connection close. Clipboard actions wait for the actual write and report failure; operation identities prevent old success feedback from replacing a newer error.

### Attachments

Drop, paste and file picker use DSH's own binary upload route. The editor owns the whole attachment list, including removals; pending/failed uploads block Save and Send. Regeneration reuses the original session's attachment references. A saved edit supplies the updated references in the selected request.

The editor follows native geometry (64px image tiles and 240x64 file cards), uses the host's file icon/size helpers, and releases object URLs. A picture can use its object URL until the attachment service provides a stored image URL.

### Translation

Translation is auxiliary: it does not change native model history. It sends text through the host LLM service without an artificial max-token cap. Structured error/aborted finishes reject partial output; max-token finishes mark truncation. Cache entries include source identity so changed text cannot silently reuse an old translation.

The client sends an AbortSignal through fetch; HTTP response closure cancels the host task and provider. Per-session/turn task identities and request order reject old deltas, errors and completions. Editing, deletion and explicit dismissal cancel the matching task. Cancelled partial text is not persisted.

Code fences, inline code and math are protected with numbered placeholders. Target-language script detection can preserve already translated sentences for Han, Kana, Hangul and Cyrillic scripts; Latin-script language detection is deliberately omitted. The client pairs completed paragraphs, keeps fenced blocks intact, and falls back to whole-text pairing when block counts disagree. During streaming it avoids re-pairing mid-sentence. The translation menu supports copying only the translated side.

## Plugin state and file recovery

`~/.dsh/message-toolbar/state.json` remains schema 1. It contains selected histories, deleted-version flags, translation data, legacy display state and pending navigation. Moving installations requires session logs, plugin state and the attachment store.

Reads validate JSON, schema and nested dictionaries, including navigation fields. Invalid input is reported and preserved. Mutations use detached drafts; successful HTTP/stream completion flushes before acknowledgement. A sibling cross-process lock, newest-state delta merge, fsync and atomic replacement preserve unrelated concurrent updates. Answer/attachment lists merge by stable ID, hidden lists by value, scalar conflicts by last commit. Unknown lock owners are not reclaimed speculatively; local hard-link/rename support is required. A process killed in the cleanup window may leave a guard needing offline inspection.

Workspace undo is separate from selecting a conversation history and requires an explicit user choice. `workspaceChanges` supplies diffs/snapshots; no-service and unavailable old records are reported. The revert engine verifies paths, aliases, encodings, hunks and EOF evidence, stages writes and rechecks all files before committing. Later edits outside matched hunks remain. Unverifiable files are skipped, and the client stops regeneration if any consequential skip remains. I/O failure attempts compensation and reports retained recovery files. This is not a filesystem transaction and cannot undo arbitrary tool side effects or process death.

## Verification and compatibility

The supported package range is `@deepseek-ai/dsh >=0.2.2-rc.5 <0.3.0-0`; this release was exercised with `0.2.2-rc.5`. Public APIs reduce dependence on implementation details but do not guarantee compatibility with every future version. Unsupported APIs produce explicit errors.

`npm test` covers the host, built client, state, legacy navigation, workspace recovery and sync. `test/in-session-context.integration.mjs` runs in the installed Electron binary's Node mode with the path to `resources/app.asar`. It observes actual scripted adapter requests and verifies native persistence and restart behavior in a temporary home. The [1.11.0 report](NATIVE-CONTEXT-2026-11-21.md) documents the previous architecture.
