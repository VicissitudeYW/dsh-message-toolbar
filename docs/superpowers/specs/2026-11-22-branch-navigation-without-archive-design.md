# Branch navigation without automatic archival

Regenerating, answering with another model, editing, removing messages or version cards, selecting an answer, and migrating old display changes must leave DSH's archive alone. Continue on the native session that holds the selected context.

Keep the seeded native sessions and the existing token checked handoff. Preparing, completing, cancelling or resuming a handoff records plugin state only. Release the failed child agent through the existing cleanup path and keep its session log available for recovery. Deleting a version card removes it from the toolbar's choices, and restoring the card restores that choice.

Keep existing archived sessions available. Opening a chosen archived version can use DSH's public unarchive action for that specific version. If automatic migration finds an archived copy, let the reader choose whether to reopen it. Retain the durable copy and its conversation history. Accept older pending navigation records without acting on their recorded archive flags.

After answer deletion, choose another available answer or stay on the new deletion branch. After deleting the open version card, prefer its parent or another available version. If all replacements are archived or deleted, ask the reader to open another version before removing the current card.

DSH 0.2.2-rc.5 exposes sidebar decorations and actions, with no public filter for individual sessions. Keep the native sidebar and allow each native branch to appear there. Single entry grouping would require upstream support or a replacement sidebar. Hiding rows through renderer internals would leave inconsistent search and pagination behavior.
