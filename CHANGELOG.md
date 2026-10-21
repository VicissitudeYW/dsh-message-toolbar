# Changelog

## 0.4.3

- **Saving an edit overwrites the answer you were looking at** instead of adding a second one, so the
  ring no longer shows `‹ 1/2 ›` after a rewrite. A visible alternative is rewritten in place (same id,
  same place in the ring, `edited: true`); the logged answer — which no API can rewrite — takes an
  `override` on the turn record, leaving `active: 'native'` and `items: []` so the ring stays hidden.
- **An edited answer keeps the styling of a generated one**: the card draws whatever text is visible
  through the same `AnswerBody` → `MarkdownText` body, so markdown, code blocks and typography are
  unchanged.
- **The overwrite is reversible**: an overridden answer carries one muted line, `Edited by you ·
  Restore the original`, whose button drops the override (`answer-restore`) and gives the model's text
  back. Alternatives rewritten in place keep their earlier text nowhere, exactly like any other
  in-place edit — undo them by regenerating.

## 0.4.2

- **Editing an answer happens in the answer.** The pencil no longer opens a popover: the answer's place
  turns into a bordered editor holding the markdown source of its text — labelled `Editing` on the left,
  with ✕ to leave and a save button on the right, Esc to close and ⌘/Ctrl+Enter to save. The field grows
  with its content and keeps a resize handle. Tool calls and file-change cards are not part of an
  answer's text, so they stay on screen beside the box instead of inside it. User bubbles keep their own
  inline editor, which already worked this way.
- **The copy follows the reader.** Every string was already bilingual, but the bound translator took the
  app's locale as the only truth, and that value is provisional and browser-derived — which is how
  `Answer deleted` surfaced under a Chinese UI. A Chinese browser or document now wins outright and the
  locale service decides only when neither speaks Chinese; a locale switch drops the cached choice and
  already-mounted rows re-render.

## 0.4.1

- **The delete button asks one question.** Both confirmations lost their explanatory paragraph: the
  sheet is the question and the two buttons, nothing else.
- **Results are reported by a banner, not by the row.** Every "answer deleted / message deleted /
  variant deleted / copied" notice that used to appear as text inside the action row is now a toast at
  the top of the window that fades on its own (DSH's own `Toast`, or a copy of its stylesheet when the
  primitives package is missing). The action row is icons only. Failures use the same banner — the
  host's own sentence, the warning glyph and a longer hold — so a delete that did not happen says so
  instead of failing silently behind a closed popover.
- **Every colour now resolves through a theme alias.** The sheet defines its own aliases
  (`--mtt-surface`, `--mtt-fg`, `--mtt-line`, `--mtt-hover`, `--mtt-primary`, …) on `body`, where the
  theme declares its palette, and no rule hardcodes an ink colour any more — a guard test walks the
  sheet and fails on any `color` value that is not a `var()`, `inherit`, `transparent` or
  `currentColor`. Container rules also re-assert `color: var(--mtt-fg)` so text inside a node never
  falls back to the browser default (black) in dark mode, and buttons/fields inherit through
  `:where()`, which keeps `.mtt-btn-primary`'s inverted label winning at equal specificity.

## 0.4.0

- **Switching a model now looks like answering.** `answer-generate` streams NDJSON frames (`start`,
  `delta`…, `done`), the client paints them into a per-turn "live" slot: the previous answer is hidden
  the moment a model is picked, the new one is written into its place word by word. The area itself is
  the app's own: `MarkdownText` with `streaming: true` for the text (so a variant and a logged answer
  are typographically identical) and DSH's `TextShimmer` line while the answer is still empty — no
  plugin chrome, no custom loader. "Regenerate" from the assistant row or from a user bubble streams
  the same way.
- **The `‹ i/n ›` control moved into the action row**, right of the delete button, so it always sits at
  the bottom of the turn instead of inside the answer. It only appears when a turn has more than one
  answer, and a stream in flight already owns the last slot, so picking a second model reads `2/2`
  immediately; the answer body is plain flow text, with no card chrome.
- **Deleting the answer on screen falls back to the previous one**: `<2/3>` becomes `<1/2>`, the answer
  seen one click ago takes over (the logged answer when it was first). The row's trash deletes the
  visible variant when the answer is a variant, and hides the logged answer (view-level, restorable)
  when it is the original.
- One generation per turn at a time: the row disables its generate buttons while an answer of that
  turn is still streaming.

## 0.3.4

- **The settings panel is gone; translate asks for the language itself.** Pressing translate now opens
  a dropdown of target languages — the same native `Menu` the model picker uses — and the picked
  language is used immediately. Nothing has to be configured up front, which removes the entire
  `settings.section` registration along with the target-language and translate-model fields.
- The translating model is no longer a preference: the host picks its default resolution (the model
  that answered the turn), so `translate` is called without a `model` argument.
- The last language picked is remembered locally so the menu can tick it; the fallback popover (when
  the primitives package is missing) marks it the same way.

## 0.3.3

- **Delete a message, or just an answer.** The user bubble gained "delete this message" and the
  assistant row "delete this answer"; the deleted spot keeps a `deleted · restore` row so it is one
  click back. Useful right after a stalled turn leaves a pile of "continue" prompts behind.
- The session log is append-only, so this is a view operation: `hidden.turns` / `hidden.answers` in
  the plugin state, applied by the same generated stylesheet that hides replaced answers. **The
  model still reads the deleted text in later turns** — the confirmation says so.
- `nativeHideStyle` now merges marks from several owners (`tail:<turn>`, `bar:<turn>`) instead of
  keeping one global set, so a hidden turn and a hidden answer cannot clear each other.
- New host route `hide` (`sessionId, turn, scope: "turn"|"answer", hidden`) plus `hidden` in the GET
  payload; tests cover the round trip, a bad scope and a missing turn (400).

## 0.3.2

- **A stale host half now says so.** The client bundle is read from disk per request, but the host
  half is loaded once at `dsh web` start — so after an update the new UI can talk to old host code,
  which surfaced as `action 必须是 edit 或 retry`. The unknown-action error now lists the full
  vocabulary and points at the restart.

## 0.3.1

- **Regenerate on a user bubble answers in place too.** It still went through the branch path
  (a second conversation), because only the assistant row had been switched over. Both the user
  bubble and the assistant row now store the new answer as a variant of the same turn; editing the
  prompt remains the one action that branches, since the logged prompt cannot be rewritten.

## 0.3.0

- **The model picker is DSH's own dropdown.** "Switch model" now renders `Menu` from
  `@deepseek-ai/dsh-client-ui-primitives` — the component the composer's model seat uses — instead
  of a hand-built popover: provider headings, a check on the model this turn answers with, portal
  placement, keyboard walk, and the menu closing when the pointer leaves. The old markup remains as
  a fallback when that package is missing.
- The host payload gained `model` (per version and at the top level), read from the last
  `request/header`, so the picker can mark the session's configured model.

## 0.2.2

- **The user bubble is DSH's bubble again.** It had been painted with the same neutral tint the rest
  of the old CSS used, which turned the light-blue bubble grey. The rule now mirrors DSH's own
  `Sixlwa_bubble`: `background: var(--dsw-specific-bubble)` (deepseek-50 in light, neutral-bluish-850
  in dark), `border-radius: var(--dsw-radius-xl)`, `padding: 10px 16px`, the content-font line height
  and the same max-width formula.

## 0.2.1

- **The menus follow the theme.** Every colour now comes from DSH's own aliases (`bg-layer-2/3`,
  `border-l3/l4`, `label-primary/secondary/tertiary`, `interactive-bg-hover`, `button-primary-fill`,
  `state-error/success-primary`, `shadow-lv2`, `radius-*`). The old markup used
  `--dsw-alias-bg-elevated` — a token that **does not exist** — so the `#fff` fallback always won and
  the model menu, the edit popover, the version tree and the settings fields stayed white in dark
  mode. The alias block sits on `<body>` (not `:root`) because DSH applies its palettes to
  `body`/`body[data-ds-dark-theme]`, and a `var()` inside a custom property resolves against the
  element it is declared on.
- `scripts/preview-menu.mjs` renders the plugin's real CSS and DSH's real variables twice (light and
  dark) into `test/preview-menu.html`, so a colour that ignores the theme is visible in one
  screenshot.

## 0.2.0

- **Answer variants, in place.** Regenerate, switch model and edit-answer no longer fork a
  conversation: the new text is stored as a variant of the turn (`answers` in the plugin state) and
  rendered where the answer belongs, while the logged answer of that turn is hidden through a
  generated stylesheet. `‹ 1/2 ›` walks the variants; slot 1 is always the original answer.
- **Editable model answers.** The pencil in the assistant action row opens an editor seeded with the
  visible answer; saving stores a `kind: 'edit'` variant, so the model's own text stays reachable.
- **Official icons.** The toolbar now inlines the artwork of `@deepseek-ai/dsh-client-ui-primitives`
  (16 px grid, 1 px stroke) instead of hand-drawn glyphs, matching DSH's native action row in size,
  weight and hover behaviour. Only the translate glyph stays custom (primitives ships no such icon).
- **Real branches kept, moved.** The model menu's last row still creates a child-session branch for
  runs that need tools; switching between family members keeps driving `focus` (one visible
  conversation, the rest archived and listed).
- Fix: `conversation.chat.turnTail` hands over a `TurnLocation`, not a number, so bilingual panels
  never rendered. Both turn-tail components now normalise it through `turnNumberOf()`.
- Fix: `exports` now maps `./client`, so `dsh-client-modules` can compose the client bundle
  (previously `startup failed: 1 required plugin did not activate`).
- Fix: menus close on an outside pointerdown or Escape.

## 0.1.0

- First release: copy, edit user turns (rewound child session + regenerate), per-model branches with
  one visible member (`focus`), soft delete/restore of version cards, bilingual translation with
  per-turn caching, and a turn-level version tree in the conversation view.
