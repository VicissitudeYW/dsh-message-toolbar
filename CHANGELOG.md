# Changelog

## 0.9.4

- **Changing the answer forgets the translation of the previous one.** A translation describes the text it was
  asked for, so it is now dropped when that turn gets another answer, a rewrite, a restored original, or a
  deleted variant — otherwise the reader would be served prose about an answer that is no longer on screen.
- Found while testing the plugin end to end in a real window (see `docs/testing/`).

## 0.9.3

- **Regenerating from the question is the same action as regenerating from the answer.** Both add another
  answer to that turn, so `‹ 1/2 ›` appears and the earlier answer stays reachable; neither opens a second
  conversation. This also covers a turn whose answer was deleted: the deleted answer is simply the first entry
  of the ring, instead of that button switching to a different mechanism (a replayed prompt in a new turn).
  `answer-run` stays available as an API for clients that want the native agent page, and the prompt-hiding
  path stays wired for them.

## 0.9.2

- **Text already in the target language is not translated again.** Sentences are checked for the target
  script (`TARGET_SCRIPTS`: han for Chinese, kana + han for Japanese, hangul, cyrillic) and lifted out before
  the request, so translating a half-Chinese answer into Chinese no longer produces a second copy of the
  Chinese half — it is neither sent to the model nor billed. Latin-script targets are deliberately excluded:
  a script cannot tell English from German, and a wrong guess would leave a paragraph untranslated.
- **A pair that matches is drawn once.** On screen, a paragraph whose translation came back identical to the
  original is rendered as one block instead of two.
- **No rule beside a translation.** `.mtt-pair-tr` loses its left border and inset; the two halves are told
  apart by colour alone, and the sizing stays: 2px original → translation, 18px before the next original.

## 0.9.1

- **Code and formulas are never translated.** Fenced blocks, inline code, display math and inline math are
  lifted out of the request and replaced with `⟦n⟧` placeholders, then restored byte for byte, so a
  translation can no longer reformat `console.log(x)`, rename an identifier or break `\frac{a}{b}`. A block
  that already stood on its own keeps its own paragraph (a fence restored mid-sentence would render as plain
  text); display math written inside a sentence stays inline. Placeholders are restored as the stream
  arrives, and a half-arrived placeholder is held back so `⟦1` never flashes on screen.
- **Pairs read as pairs.** The gap between an original and its translation stays tight (2px), the gap before
  the next original grows to 18px, so the eye follows one paragraph at a time instead of running the two
  languages together. The rule before a translation is 2px instead of 0.5px.

## 0.9.0

- **A translation is streamed, not awaited.** `translate` now answers in the same NDJSON frames an answer
  does (`start`, a `delta` per token batch, `done`), so the paired page appears at the first token and grows
  in place. Until words arrive the translation column shows three dots bobbing in place of the text (slower
  for reduced-motion users) — the page never sits blank while the round trip is out.
- **Translation has no token cap.** A translation is exactly as long as the text it translates, so every cap
  was a guess — and 4096 was the guess that cut a 700-word article mid-sentence. The request now leaves
  `maxTokens` unset and lets the provider's window be the only limit; a model that still stops on its own
  length limit is still reported as `truncated`.

## 0.8.3

- **A translated answer can no longer paint an empty area.** Since 0.7.0 the paired page replaced the plain
  answer, but the card still decided "do I draw anything?" from `showingVariant` — which no longer counted a
  translation. So a turn that was only translated hid the logged answer (translate mode) *and* drew nothing
  (early return): a blank answer area. The card now asks `drawing = showingVariant || translation !== null`.
- **A truncated translation says so.** Translation used a 4096-token budget, which cut a 700-word article
  mid-sentence — and the reader had no way to know the rest was missing. The budget is now 8192, and when the
  model still stops on its length limit the response and the cached entry carry `truncated: true`, which draws
  one small line under the paired page.

## 0.8.2

- **The translate button turns into a spinner while it waits.** A translation takes a round trip, and the
  button that started it is the only place that can say so: the glyph becomes the app's own loading arc
  (`.mtt-spin`), the tooltip reads "translating", the menu cannot be opened meanwhile, and the glyph is back
  the moment the answer lands — or fails. Reduced-motion users get the same arc at a slower pace.

## 0.8.1

- **A replayed prompt is counted before its projection arrives.** The rail ladder is now the union of the
  `turnOutline` projection and the log's own turn list, so a turn created a moment ago cannot fall out of the
  ladder — which matters because the rail hides marks by position, and a short ladder would hide the wrong
  question instead of the replayed one.

## 0.8.0

- **A deleted answer is answered again in the same conversation.** A closed turn can never take a second
  `assistant/message` — the log's invariant forbids it — so the answer is not written in that turn: the prompt
  is replayed as a new turn of the *same* session and that turn's prompt row is hidden (`prompts` scope). What
  you get is the question where it always was, and under it DSH's own live page: thinking chain, tool cards,
  streaming, every bit of it native. No child session, no jump, no fourth copy of the conversation.
- The replayed prompt is dropped from the turn rail as well, so the outline still reads one entry per question.
- `answer-run` is the host action behind it; `hide` gained the `prompt` scope, and the client keeps the list in
  its cache so the hidden prompt never flashes back.
## 0.7.3

- **Regenerating a deleted answer runs a real agent turn again.** After deleting an answer, pressing regenerate
  on the prompt used to start an in-place text variant — and nothing appeared at all, because the deletion mark
  hid the very tail row the new answer would be drawn in. A question without an answer now gets a real run: the
  prompt is re-sent in a seeded branch (the transcript still holds it once), so the thinking chain, the tool
  cards and the streaming arrive the way they do for any newly sent message, and the plugin walks you to that
  branch. A turn that still has an answer keeps the in-place variant path.
- **A fresh answer is never hidden by the deletion that came before it.** The `deleted` mark now applies only
  while nothing of ours occupies the answer's place; as soon as a variant, a stream or an edit exists, the card
  switches to the `answer` mark and the tail row stays.
- **One owner per turn for hiding rows.** The action-row toolbar no longer registers its own hide mark (the
  answer card owns the turn), which removes the last way two marks could disagree about the same turn.

## 0.7.2

- **Deleting an answer now deletes the whole answer side.** It used to hide only the message body, so a
  deleted answer left its action row (and its file-change card) floating on the transcript, and a deleted
  *failed* answer left the error banner behind. The `answer` scope now hides every row kind an answer can
  own — `assistant-step`, `turn-process`, `tool`, `turn-error`, `turn-max-tokens`, `model-retry`,
  `turn-tail` — through a new `deleted` hide mode. The prompt keeps its row and its own toolbar, so the turn
  can be answered again.
- **Deleting a failed answer no longer deletes the question with it.** The failed branch used the `turn`
  scope, which is why "delete" sometimes took the user message along and sometimes did not.
- Switching model or translating an answer keeps the file-change card: those use the `answer` /
  `translate` modes, which never touch the tail row.

## 0.7.1

- **The delete confirmation works again.** Since the confirm boxes moved into a portal (0.6.1) they live in
  `document.body`, outside the row that opened them — but the dismiss-on-outside-pointer listener only recognised
  the inline `.mtt-menu-wrap`. The pointerdown on "delete" therefore counted as an outside click: the box was
  unmounted, and the following click had nowhere to land, so the button did nothing at all. The listener now
  ignores every surface of our own (`.mtt-menu-wrap`, `.mtt-pop`, `.mtt-pop-float`), so confirming a message
  delete, an answer delete, a variant delete or a card delete reaches its handler.

## 0.7.0

- **A translation is read against its original, not instead of it.** Picking a language used to repaint the answer
  in the target language, which destroyed the thing the reader was comparing against. The answer area is now
  bilingual, block by block: original paragraph, its translation, next paragraph, both through the same
  `AnswerBody` → `MarkdownText` path so the typography is unchanged. `textBlocks()` splits each side on blank lines
  with fenced code kept whole, and `pairParagraphs()` interleaves the two — when the sides disagree on block count
  the whole translation follows the whole original instead of pairing the wrong halves. Only the logged body makes
  way for our paired view (a new `translate` hide mark), so that turn's process card and tool cards stay visible.
- **The language list ticks nothing.** Picking a language is a command, not a setting, so the dropdown no longer
  highlights a "current" row; the only stateful row is "Hide the translation", which folds the pair back into the
  original.
- The host remembers the original side (`origins[sessionId][turn]`) because a variant or an edit never enters the
  session log, so the log alone cannot say what the reader was looking at.

## 0.6.1

- **The delete confirmation is no longer covered or clipped.** It used to be an absolutely positioned child of the
  action row, so DSH's flow rows painted over it and cut it off at their bounds. Confirmations now render through
  a portal on `document.body` (`Popover`, via `react-dom`'s `createPortal`) and are placed next to their button
  with fixed coordinates, re-measured on scroll and resize. All four confirm boxes (delete message, delete answer,
  delete variant, delete card) use it.
- **"Regenerate" no longer fails with an empty answer.** The replayed transcript carried earlier assistant turns
  as `{ role, content }`, but a replayed answer has to be a real message — `id` and `source` included — or the
  adapters drop it and the request reaches the model with no assistant turn at all, which comes back as a single
  `finish` chunk and nothing else. The transcript now reuses the logged message identity, and an empty reply
  reports what did arrive (`收到 finish×1、text-delta×0…`) instead of a vague "no content". Whole-block replies
  (`block-end` text blocks, for providers that do not stream token deltas) are collected too.
- Client **and** host changed: restart `dsh web`.

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
