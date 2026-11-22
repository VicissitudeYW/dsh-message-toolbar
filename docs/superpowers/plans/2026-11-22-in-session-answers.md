# In-session answers implementation plan

> **For agentic workers:** Use test-driven development and verification before completion.

**Goal:** Keep every toolbar answer version in the current DSH session and send the selected path to the model.

**Architecture:** Store the answer path in the existing durable toolbar state. Use DSH's public streaming waterfall and original agent for generation. Reuse the toolbar's answer selector, text overrides and visibility rules.

**Spec:** [同一会话内重答与切换](../specs/2026-11-22-in-session-answers-design.md)

## Global constraints

- No new DSH session or archive request for message toolbar actions.
- Preserve existing logs, user profile and existing native versions.
- Run the installed engine with fixture models and a temporary home.

## Review focus

- Match retry to its actual admitted prompt, including failure before admission.
- Restore each answer's continuation and exclude intervening physical turns.
- Keep edited and deleted content out of live requests and reused checkpoints.
- Preserve assistant tool calls with their results, including across restart.
- Interpret old display state on first open and through the model request hook.

- [x] Run a failing installed-engine test for stable session identity and selected request history.
- [x] Implement and test in-session state, request projection and host actions.
- [x] Connect the answer selector and outline, keep legacy version navigation explicit, and update both READMEs.
- [x] Run the regression suite, package check and isolated DSH runtime tests.

The DSH 0.2.2-rc.5 checks covered model selection, restoration of each answer's follow-ups, legacy state, compaction and cold reload. They also checked that editing or deleting a middle message preserves the surrounding messages in both the transcript and the next model request. The isolated web client kept the same sidebar session when regenerating and switching answers.
