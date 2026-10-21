# Changelog

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
