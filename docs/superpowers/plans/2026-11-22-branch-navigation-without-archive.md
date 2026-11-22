# Branch navigation without automatic archival

**Goal:** Preserve native continuation while removing automatic writes to the DSH archive.

**Spec:** [Branch navigation without automatic archival](../specs/2026-11-22-branch-navigation-without-archive-design.md)

- [x] Exercise the host routes in `test/host-regressions.test.mjs` with an existing archive entry. Complete real branch changes and answer selection, reject stale or cancelled focus requests, resume an old job, and exercise child creation failure. Check archive membership and the version tree.
- [x] Exercise reopening an archived migration copy in `test/context-client.test.mjs`. Require explicit selection before the client activates it.
- [x] Make `focusVersion` and `cancelFocus` operate on navigation state in `lib/index.js`. Keep `activate` for opening an explicitly selected archived session. In `plugin.client.js`, offer that action when automatic migration finds an archived target. Rebuild `lib/client.js`.
- [x] Verify `npm test` and the native context integration against the installed DSH version in a temporary profile. Update the usage FAQ and architecture notes, and check the package.

Publish the patch version to GitHub and sync the original project and the Desktop plugin through `npm run sync -- desktop`.
