# Cherry Toolbar Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Bring the DSH plugin closer to Cherry Studio's message toolbar by adding safe, end-to-end translation cancellation and more informative answer selection, with source-grounded compatibility documentation.

**Architecture:** Preserve the existing DSH renderer and true agent turns. Thread one cancellable translation operation through the web client, HTTP stream lifetime, and DSH's `llm.stream` signal; use per-turn ownership to suppress stale writes. Improve the native answer-selection menu with short text previews. Correct the Cherry comparison to distinguish display switching from branch/context semantics.

**Tech Stack:** Node.js ESM, Cordis plugin host, browser Fetch/AbortController, DSH `llm.stream`, native DSH React `Menu`, node:test.

**Spec:** `docs/superpowers/specs/2026-11-21-cherry-toolbar-interactions-design.md`

## Global Constraints

- Use only public DSH 0.2.2-rc.5 API contracts; do not fake agent/tool history or write durable surface replacement events.
- Preserve actual DSH assistant/tool transcript rows, model selection restoration, existing translation protection/cache rules, and user-approved edit/delete semantics.
- Add no runtime dependency; do not alter the user's installed DSH copy or `~/.dsh` state; do not restart DSH or publish npm.
- No partial/aborted translation may be persisted or shown as complete.
- Tests must use isolated user state and observe real host/client behavior.

## Review Focus

1. Client disconnected during LLM initialization or before first token: abort prompt/stream work and leave no busy row or cache entry.
2. Old translation resolves after same-turn cancel and retry: it cannot clear the new task or write its result.
3. Normal completed stream and non-stream cached translation keep existing success behavior.
4. Parallel translations in separate turns: cancellation is scoped and does not abort the neighbor.
5. Aborted request after stream completion/response close: avoid surfacing as a normal failure or losing an already confirmed complete result.

---

### Task 1: End-to-end translation cancellation

**Files:**
- Modify: `plugin.client.js`
- Modify: `lib/index.js`
- Modify: `test/helpers/client-harness.mjs`
- Modify: `test/helpers/host-harness.mjs`
- Test: `test/client-regressions.test.mjs`
- Test: `test/host-regressions.test.mjs`

**Interfaces:**
- `streamOperation(operation, handlers)` accepts optional `handlers.signal` and passes it to fetch.
- `translateInto(sessionId, turn, body)` owns one `AbortController` by session/turn, passes its signal to `streamOperation`, returns `null` on abort, and clears only the controller/live cell it created.
- A client `cancelTranslation(sessionId, turn)` aborts that translation only.
- The streamed translation route owns a request `AbortController`, aborts it when the response closes before natural completion, passes its signal to the provider stream, and calls `translateOff`'s same-turn cancellation bridge.

- [x] Write a client test that starts a real `translateInto`, captures its fetch signal, cancels it, and proves it settles without cache/writeback or a live busy cell; run it and observe the expected failure.
- [x] Write a host test that starts a streamed translation, closes the fake response while `llm.stream` awaits abort, and proves the provider received an aborted signal and no persistent translation exists; run it and observe the expected failure.
- [x] Implement per-turn client controller ownership and abort-aware streaming/settlement; add a state-aware cancel button path while keeping normal language selection unchanged.
- [x] Implement host response-lifetime cancellation, propagate `signal` to `ctx.llm.stream`, prevent aborted results from caching and abort the matching provider on `translate-off`.
- [x] Rerun both focused tests and check same-turn retry, separate-turn isolation, normal result and stale stream ownership cases.

### Task 2: Make answer choices identifiable

**Files:**
- Modify: `plugin.client.js`
- Modify: `test/helpers/client-harness.mjs`
- Test: `test/client-regressions.test.mjs`

**Interfaces:**
- `ringChoices(run, ring, turns, answers)` derives each choice's short preview from the matching run turn or variant text, while keeping stable IDs, selection and model labels.

- [x] Add a behavior test that renders multiple native answer choices and verifies the selected menu rows carry the correct model plus matching response preview.
- [x] Add a variant / empty-preview test and verify its IDs and selection remain unchanged.
- [x] Render answer labels with compact model and preview text, truncate long previews consistently, and omit only missing previews without changing ring navigation.
- [x] Run the client regression tests and check the menu stays keyboard-selectable through the native primitive.

### Task 3: Correct comparison and usage documentation

**Files:**
- Modify: `docs/cherry-studio-comparison.md`
- Modify: `README.md`
- Modify: `README.en.md`

**Interfaces:** None.

- [x] Rewrite the Cherry comparison from source at SHA `e00f061f66297fc8adcaf8ef378be67942565fac` and list evidence paths for toolbar action registration, sibling navigation, translation cancellation and answer groups.
- [x] Correct README descriptions so the ring preview and translation stop behavior are visible; keep existing limitations of real DSH replay/context behavior explicit in both languages.
- [x] Review citations/links, translation parity and version/package claims for consistency.

### Task 4: Review, verify and deliver

**Files:** All scoped files above.

**Interfaces:** None.

- [x] Run `npm test`, `npm run build`, syntax checks, `git diff --check` and `npm pack --dry-run --json --ignore-scripts`; review generated package contents.
- [x] Run the changed UI CSS/DOM check when available and inspect the actual diff for original UI conventions.
- [x] Request one independent branch review, resolve important findings with regression tests, and rerun affected checks.
- [x] Update the project version and release notes only if justified by the final behavior.
- [x] Remove the completed temporary TODO CSV, record limitations honestly, commit the finished change, and fast-forward main and push it to the configured GitHub remote.
## Verification and review record

- Source research and spec completed against the fixed Cherry and DSH commits listed in the comparison document. Context7 quota was exhausted; official GitHub search and pinned source were used as the documented fallback.
- Translation and clipboard changes were first exercised with failing regressions. Independent review then reproduced four additional important cases: async session-read ordering, cancellation after a confirmed result, legacy selected-answer previews, and DSH tunnel close semantics. All four were fixed and checked by the same reviewer; focused host/client tests pass 95/95.
- Final `npm test`: 160 node:test cases, 159 passed, 1 skipped because this Windows host does not grant file-symlink privileges, 0 failed. Both legacy host/client scripts passed. This command also builds `lib/client.js` from the current source.
- Host, state-store and generated-client syntax checks plus parsing the client factory body passed. `git diff --check` passed. `npm pack --dry-run --json --ignore-scripts` reports version 1.10.0 and 29 expected files; no tests, temporary TODO CSV, test state or local dependencies are packaged.
- `impeccable detect --json --changed` returned `[]`. A browser fixture used current plugin source, React 18.2 and DSH's pinned native Menu. Keyboard selection updated the active answer; Stop canceled a live replacement translation and restored the previous complete one. Light desktop and dark 390px layouts were inspected; the dark menu bounds were 12–350px within a 390px viewport and document width stayed 390px.
- The first fixture load exposed a missing fake GET response, which was fixed in the temporary fixture; it was not a plugin failure. The fixture lacks the full DSH frame and icon sprite and uses a controlled provider. This is not full DSH GUI or real model acceptance testing and does not establish full Web Worker compatibility.
- The actual desktop-installed plugin was read-only verified as 1.8.8. This work does not sync that copy, change personal state/sessions, restart DSH or publish npm.
- Runtime implementation and its spec were committed as [`137536c639e2b9fd9b7386782b4850e0fa483b74`](https://github.com/VicissitudeYW/dsh-message-toolbar/commit/137536c639e2b9fd9b7386782b4850e0fa483b74). The original main checkout fast-forwarded cleanly from d5969e6; push succeeded and `git ls-remote origin refs/heads/main` confirmed that exact implementation SHA. The temporary TODO CSV is complete and removed. This final record changes documentation only.
