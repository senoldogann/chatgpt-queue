# Project Workflow Rules

These rules apply to the entire repository.

## Local-first development

- Implement code changes, tests, builds, and verification locally first.
- Do not open or merge a pull request until the relevant local checks pass.
- Use the existing project architecture, scripts, helpers, and naming conventions before adding new abstractions or dependencies.
- Keep changes scoped to the requested work and preserve unrelated user or agent changes.

## Pull requests and merging

- When local implementation and verification are complete, push the dedicated branch and open a pull request against `main`.
- Merge only after the required GitHub CI checks pass and there are no unresolved blockers.
- Do not treat a successful tool invocation or partial test run as proof that the task is complete.

## Branch and worktree cleanup

- After a pull request is merged, remove the completed local worktree if one was created.
- Delete completed local branches after confirming their work is present in `main`.
- Delete completed remote branches after merge unless there is an explicit reason to retain them.
- Never delete a dirty worktree, an unmerged branch with unique work, or unrelated user/agent changes merely for cleanup.

## Repository hygiene

- Keep the repository free of obsolete worktrees, stale generated artifacts, accidental temporary files, and unrelated untracked files.
- Before finishing a task, verify `git status`, the active branch/commit, and synchronization with `origin/main`.
- Keep generated build outputs current when the project intentionally tracks or consumes them locally, but do not commit ignored/generated files unless the repository already requires that.
- Prefer small, reviewable commits and avoid unrelated refactors.

## Verification

- Run the smallest relevant checks while developing, then the repository's appropriate full verification before opening the pull request.
- For release/hardening work, run the relevant unit/integration tests, typecheck, production builds, and end-to-end tests where applicable.
- If a test fails because of environment or test-runner interference, isolate the cause and rerun under clean conditions before classifying it as non-product failure.
- Report separately what was changed, what was locally verified, what CI verified, and what remains unverified.
