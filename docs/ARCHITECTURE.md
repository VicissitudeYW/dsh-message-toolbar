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
| `models` | — | same catalog as `?models=1` |

Errors: `TypeError` → `400 {error}`, anything else → `409 {error}`.

## State

`~/.dsh/message-toolbar/state.json`:

```json
{ "schema": 1,
  "deleted": { "<sessionId>": { "at": 0, "operation": "...", "targetTurn": 0 } },
  "translations": { "<sessionId>": { "<eventSeq>": { "<lang>": { "text": "...", "at": 0 } } } } }
```

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
| `conversation.chat.node` | `key: 'user', priority: -1` | `UserMessageView` — bubble + copy/edit/regenerate/translate/delete-card controls, inline editor (textarea, ⌘/Ctrl+Enter to send) |
| `conversation.chat.assistant-actions` | `id: message-toolbar, order: 30, inject: sessionId => ({ sessionId })` | `AssistantToolbar` — copy, regenerate, model switch, translate, delete card. Rendered inside the turn-tail action row, next to DSH's built-in copy/branch buttons |
| `conversation.chat.turnTail` | `id: message-toolbar-translations, order: 5` | `TranslationTail` — bilingual panels under a turn |
| `conversation.view` | `id: message-toolbar, order` | `VersionsView` — turn-level branching tree with flip/restore/delete |

Data comes from a small SWR store (`bySession`, 8 s TTL, invalidated on `sessions.list`
changes). Navigating to a version activates it first (un-archive → attach → `openSession`)
and waits for the session list to contain it (`openWhenListed`).

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
