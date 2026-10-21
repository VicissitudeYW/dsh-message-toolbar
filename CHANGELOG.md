# Changelog

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
