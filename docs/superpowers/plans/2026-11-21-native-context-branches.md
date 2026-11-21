# Native Context Branches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make the plugin's selected/edited/deleted messages define durable native DSH model context without modifying DSH.

**Architecture:** Build isolated session seed copies and public native agents. Keep stable question/answer identities in version markers, expose context branch choices, and navigate the composer to the actual session. Source logs remain recovery versions.

**Tech Stack:** Existing dependency-free ESM host, React client, Node tests, optional installed DSH Electron integration runner.

**Spec:** `docs/superpowers/specs/2026-11-21-native-context-branches-design.md`

## Global Constraints

- Never modify DSH files, private APIs, personal sessions or automatically install a build.
- Preserve native tools, streaming, attachments, reasoning and all original session logs.
- Save does not generate; Send generates once. Answer edits overwrite one choice.
- Branch navigation commits before old branch archive; only plugin-owned branches are consolidated.
- No automatic file rollback; no paid model calls in verification.

## Review Focus

- Old same-session runs and display overrides must not leak discarded alternatives into future prompts.
- Repeated operations at an inherited earlier turn must retain the exact selected prefix and distinct logical question IDs.
- Interrupted/compacted/tool-heavy logs must not create invalid seeds or replay pending inbox entries.
- Rapid navigation and activation failure must never archive the visible source or unrelated native sessions.
- Seed edits must be explainable in markers and remain valid in cold persistence with unchanged source evidence.

### Task 1: Specify and verify seed operations

- [x] Write builder-reviewed spec and this plan; root CSV mirrors six tasks, one IN_PROGRESS.
- [x] Add pure seed builder regression tests for prefix, prompt edits, answer edits/deletes and tool pairing; watch fail.
- [x] Implement `lib/context-branches.js` with stable identity, copied seed and lifecycle closures.
- [x] Run `node --test test/context-branches.test.mjs`; Expected: all pass.

### Task 2: Connect durable host operations and identities

- [x] Add host harness branch creation/query, routing tests; observe failure.
- [x] Add branch regenerate/save/send/delete/select endpoints; normalize legacy selections before seed creation. Reject unsafe legacy mutation fallback.
- [x] Expose stable choices in GET tree; flush and preserve source on failures; correct family ownership.
- [x] Run host focused tests; Expected: context endpoints create new native sessions, old source receives no replay.

### Task 3: Connect client selection and navigation

- [x] Add client branch ring, editor/send and failure choreography tests; observe failure.
- [x] Navigate every consequential mutation to returned session, use real session choice menu, preserve previews, save/send separation and archive-after-mount.
- [x] Run client tests; Expected: all choices/edit/delete affect composer destination and errors remain visible.

### Task 4: Prove native model context and restart behavior

- [x] Create optional installed-runtime runner with scripted LLM/tool, temp profile/storage and real plugin route.
- [x] Assert exact request context for regenerate, both selections, editing, answer/question deletion, legacy migration and cold resume.
- [x] Run runner against rc.5; Expected: all pass with no real network/model/personal state changes.

### Task 5: Review and verify release

- [x] Update architecture/comparison/reliability docs and version/package metadata.
- [x] Run npm test, build, pack dry-run, diff checks; Expected: all pass.
- [x] Perform a fresh author self-review against all five Review Focus risks; no unresolved finding remained. Independent review could not run because model-service quota was exhausted.

### Task 6: Deliver GitHub revision

- [x] Commit focused changes; push authorized repository and verify remote SHA.
- [x] Fast-forward clean original checkout if delivery still applies; verify independently.
- [x] All CSV DONE then delete it, final Chinese report with verified limits and repository links.

## Execution record

`update_plan` is unavailable in this toolset (tool discovery returned unrelated APIs). The root TODO CSV and this persisted checklist carry identical task progress; no fictitious tool calls are recorded.

Delivery record: implementation commit `ad5b8366dd14242568a8b3faa18c1d0bb761571d` was pushed to `origin/codex/cherry-toolbar-interactions` and fast-forwarded into the original checkout's `main`. The final documentation-only delivery commit is pushed to both branches after this record is updated; remote SHAs are checked independently before reporting.
