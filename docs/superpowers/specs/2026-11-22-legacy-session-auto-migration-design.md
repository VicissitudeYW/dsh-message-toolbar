# Legacy Session Automatic Migration

## Intent

Let conversations created with older display-only toolbar behavior continue in the current plugin without requiring users to find and manually open an earlier version. Opening an old conversation should materialize its visible legacy selections as a new native DSH session, with no model request and no change to the source session.

## Goals

- Automatically attempt migration once when an affected conversation is opened in the foreground. Hide-only question display preferences do not require a migration.
- Preserve selected old answers, prompt edits, hidden items, attachments, and later context in the new session.
- Preserve DSH replacement summaries when their source range remains unchanged after migration.
- When legacy selections alter or remove messages covered by a replacement summary, drop that stale summary from the new seed and retain the selected raw events instead.
- Use DSH's native composer block while checking and opening a legacy history so a follow-up cannot reach the source during handoff. A retry reuses a durable migrated session, including archived sessions, when the source has not advanced and the target still exists.

## Constraints

- Do not modify DSH or call a model during migration.
- Keep the source session immutable and create a normal DSH session through public session APIs.
- Unknown or malformed replacement operations remain a visible error unless the plugin can establish a correct event mapping.

## Approach

The source log retains the raw messages even when DSH replaces part of the model-visible history with a summary. Migration compares the exact ordered span before retaining and remapping the summary. If the messages in a span change, migration keeps the selected raw messages and drops the stale compaction transaction and any dependent summaries. Unaffected later conversations stay in the new session when an old turn was hidden or folded into an earlier question. The new log retains the native system and request headers that its messages and retry records need to reopen successfully.

Only turns still belonging to an explicit answer group are folded together. A standalone legacy replay remains where the old toolbar displayed it. Before publishing a navigation job, the host verifies that the source has not recorded a new turn, queue write, message projection, model, or preset change while the child was being prepared.

## Verification

Add regression tests for both stale and unaffected summaries, client-side automatic triggering, progress, visible failure, and manual retry. Run the full test suite, build, package dry run, and diff checks before publishing.
