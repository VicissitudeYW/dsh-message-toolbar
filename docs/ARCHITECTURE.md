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
  "translations": { "<eventSeq>": { "<lang>": {"text","provider","model","turn","role"} } } }
```

`GET /message-toolbar?models=1` → `{ "providers": [{ "id","name","models":[{"id","name"}] }] }`
from `llm.listProviders()` + `llm.listModels(provider)`.

`POST /message-toolbar` with `{ "action": ... }`:

| action | payload | effect |
| --- | --- | --- |
| `edit` | `sessionId, eventSeq, blockIndex, text` | rewound child + followup |
| `retry` | `sessionId, turn, model?` | rewound child + followup (model optional) |
| `translate` | `sessionId, seq, lang, model?` | auxiliary `llm.stream` call, cached |
| `delete-version` | `sessionId` | flags the card deleted (root refused, 400) |
| `restore-version` | `sessionId` | clears the flag |
| `activate` | `sessionId` | un-archives (if needed) and attaches to the parent workspace |
| `focus` | `sessionId` | un-archives the target, archives every other family member (one visible conversation) |
| `answer-generate` | `sessionId, turn, model?` | `llm.stream` over a plain-chat transcript, stored as an answer variant |
| `answer-save` | `sessionId, turn, text, baseId?` | stores a hand-edited answer as a variant |
| `answer-source` | `sessionId, turn, answerId?` | `{ turn, active, items, native, text }` — baseline for the editor |
| `answer-select` | `sessionId, turn, answerId` | flips the visible variant (`'native'` is legal) |
| `answer-delete` | `sessionId, turn, answerId` | drops a variant, falling back to `native` when active |
| `hide` | `sessionId, turn, scope: "turn"\|"answer", hidden: bool` | hides/restores one turn or one answer in the transcript view; returns the new lists |
| `models` | — | same catalog as `?models=1` |

Errors: `TypeError` → `400 {error}`, anything else → `409 {error}`.

## State

`~/.dsh/message-toolbar/state.json`:

```json
{ "schema": 1,
  "deleted": { "<sessionId>": { "at": 0, "operation": "...", "targetTurn": 0 } },
  "answers": { "<sessionId>": { "<turn>": { "active": "native", "items": [] } } },
  "hidden": { "<sessionId>": { "turns": [1, 4], "answers": [2] } },
  "translations": { "<sessionId>": { "<eventSeq>": { "<lang>": { "text": "...", "at": 0 } } } } }
```

`answers` holds the in-session answer variants — answers that deliberately never enter the
session log (see below). `active: "native"` means the logged answer is the visible one.

Writes are debounced (200 ms) and atomic (temp file + rename). The store is a convenience
layer: a failure to persist never fails the operation. Delete is deliberately soft — the
session log and the branch itself stay valid, so restore is exact.

## Client side

`plugin.client.js` is an IIFE body returning `{ inject, apply }`; the build wraps it in the
`window.__ModuleLoader__` factory that supplies `React` and `styles.insert` (which tags the
injected `<style>` with `data-plugin="dsh-message-toolbar"`).

Registrations (`slots.inject(name, () => slots.register(descriptor, Component))`):

| slot | descriptor | component |
| --- | --- | --- |
| `settings.section` | `id: message-toolbar, order` | prefs (stop previous turn, target language, translate model) |
| `conversation.chat.node` | `key: 'user', priority: -1` | `UserMessageView` — bubble + copy/edit/regenerate/delete-card controls, inline editor (textarea, ⌘/Ctrl+Enter to send) |
| `conversation.chat.assistant-actions` | `id: message-toolbar, order: 30, inject: sessionId => ({ sessionId })` | `AssistantToolbar` — copy, regenerate (in place), model switch (in place), edit answer, translate, delete card. Rendered inside the turn-tail action row, next to DSH's built-in copy/branch buttons |
| `conversation.chat.turnTail` | `id: message-toolbar-answers, order: 4` | `AnswerCard` — the active answer variant of a turn, with `‹ i/n ›` and the variant tools |
| `conversation.chat.turnTail` | `id: message-toolbar-translations, order: 5` | `TranslationTail` — bilingual panels under a turn |
| `conversation.view` | `id: message-toolbar, order` | `VersionsView` — turn-level branching tree with flip/restore/delete |

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
2. The streamed text is stored as an item of `answers[sessionId][turn]` and becomes `active`.
3. `AnswerCard` (turn tail) renders the active variant **in place** and registers an `answer` mark
   through `useHideRule`, which rewrites a generated
   `<style data-plugin="dsh-message-toolbar-dyn">` containing
   `[data-chat-flow-kind="assistant-step"][data-chat-turn="N"]{display:none}` — the same node
   attributes the chat view itself emits (`data-chat-flow-kind` from `routedNode.kind`,
   `data-chat-turn` from `turnOf(node)`, which returns `location.turn.turn`).
4. `‹ 1/2 ›` writes `answer-select`; slot `1` is always `native`, i.e. the logged answer, so the
   original is never lost and `active: 'native'` renders with no stylesheet rule at all.

Consequences worth knowing: the log is untouched, so **later turns still see the original answer**
in their model context; and if a future DSH renames those attributes the rule simply stops
matching, leaving both answers visible instead of breaking the view.

### Deleting rows without rewriting the log

The transcript is append-only (see below), so a delete can only be a view decision. `hidden`
records it and the same generated stylesheet applies it:

| scope | rule | note |
| --- | --- | --- |
| `turn` | `[data-chat-turn="N"]{display:none}` + `[data-chat-turn="N"][data-chat-flow-kind="turn-tail"]{display:revert}` | the tail row is re-shown so the `deleted · restore` row stays clickable |
| `answer` | `[data-chat-flow-kind="assistant-step"][data-chat-turn="N"]{display:none}` | the user message and tool cards stay |

Several components want the same turn hidden (the answer card for an active variant, the assistant
toolbar for a deleted answer, the tail row for a deleted turn), so `nativeHideStyle` keeps a
`marks` map keyed by owner (`tail:<turn>`, `bar:<turn>`, …) and rebuilds the sheet from all marks,
with a whole-turn mark winning over an answer-only mark. `useHideRule(owner, turn, mode)` is the
hook that registers and clears one mark, which makes unmounting self-cleaning.

The model keeps reading the full log: a deleted answer is still in the context of later turns.
Erasing it for the model would require a rewritten session (a child seeded without that turn),
which is a separate, much larger operation.

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

Translation is bilingual by design: the original message is untouched, the translation is
appended in the turn tail as a collapsible panel per language, so both texts stay readable
and copyable side by side.

## Compatibility notes

- Peer: `@deepseek-ai/dsh >=0.2.0-rc.2 <0.3.0-0`.
- Slot contracts were written against `dsh-client-ui-conversation` /
  `dsh-client-ui-chat` `0.2.0-rc.2` (`conversation.chat.node`, `conversation.chat.assistant-actions`,
  `conversation.chat.turnTail`, `conversation.view`, `settings.section`).
- A `conversation.chat.node` collision (e.g. `dsh-plugin-message-edit` also shadowing `user`)
  degrades to "the other plugin wins" for that slot; the remaining registrations still apply.
- `message-toolbar` is used as the cordis plugin id, HTTP path segment, event type prefix and
  state directory name, distinct from `message-edit`/`message-tree` to avoid collisions.
