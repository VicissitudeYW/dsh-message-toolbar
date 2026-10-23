# End-to-end test run · 真机测试记录

Every feature was driven in a real window, not only in unit tests. This folder keeps the screenshots
so the behaviour can be checked without repeating the run.

所有功能都在真实窗口里点过一遍（不只是单元测试）。这里保存截图，免得以后再跑一遍才能确认行为。

## How the run was made · 怎么跑的

| Item | Value |
| --- | --- |
| DSH | 0.2.0-rc.2, `web` profile |
| Plugin | `dsh-message-toolbar` 0.9.3 → 0.9.4 (see the finding below) |
| Host | a throwaway instance: `dsh --profile web --no-open --port 48102` |
| Window | Microsoft Edge, headless, driven over the DevTools protocol |
| Session | a fresh conversation in **默认工作区**, prompt: *用两句话解释递归，并给一个 Python 代码块示例。* |

The prompt was chosen so the answer contains a fenced code block: that is what makes the
"code is not sent to the translator" rule observable.

特意让回答里带一个代码块，这样「代码不送去翻译」这条规则才看得出来。

## What each screenshot shows · 每张截图对应的功能

| # | Screenshot | Checked |
| --- | --- | --- |
| 00 | [00-start.png](00-start.png) | Plugin loads in a fresh window; no console error, no layout shift |
| 01 | [01-new-session.png](01-new-session.png) | New conversation inside 默认工作区 |
| 02 | [02-first-answer.png](02-first-answer.png) | Question row: copy / edit / regenerate / delete. Answer row: regenerate / edit / switch model / translate / delete. Next to the app's own icons, our glyphs share the 28 px box, 17 px icon and 8 px gap |
| 03 | [03-regenerated-ring.png](03-regenerated-ring.png) | Regenerate → `‹ 2/2 ›`, the new answer replaces the old one in place, its thinking block is folded above it, and the app's own "已完成 · 用时" row is hidden |
| 04 | [04-ring-back-to-1.png](04-ring-back-to-1.png) | `‹ 1/2 ›` — switching back shows the logged answer again, "已完成" row included |
| 05 | [05-model-menu.png](05-model-menu.png) | Model picker is the app's own dropdown (provider groups, current choice ticked, branch row last) |
| 06 | [06-language-menu.png](06-language-menu.png) | Language menu: nine languages, nothing ticked — choosing is an action, not a setting |
| 07 | [07-translated-pair.png](07-translated-pair.png) | Translation is drawn beside the original, paragraph by paragraph; the code block stays untranslated and keeps its highlighting |
| 08 | [08-edit-answer.png](08-edit-answer.png) | The editor replaces the answer area (not a popover) and shows markdown source, ✕ and 保存 at its top right |
| 09 | [09-edit-saved.png](09-edit-saved.png) | After saving, the answer is markdown again: headings, list, highlighted code — no `##` or backticks left on screen |
| 10 | [10-delete-confirm.png](10-delete-confirm.png) | The confirmation floats above the row (portalled, never clipped by the conversation) and asks one question |
| 11 | [11-variant-deleted.png](11-variant-deleted.png) | Deleting the visible variant drops it from the ring and falls back to the previous answer: `‹ 3/3 ›` becomes `‹ 2/2 ›` over the older text (the translation still painted here is the finding below) |
| 12 | [12-answer-hidden.png](12-answer-hidden.png) | Deleting the whole answer leaves no trace: only the question stays, result reported by a toast at the top |
| 13 | [13-user-regenerate.png](13-user-regenerate.png) | Regenerating from the question adds another answer (ring `‹ 3/3 ›`) instead of opening a second conversation |

## Finding · 测试中发现的问题

**A translation outlived the answer it described.** After translating an answer, generating another
answer for the same turn (or switching variant, or editing, or deleting a variant) kept showing the old
translation beside the new text — the translation is cached per turn, and nothing dropped it when the
turn's text changed. Fixed in 0.9.4: `clearTranslationForTurn()` runs on every answer mutation, and
`changing the answer forgets the translation of the old one` in `test/host.test.mjs` keeps it that way.
Verified on the live host: `shown: {"1":"en"}` before, `shown: {}` and no cached `turn:1` after
regenerating.

**翻译会比它所翻译的回答活得更久。** 同一轮换了回答（重答、切换、编辑、删掉某个备选）之后，旧译文还
贴在新文字旁边 —— 译文按轮缓存，改文字时没人清它。0.9.4 修好：每次改动回答都调用
`clearTranslationForTurn()`，并加了回归测试。真机上验证过：重答前 `shown: {"1":"en"}`，重答后
`shown: {}` 且缓存里的 `turn:1` 也没了。

## Not covered here · 这张清单没有覆盖的部分

- **Tool calls inside a variant.** A variant answer is one plain model call, so it cannot produce tool
  cards; only "…或新建回答卡片（另开一个会话，可用工具）" runs the real agent. 备选回答是纯文本生成，
  不可能有工具卡片；要工具就走菜单最后一行开新分支。
- **The right-hand rail.** The rail follows deletions and re-answers (`nav button[data-index]` hiding),
  but it is covered by unit tests rather than by a screenshot here.
- **Narrow layouts and mobile.** Only a 1280×900 window was used.
