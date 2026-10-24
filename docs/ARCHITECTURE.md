# Architecture

`dsh-message-toolbar` is one DSH plugin with two halves that ship together:

```
package.json          dsh.bundle.patch -> cordis.patch.yml   (host plugin insert)
                      dsh.client        -> platform web      (client bundle)
cordis.patch.yml      - insert: [{ id: message-toolbar, name: dsh-message-toolbar }]
lib/index.js          host: /message-toolbar HTTP route + version branching engine
lib/toolbar-logic.js  pure functions: family walk, version ring, turn tree
lib/session-record.js session log reading with the same fallback chain DSH uses
lib/state-store.js    plugin-owned durable state (deleted cards, translation cache)
lib/client.js         GENERATED browser bundle (window.__ModuleLoader__ factory)
plugin.client.js      source of lib/client.js: UI, actions, version tree view
scripts/build-client.mjs  plugin.client.js -> lib/client.js
test/*.test.mjs       node:test suites (host HTTP contract, pure tree logic)
```

## Why branches are sessions

DSH session logs are append-only: a message cannot be rewritten in place. So none of
edit / regenerate / model-switch mutates a transcript. Each one:

1. resolves the boundary — the `turn/start` seq of the turn being replaced, minus one;
2. creates a **child session** seeded with the parent's events up to that boundary;
3. appends an `ignorable` marker event of type `message-toolbar/version` describing the
   operation (`edit` | `retry`), the target turn, the seq/indices that changed, and the
   inverse (`{ kind: 'restore-version', sessionId: parent }`);
4. for `edit`/`retry`, submits the (possibly rewritten) user message so the child answers;
   for a model switch, the same, but with `agentOptions: { provider, model }` overridden and
   the model recorded on the marker (`effect.model`) so the card can be labelled.

`ignorable: true` is mandatory — the core log reader rejects a whole log containing an
unknown non-ignorable event type.

Branch sessions are ordinary sessions: they are **not** `origin: 'subagent'` (that fences
`session.cancel` and model selection behind *agent-busy*) and they are **not** archived at
creation (the app cannot navigate to an archived session). They appear in the sidebar,
can be continued independently, and are attached to the parent's workspace so their files
resolve the same way.

### A branch keeps its parent's title

The fork is the same conversation, so its title must not change — but nothing made that
true. The `title` projection folds only `session/title` events, and the session-title
service pins a title only when it is user-sourced; for any other session it schedules a
fallback named after the **first human message**. A fork seeded up to the boundary usually
carries no `session/title` event (the parent's title is logged after its first answer, i.e.
after the boundary), and an edited first prompt is a completely different text — so the
branch renamed itself after what the reader had just typed.

`createVersionAgent` therefore logs its parent's title into the child, using
`ctx.sessionTitle.rename(session, title)` (falling back to appending the same
`session/title` payload: `{ title, messageSeqs: [], source: { kind: 'user' } }`). That is a
**pin**: the service's `onUserMessage` returns early for a user-sourced title, so no
fallback generation follows. It happens before the branch's prompt is queued, because the
pin has to exist when the child's first `user/message` arrives.

## Reading the family back

To render `‹ 2/3 ›` and the version tree, the host must know every sibling of a conversation
even when an ancestor was deleted:

- `message-toolbar/version` markers carry `inverse.sessionId`, i.e. each marker names its own
  owner's parent. Because a child's log inherits its ancestors' markers, a single surviving
  descendant's log describes the whole ancestry — deletion of the ancestor does not lose it.
- `ancestorChainFromLog(parentId, markers)` walks that chain (`markers.at(-1)` is the session's
  own marker); `collectFamily(rootId, entries)` flattens headers plus reconstructed ghosts into
  `[{ entry, depth }]`, so holes render as tombstones instead of splitting the tree.
- `rootOf(versions, sessionId)` finds the family root; `ringFor(versions, sessionId, turn)`
  returns the sibling alternatives of one turn plus the index of the current one.
- `buildTurnTree(versions, currentSessionId)` projects one node per turn
  (`<sessionId>#t<turn>`), with `current` and `onCurrentPath` flags for the view.

The older `message-tree/version` marker (from `dsh-plugin-message-edit`) has an identical
payload, so both types are accepted (`MARKER_TYPES`); existing branches keep working after
the switch.

## HTTP contract

Route `/message-toolbar` (registered lazily inside `ctx.effect`).

`GET /message-toolbar?sessionId=<id>` →
```json
{ "sessionId": "...", "rootId": "...", "model": {"provider","model","name"},
  "versions": [{ "sessionId","parentSessionId","targetTurn","operation","createdAt",
                 "current","archived","deleted","depth","model","turns":[...] }],
  "tree": [{"id","parentId","sessionId","turn","operation","text","time","current",
            "onCurrentPath","deleted","archived"}],
  "messages": { "<messageId>": {"seq","turn","role"} },
  "answers": { "<turn>": { "active": "native|<id>",
                           "items": [{ "id","kind":"model|edit","provider","model","name","text","at","baseId" }] } },
  "translations": { "<eventSeq|turn:n>": { "<lang>": {"text","provider","model","turn","role"} } },
  "shown": { "<turn>": "<lang>" },
  "origins": { "<turn>": "<text>" } }
```

`GET /message-toolbar?models=1` → `{ "providers": [{ "id","name","models":[{"id","name"}] }] }`
from `llm.listProviders()` + `llm.listModels(provider)`.

`POST /message-toolbar` with `{ "action": ... }`:

| action | payload | effect |
| --- | --- | --- |
| `edit` | `sessionId, eventSeq, blockIndex, text` | rewound child + followup |
| `retry` | `sessionId, turn, model?` | rewound child + followup (model optional) |
| `translate` | `sessionId, lang, eventSeq? , turn?, text?, model?, stream?` | auxiliary `llm.stream` call (no `maxTokens`), cached under `eventSeq` or `turn:<n>`; records `shown[turn] = lang` and `origins[turn] = <text>` so the answer is drawn bilingual, block by block. With `stream: true` it answers in NDJSON frames (`start` → `delta`* → `done`) |
| `translate-off` | `sessionId, turn` | drops `shown[turn]` and `origins[turn]`, folding the translation away (the cached translation stays) |
| `delete-version` | `sessionId` | flags the card deleted (root refused, 400) |
| `restore-version` | `sessionId` | clears the flag |
| `activate` | `sessionId` | un-archives (if needed) and attaches to the parent workspace |
| `focus` | `sessionId` | un-archives the target, archives every other family member (one visible conversation) |
| `answer-generate` | `sessionId, turn, model?, stream?` | `llm.stream` over a plain-chat transcript, stored as an answer variant; with `stream: true` the reply is an NDJSON frame stream (`start` / `delta` / `done` / `error`) |
| `answer-save` | `sessionId, turn, text, answerId?` | overwrites the visible answer in place: a variant's text is replaced (the ring keeps its size), the logged answer gets an `override` because the log cannot be rewritten |
| `answer-source` | `sessionId, turn, answerId?` | `{ turn, active, items, override, native, text }` — baseline for the editor |
| `answer-select` | `sessionId, turn, answerId` | flips the visible variant (`'native'` is legal) |
| `answer-delete` | `sessionId, turn, answerId` | drops a variant; if it was visible, the one before it in the ring (`native` first) takes over |
| `answer-restore` | `sessionId, turn` | drops the `override`, so the model's logged answer shows again |
| `answer-run` | `sessionId, turn, stopPrevious?, hidePrompt?` | answers a turn again **in the same session** with a real agent turn: replays its prompt as a new turn and returns `{sessionId, turn, replayedFrom, inPlace: true}`. `hidePrompt` marks the replayed prompt hidden in the same call, because that turn is not in the log yet and a later `hide` would be rejected as "第 N 轮不存在" |
| `changes` | `sessionId, turn` | `{ turn, supported, cwd?, files: [{path, display, added, deleted, kind, revertable, before, after}], total, added, deleted }` — what that turn changed on disk, read from `workspaceChanges`; `supported: false` carries `reason: "no-service" \| "not-recorded"` |
| `revert` | `sessionId, turn` | undoes those changes; `{ turn, reverted: [{path, display, action}], skipped: [{path, reason}], cwd }`. All-or-nothing: one file whose current content no longer matches what the turn left behind means **nothing** is written, and the 409 names the conflicts |
| `hide` | `sessionId, turn, scope: "turn"\|"answer"\|"prompt", hidden: bool` | hides/restores one turn, one answer, or the replayed prompt of a turn in the transcript view; returns the new lists |
| `models` | — | same catalog as `?models=1` |

Errors: `TypeError` → `400 {error}`, anything else → `409 {error}`.

## State

`~/.dsh/message-toolbar/state.json`:

```json
{ "schema": 1,
  "deleted": { "<sessionId>": { "at": 0, "operation": "...", "targetTurn": 0 } },
  "answers": { "<sessionId>": { "<turn>": { "active": "native", "items": [] } } },
  "hidden": { "<sessionId>": { "turns": [1, 4], "answers": [2] } },
  "translations": { "<sessionId>": { "<eventSeq|turn:n>": { "<lang>": { "text": "...", "at": 0 } } } },
  "shown": { "<sessionId>": { "<turn>": "<lang>" } },
  "origins": { "<sessionId>": { "<turn>": "<text the reader saw>" } } }
```

`answers` holds the in-session answer variants — answers that deliberately never enter the
session log (see below). `active: "native"` means the logged answer is the visible one.

Writes are debounced (200 ms) and atomic (temp file + rename). The store is a convenience
layer: a failure to persist never fails the operation.

### Turns without an answer

`GET ?sessionId=` also carries the per-turn facts the transcript itself does not expose: `turns` is
`[{ turn, text, time, answered, reason, open? }]`, derived from the log by `extractTurns` — `answered`
once a durable `assistant/message` with `surfaceOp: 'append'` (or none) lands in that turn, `reason`
from the `turn/end` payload (`error`, `aborted`, `completed`, …), `open: true` for a turn that never
ended. The chat view draws its action row only for a turn with a *closing message*, so a turn that
failed has no toolbar at all; the answer card uses `answered: false && !open` to draw one itself
(`.mtt-tail-actions`, `AssistantToolbar` with `failed: true` → retry / model switch / delete only).

## Client side

`plugin.client.js` is an IIFE body returning `{ inject, apply }`; the build wraps it in the
`window.__ModuleLoader__` factory that supplies `React` and `styles.insert` (which tags the
injected `<style>` with `data-plugin="dsh-message-toolbar"`).

Registrations (`slots.inject(name, () => slots.register(descriptor, Component))`):

| slot | descriptor | component |
| --- | --- | --- |
| `conversation.chat.node` | `key: 'user', priority: -1` | `UserMessageView` — bubble + copy/edit/regenerate/delete controls, inline editor (textarea, ⌘/Ctrl+Enter to send) |
| `conversation.chat.assistant-actions` | `id: message-toolbar, order: 30, inject: sessionId => ({ sessionId })` | `AssistantToolbar` — copy, regenerate (in place), model switch (in place), edit answer, translate, delete. Rendered inside the turn-tail action row, next to DSH's built-in copy/branch buttons |
| `conversation.chat.turnTail` | `id: message-toolbar-answers, order: -10` | `AnswerCard` — the answer on screen: a variant, an edit, a translation, or the failed-turn toolbar. Above the file changes (deliverables registers at order 0) |
| `conversation.view` | `id: message-toolbar, order` | `VersionsView` — turn-level branching tree with flip/restore/delete |

There is **no settings section**: the translate button opens the language dropdown at the moment it is
pressed (`LanguageMenuHost`, the same `Menu` the model picker uses), so the target language and the
translating model never need configuring. The only stored preference is the last language, so the
menu can tick it.

`TurnTailOwnerProps.turn` is a `TurnLocation` object (`{ turn, status, steps, … }`), not a number —
both turn-tail components therefore run it through `turnNumberOf()` before indexing state.

Icons inline the official primitives artwork (`@deepseek-ai/dsh-client-ui-primitives`, 16 px grid,
`strokeWidth: 1` / `ICON_MEDIUM_STROKE`), so the toolbar matches DSH's own action row in size,
weight and hover behaviour.

### The model picker is the composer's picker

`ModelMenuHost` does not paint a look-alike: it renders `Menu` from
`@deepseek-ai/dsh-client-ui-primitives`, the component the composer's model seat builds its
dropdown from. Rows are one `{ type: 'label' }` heading per provider plus one row per model,
`selection: 'check'` marks the model this turn currently answers with
(`answers[sessionId][turn].active`'s provider/model, else the session's configured model from the
payload's `model` field), `portal: true` lets it escape the action row's clipping, `align: 'end'`
hangs it off the button, `side` flips on the same space measurement our own popovers use, and the
branch action stays one click away as a pinned `footer` row. `closeOnPointerLeave` gives the
"menu disappears when the pointer leaves" behaviour without a listener of our own.

`dsh-client-ui-primitives` is one of the shell's static seed modules (the boot call passes
`react`, `react-dom`, `@deepseek-ai/dsh-client-store`, `-ui-slots`, `-ui-primitives`,
`-ui-dockkit`), so it resolves through `require()` without being listed in `dsh.client.inject`.
The lookup is defensive: if a host ever ships without `Menu`, `ModelMenuHost` falls back to the
plugin's own `.mtt-pop` markup rather than failing to compose.

Data comes from a small SWR store (`bySession`, 8 s TTL, invalidated on `sessions.list`
changes). Navigating to a version activates it first (un-archive → attach → `openSession`)
and waits for the session list to contain it (`openWhenListed`).

### In-session answer variants

Because a closed turn can never gain a second `assistant/message` (next section), "answer this
again in the same conversation" cannot be a log write. The plugin keeps those answers in its own
state instead:

1. `answer-generate` builds a **plain-chat transcript** for the turn (`transcriptMessages`): the
   user texts of every turn up to the target, plus the last appended assistant text of each
   preceding turn. Tool calls, file reads and process cards are deliberately excluded — a variant
   is a model comparison, not an agent run.
   A replayed answer is emitted as a **full message** — `{ id, role: 'assistant', content, source }`
   carrying the logged message's `id` and `source` — because `MessageBase` (`dsh-llm/lib/types/message.d.ts`)
   requires both, and an adapter silently drops entries that lack them: the request then reaches the
   model with no assistant turn at all and comes back as a single `finish` chunk with no content,
   which looks exactly like "the model returned nothing". When a reply is empty the handler says what
   did arrive (`重答失败：…（收到 finish×1）`), and whole-block replies (`block-end` with a text block)
   are collected for providers that do not stream token deltas.
2. With `stream: true` the handler answers with NDJSON frames — `start` (turn, provider, model),
   one `reasoning` per reasoning batch, one `delta` per token batch, then `done` (the stored
   payload) or `error`. The client writes text deltas into a per-turn "live" slot in the bundle
   store and reasoning into `live.reasoning`, so picking a model hides the old answer at once and
   fills the same place with the new one as it arrives; reasoning streams into a collapsible
   `ThinkingBlock` that folds itself away when the answer starts. The finished text is stored as an
   item of `answers[sessionId][turn]` (with `reasoning` kept alongside it) and becomes `active`.
3. `AnswerCard` (turn tail) renders the active variant **in place** and registers an `answer` mark
   through `useHideRule`, which rewrites a generated
   `<style data-plugin="dsh-message-toolbar-dyn">` containing three rules —
   `[data-chat-flow-kind="assistant-step"][data-chat-turn="N"]{display:none}` for the logged answer,
   plus the same shape for `turn-process` (the "finished in *N*s" line) and `tool` (that answer's
   tool cards), so a switched-in answer leaves no trace of the old one. These are the same node
   attributes the chat view itself emits (`data-chat-flow-kind` from `routedNode.kind`,
   `data-chat-turn` from `turnOf(node)`, which returns `location.turn.turn`).
4. `‹ i/n ›` is drawn by the assistant action row (not by the card), next to the delete button, and
   writes `answer-select`; slot `1` is always `native`, i.e. the logged answer, so the original is
   never lost and `active: 'native'` renders with no stylesheet rule at all. The row only draws the
   control when the turn has more than one answer; deleting the visible variant goes through
   `answer-delete`, and the answer before it in the ring (native when it was first) takes over.
5. **Editing overwrites the visible answer**, it does not append one: `answer-save` rewrites the
   active variant's `text` in place (`edited: true`, same id, ring size unchanged) and the card draws
   it through the very same `AnswerBody` → `MarkdownText` path as a generated answer, so nothing
   about its styling changes. When the visible answer *is* the logged one there is no variant to
   rewrite, so the turn record takes `override: { text, at }` instead: `active` stays `'native'`,
   `items` stays empty, and the ring never appears. The card then renders `override.text` through
   the same body and draws nothing else under it; `answer-restore` still drops the override, kept as
   the API-level way back instead of a button.

Consequences worth knowing: the log is untouched, so **later turns still see the original answer**
in their model context; and if a future DSH renames those attributes the rule simply stops
matching, leaving both answers visible instead of breaking the view.

### Deleting rows without rewriting the log

The transcript is append-only (see below), so a delete can only be a view decision. `hidden`
records it and the same generated stylesheet applies it:

| scope | rule | note |
| --- | --- | --- |
| `turn` | `[data-chat-turn="N"]{display:none}` | the turn's user row, its answer and its tail row all go: a deleted prompt leaves no orphan answer behind, and no placeholder either |
| `prompt` | that turn's user row renders `null` (our shadow node) | a prompt replayed by `answer-run`: the question it re-asks must not appear twice; its rail entry is dropped too |
| `answer` | one rule per kind in `DELETED_ANSWER_KINDS` (`assistant-step`, `turn-process`, `tool`, `turn-error`, `turn-max-tokens`, `model-retry`, `turn-tail`), each scoped to `[data-chat-turn="N"]` | everything the answer owns goes, including the tail row (which carries the action row and the file-change card); the user row stays, with its own toolbar, so the turn can be answered again |

A failed turn has no `assistant-step` row at all — only an error banner and the action row — which is why
the answer scope hides by *kind list* rather than by "the assistant row": deleting a failed answer removes
the error banner and its action row, and still leaves the prompt alone.

The `deleted` mark is not absolute: it is applied only while nothing of ours stands in the answer's place
(`answerGone = hidden.answer && !showingVariant`). The moment a variant is chosen, a stream starts or an edit
is saved, the card switches to the `answer` mark, which keeps the tail row — the row the card itself is
rendered in. Without that, a fresh answer to a just-deleted turn would be hidden by the hole it is filling.

Answering a turn again is **one action**, whichever row it is pressed on: the question's button and the
answer's button both call `generateInto()` → `answer-generate`, so the new answer is a variant of the same
turn and the ring shows `‹ 1/2 ›`. That includes a turn whose answer is gone — the deleted answer is simply
the first entry of the ring, and `answerGone` (see above) steps aside as soon as a variant exists.

`answer-run` is the *native* alternative: a question without an answer deserves a real agent run (thinking,
tool cards, streaming), and a closed turn cannot accept a second `assistant/message`. It replays the prompt
on the session's own agent — a fresh turn with the same text — and hands back the turn it opened, with
`hidePrompt` marking that prompt hidden in the same request (that turn is not in the log yet, so a later
`hide` would be rejected). The prompt renders as `null` (it is our own shadowed node, so no stylesheet is
needed) and its rail entry is dropped. Both buttons reach it only through `rerunAfterRevert` (below); the
cost, when used, is one replayed prompt in the log — visible to the model on later turns.

### Undoing what the answer did

An answer that edited files cannot be replaced by a text-only variant: the edits are still on disk, the
variant cannot run a tool, and the next model would build on top of work it never did. So a turn whose
answer changed files takes a different route — `changes` → ask → `revert` → answer again:

1. `changes` reads DSH's own record. `@deepseek-ai/dsh-workspace-changes` snapshots the whole work tree at
   `turn/start` and `turn/end` (git tree ids in a private object directory), copies every file a file tool
   is about to edit, and appends one `workspace/changes` event per top-level turn. Its service,
   `ctx.workspaceChanges`, serves the summary for that event's sequence and each listed file's comparison
   as hunks — three context lines, both sides. Without a repository or without git the summary falls back to
   the file-tool copies alone, so shell edits outside a repository are not recorded. The summaries live only
   as long as the host process that recorded them: after a restart the older turns answer `not-recorded`,
   and the row behaves as it always did.
2. `revert` applies those hunks **backwards**, per file, after checking that the file still contains exactly
   what the turn left there (`+`/` ` side at `newStart`). A file that no longer matches is a conflict, and a
   conflict means nothing is written at all — a half-reverted working tree is worse than an untouched one.
   A file the turn created is deleted; a file the turn deleted is recreated; binary and oversized files are
   skipped and reported (`skipped`), never guessed at.
3. Answering again: **regenerate** calls `answer-run`, so the new answer is a real agent turn with tools and
   DSH's own streaming page, and the answer being replaced is hidden (`hide` scope `answer`) — one question,
   one answer, replaced. **Switching a model** instead keeps the comparison semantics: `answer-generate`
   stores the new answer as a variant, so the ring grows to `‹ 1/3 ›` and the earlier answers stay reachable.

Several components want the same turn hidden (the answer card for an active variant, the assistant
toolbar for a deleted answer, the tail row for a deleted turn), so `nativeHideStyle` keeps a `marks` map
keyed by owner (`tail:<turn>`, `bar:<turn>`, …) and rebuilds the sheet from all marks, with a whole-turn
mark winning over an answer-side mark. The modes are `turn` (everything), `deleted` (the whole answer
side, tail row included), `answer` (body + process + tool cards only — what a switched-in variant needs,
because file changes belong to the turn) and `translate` (the logged body only — the paired view redraws
the original itself). `useHideRule(owner, turn, mode)` registers and clears one mark, which makes
unmounting self-cleaning; the rail hides its own marks through the navigation patch, not through this
sheet.

The model keeps reading the full log: a deleted answer is still in the context of later turns.
Erasing it for the model would require a rewritten session (a child seeded without that turn),
which is a separate, much larger operation.

### The turn rail follows the transcript

The rail on the right is fed from two places, both folded from the log: the host's `turnOutline`
session projection (every turn, loaded or not) and the chat view's own navigation items, which win
for a turn that is loaded (`dsh-client-ui-chat`, `mergeTurnRailItems`). Neither knows about a variant,
an edit, or a delete — those live in this plugin's state, not in the log.

The seam is the loaded half. `ChatView` asks `ctx.uiConversation.binding(session).target('chat')` for
a snapshot whose `navigation.items()` is the list it merges, so `installRailSync` wraps
`binding` (once, in `ctx.inject(['uiConversation'], …)`) and hands back a proxy that only rewrites
the `chat` target's snapshot:

- items for a deleted turn are dropped, so its mark leaves the ladder;
- for every other item, `response` is replaced with what is on screen when this plugin knows better
  (`live` stream text → the active variant's text → an override), and left alone otherwise, keeping
  the item's identity so nothing re-renders for nothing;
- the patched snapshot is memoized per host snapshot and keyed by the store's `railVersion`, which
  `notify()` bumps, so a switch or a delete repaints the rail without waiting for a host frame — and
  re-reading the same snapshot still returns the same array.

Dropping an item is not enough to remove a deleted turn's mark: the `turnOutline` half still carries
one entry per `turn/start`, and an entry there has no loaded twin to suppress, so it renders as an
`unloaded` mark that scrolls to a row this plugin has hidden — a click that lands somewhere else. The
projection cannot be rewritten (see above), so `railHideStyle` hides those marks by ladder position:
the ladder is rebuilt from the projection itself (`sessions.projectionStore(sessionId).values()
.turnOutline`, read-only, falling back to the host's `turns` list) and the mark's `data-index` is the
index in that same ascending list. The sheet is rewritten on every snapshot, empty included, so
switching to a session with nothing hidden drops the previous session's rules.

No projection is written: registrants sharing the `turnOutline` key share one unit, so a second
writer would fight the host's own frames. Nothing is written to the log either, so switching back
restores the original preview.

### Why a turn cannot gain a second answer


The session log cannot hold two answers for one turn. `dsh-session`'s invariant admits
`assistant/message` only while its own `turn`/`step` is open, and `step/start` numbers must
increase, so a settled turn can never receive a second answer in place. Surface replacements
(`surfaceOp: { op: 'replace' }`) are model-only by design — they never rewrite the human
transcript (`dsh-session/lib/types/surface.js`: "the wrong source for a human transcript").
Branching is therefore the only way to keep an alternative answer with tools attached.

To keep the sidebar from filling with near-identical conversations, every switch calls
`focus`: the target is un-archived and every other family member is archived, so one
conversation stays visible while the rest remain one click away in the version ring.
`focus` runs from the *target's* first mounted toolbar, because archiving the session that
is still current makes the workspace UI clear the main view. A member with a running turn
(`WorkspaceActiveSessionError`) is left visible rather than force-stopped.

Translation is drawn beside the answer, not instead of it: `translate` stores the translated text keyed by
the event seq the client handed over (or `turn:<n>` when the text on screen is a variant, which never lives
in the log), records `shown[sessionId][turn] = lang`, and remembers the original side in
`origins[sessionId][turn]` — necessary because a variant or an edit is not in the log, so the log cannot
tell us what the reader was looking at. `AnswerCard` then draws both sides through the same `AnswerBody` →
`MarkdownText` path: `textBlocks()` splits each side on blank lines (fenced code stays whole) and
`pairParagraphs()` interleaves them paragraph by paragraph, falling back to whole-text-above-whole-text when
the two sides disagree on block count instead of pairing the wrong halves. Because the original is redrawn
by us, the card registers the `translate` mark rather than the `answer` mark: only the logged body makes
way, while the turn's own process card and tool cards stay, since they are still that turn's record.
`translate-off` deletes only the `shown`/`origins` entries: the translation stays cached, the turn goes back
to what it showed before, and the language menu's first row is that call. There is no second surface — no
panel under the answer, no popover above the action row.

Two consequences worth writing down, because both were bugs once:

- **The card decides from `drawing`, not `showingVariant`.** A translated turn hides the logged answer and
  draws its own page; if the early return still keyed on `showingVariant` (which a translation is not), the
  answer area would be hidden *and* empty. `drawing = showingVariant || translation !== null ||
  liveTranslation !== null` is what both the early return and the failed-turn branch ask.
- **A translation carries no `maxTokens`.** It is exactly as long as the text it translates, so any cap is a
  guess — and 4096 was the guess that cut a 700-word article mid-sentence. The provider's own window is the
  only honest limit. If a model still stops on *its* length limit (`finish.reason` of `length`/`max_tokens`),
  the stored entry and the response carry `truncated: true` and the paired page draws one quiet line saying
  the rest is untranslated. Silence would look like a complete translation that stopped early.

### Streaming a translation

`translate` accepts `stream: true` and answers with the same NDJSON frames `answer-generate` does — `start`
(with `seq`, `turn`, `lang`, `provider`, `model`), one `delta` per token batch, then `done` carrying the same
payload a plain POST would return (cached translations answer with a single `done`). Host side both writers
share `respondStream(response, run)`; client side both share `streamOperation(operation, handlers)`, so there
is one reader to trust. The translation has its own live cell (`store.liveTranslations`, keyed
`${sessionId}|${turn}`) because nothing else about the turn is changing while it arrives: `AnswerCard` draws
the paired page on the first delta, and while the text is still empty it draws three bobbing dots (`.mtt-dots`)
in the translation column. During the stream the card keeps the whole original in one block and grows the
translation beneath it, so blocks never re-pair mid-sentence; paragraph pairing happens once, when the
translation is complete.

### Code and formulas are not translated

Handing code to a translator is asking for it to be rewritten: an identifier gets translated, a fence gets
re-indented, a LaTeX macro gets "corrected". So `translate` never sends it. `protectText()` walks the text with
two pattern lists — `BLOCK_PATTERNS` (fences, `~~~`, `$$…$$`, `\[…\]`) and `INLINE_PATTERNS` (`` `…` ``, `$…$`,
`\(…\)`) — and replaces every match with `⟦n⟧`, keeping the original in `kept[n-1]`. A block that already stood
on its own (`/(^|\n)[ \t]*$/` right before it) is replaced by its own paragraph, because a fence that comes back
mid-sentence renders as plain text instead of a code block; display math written inside a sentence is replaced
inline, where it was. The system prompt tells the model to copy placeholders unchanged and in order, and
`restoreText()` puts the originals back by number. Streaming restores as it goes, but holds back a placeholder
that has only partly arrived (`settledLength()`), so `⟦1` never appears on screen. The finished translation
collapses any padding blank lines (`/\n{3,}/g` → `\n\n`).

Text already written in the target language is lifted by the same mechanism, and lifted *first*:
`liftTargetLanguage()` rewrites sentence by sentence (`/[^\n。！？；!?;]+[。！？；!?;]?/g`) and replaces any piece
whose share of the target script is at least half with a placeholder. `TARGET_SCRIPTS` only covers languages a
script can identify — Chinese (han), Japanese (kana + han), Korean (hangul), Russian (cyrillic); Latin-script
targets are absent on purpose, because "English" and "German" are indistinguishable letter for letter and a
wrong guess would leave a paragraph untranslated. Lifting runs before the code patterns so that
`先运行 \`npm run build\` 再继续。` is kept whole, code included. On the client, a pair whose two sides are the
same text after whitespace normalisation (`sameText()`) is drawn once: a sentence that needed no translating
should not appear twice.

## Compatibility notes

- Peer: `@deepseek-ai/dsh >=0.2.0-rc.2 <0.3.0-0`.
- Slot contracts were written against `dsh-client-ui-conversation` /
  `dsh-client-ui-chat` `0.2.0-rc.2` (`conversation.chat.node`, `conversation.chat.assistant-actions`,
  `conversation.chat.turnTail`, `conversation.view`).
- A `conversation.chat.node` collision (e.g. `dsh-plugin-message-edit` also shadowing `user`)
  degrades to "the other plugin wins" for that slot; the remaining registrations still apply.
- `message-toolbar` is used as the cordis plugin id, HTTP path segment, event type prefix and
  state directory name, distinct from `message-edit`/`message-tree` to avoid collisions.
