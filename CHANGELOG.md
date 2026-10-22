# Changelog

## 0.6.0

- **Translation replaces the answer in place.** Picking a language used to leave the answer alone, drop a
  small preview popover under the action row and append a collapsible bilingual card to the turn tail — so
  one translate produced two extra boxes. Now the translated text *becomes* the answer: `translate` stores
  it and records which language the turn shows (`shown`), `AnswerCard` draws it through the same
  `AnswerBody` → `MarkdownText` path, and the logged row steps aside exactly as it does for a variant. Same
  typography, same code blocks, no extra surface.
- **The way back is the same menu.** While a translation is displayed the translate icon reads as on and the
  dropdown's first row is "Show the original" (`translate-off`), which only drops the language record — the
  cached translation stays, so flipping costs nothing.
- **Translated text can come from the screen, not just the log.** A variant or an edited answer is not in the
  session log, so the client now sends the text it is currently showing; the host caches it under
  `turn:<n>` and translates that instead of the (possibly stale) logged answer.
- Removed with it: `TranslationTail`, `TranslationPanel`, their stylesheet, and the `translationBadge` /
  `fromUser` / `fromAssistant` / `expand` / `collapse` strings. The plugin now registers four slots.

## 0.5.2

- **A switched-in answer now reads as if the turn had never been answered.** Replacing an answer used
  to hide only the logged `assistant-step` row, so the old answer's "finished in *N*s" line and its
  tool cards stayed above the new text, and the ring read `1/1` until the stream ended. The answer
  mark now hides `turn-process` and `tool` rows for that turn too, and the ring counts the answer
  being written, so picking a second model shows `‹ 2/2 ›` immediately.
- **Reasoning is streamed and kept.** `answer-generate` forwards `reasoning-delta` chunks as
  `reasoning` frames (`start` → `reasoning`… → `delta`… → `done`); the client streams them into a
  collapsible "thinking" block that folds itself away when the answer starts, and stores the
  reasoning on the variant, so it is still there when you switch back. Variants remain pure text
  generations — no tools — so a real tool run still means the branch path.
- **The `‹ i/n ›` ring keeps the action row's metrics** (28px box, 17px glyph, same hover) instead of
  the smaller type it had when it lived in a card header.

## 0.5.1

- **A deleted turn no longer keeps its mark in the right-hand rail.** The rail merges the host's
  `turnOutline` projection (one entry per turn, loaded or not) with the view's loaded items, and the
  projection half cannot be dropped from the client — so a deleted turn survived as an unloaded mark
  whose jump scrolled into a row this plugin had hidden, i.e. somewhere else. Those marks are now
  hidden by their position in the turn ladder, rebuilt from the projection read-only; the sheet is
  rewritten per snapshot so switching sessions does not carry one session's rules into another.

## 0.5.0

- **The turn rail on the right follows the transcript.** The rail is folded from the session log — a log
  this plugin deliberately never rewrites — so it used to keep showing an answer you had switched away
  from, and kept a mark for a turn you had deleted. The client now wraps the chat target's snapshot and
  rewrites its navigation previews on the way past: a deleted turn leaves the ladder, and a turn showing a
  variant (or your own edit) previews what is on screen, including an answer that is still being written.
  Nothing is written to the log, so switching back restores the original preview.

## 0.4.8

- **One trash per row.** A version card (any session with a parent — a branch answer, or a sub-agent's
  reply) used to show both the row-level delete and the delete-the-version button, two identical trash
  icons side by side. The row-level delete now steps aside on a version card and leaves that card only its
  own delete-the-version action.

## 0.4.7

- The failed-answer action row starts at the left edge of the content column instead of hugging the right
  margin, so it lines up with the answer text above it, the way DSH's own assistant action row does.

## 0.4.6

- **Deleting really deletes.** A hidden turn or answer no longer leaves a `deleted · restore` row behind:
  the whole turn goes (its own tail row included) or just the answer row, and a toast confirms it. The
  state flag and the generated stylesheet are unchanged — there is simply nothing drawn where the row was.
- **A failed answer has a toolbar.** DSH draws its action row only for a turn with a closing message, so a
  turn that ended in an error (or an abort) had no toolbar at all. The host now reports per-turn
  `answered` / `reason` / `open` in the `turns` payload, and the answer card draws a row for a closed,
  unanswered turn: regenerate, regenerate with another model, delete (which hides the whole turn, since
  there is no answer row to hide). No edit and no translate — there is no text to work on.

## 0.4.5

- **The answer stays above its file changes.** A variant is drawn in the turn tail, which is a *list*
  slot: `@deepseek-ai/dsh-client-ui-deliverables` (the "files changed" card) registers there with the
  default `order: 0`, and ours was `4`/`5` — ascending, so the answer landed underneath it once the
  logged row was hidden. Both entries now register at a negative order (`-10` for the answer, `-5` for
  the bilingual panel), which puts them first in the tail, exactly where the app itself draws the
  answer relative to that card.

## 0.4.4

- **A saved edit is now rendered, not shown as source.** The renderer lookup tested
  `typeof primitives.MarkdownText === 'function'`, but `MarkdownText` is a `memo()` object, so the
  check failed and every answer fell back to pre-wrapped plain text — editing looked like it had done
  nothing. The guard now accepts a component of either shape (and the same fix applies to the
  `TextShimmer` "generating" line).
- **No line under an edited answer.** The `Edited by you · Restore the original` row is gone, as
  requested; `answer-restore` stays available as the API-level way to drop an override.
- **The edit field no longer fights the reader.** It used to collapse to `height:auto` and re-grow on
  every keystroke, which scrolled the page to the caret each time — typing at the end of a long answer
  jumped back to the top. The field now has a fixed height (`clamp(140px, 34vh, 360px)`), scrolls
  inside itself, keeps its position, and is still manually resizable.

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
