# Contributing

Thanks for taking the time to improve ChatGPT Queue. This project is deliberately small and
fail-closed, and contributions are held to that standard: a change should be provable, not merely
plausible.

## Before you start

Open an issue first for anything that changes behavior, adds a permission, or touches the
fail-closed rules. The queue engine's safety properties are the product, so design discussions are
cheaper than review comments on a large diff.

## Set up

```bash
git clone https://github.com/senoldogann/chatgpt-queue.git
cd chatgpt-queue
npm ci
npm run build
```

The extension is plain TypeScript compiled with `esbuild`; there is no bundler framework to learn.
`dist/` is the loadable unpacked extension.

## Verify your change

Run the smallest relevant check while developing, then the full set before opening a pull request:

```bash
npm test            # unit and integration
npm run typecheck
npm run test:e2e    # real Chromium against a deterministic ChatGPT-like fixture
npm run verify      # typecheck + version contract + unit tests + all three builds
```

For UI or DOM-facing changes, add coverage at the level where the behavior actually lives:

- pure state and decision logic → `tests/` (Vitest)
- panel rendering and interactions → `tests/ui*.test.ts` against jsdom
- anything that depends on the real extension runtime, service worker, or page → `e2e/`

The browser E2E suite runs the extension in Chromium against `e2e/fixture-server.ts`. Add fixture
behavior there rather than mocking the DOM in a unit test when what you are proving involves the
extension lifecycle.

## What a good change looks like

- **Fail closed.** When the extension cannot prove that continuing is safe, it must block with a
  reason rather than guess. Never add an automatic retry for an ambiguous send.
- **No new permissions without discussion.** The production manifest currently asks only for
  `storage`, `notifications`, and host access to `https://chatgpt.com/*`, plus optional
  `nativeMessaging` that is requested only when the user enables the CLI bridge.
- **Stay inside the existing seams.** ChatGPT-specific selectors belong in
  `src/adapter/dom-chatgpt-adapter.ts`; queue state logic belongs in `src/domain/`; storage lives in
  `src/storage/`. If you find yourself reaching across those boundaries, say so in the pull request.
- **Keep the diff scoped.** Unrelated refactors make a safety review harder, not easier.
- **Explain the evidence.** A pull request should state what was verified locally, what CI
  verified, and what remains unverified.

## Tests and documentation

Behavior that a user can see should be documented in `README.md`, and any known limitation belongs
in **Known limitations** rather than in a comment that readers will not find. New user-visible
strings must be added to both catalogs in `src/ui/i18n.ts`; the types make a missing translation a
compile error on purpose.

## Commits and pull requests

- Branch from `main`, keep one concern per branch, and rebase rather than merge when updating.
- Write commit subjects in the imperative mood, for example
  `Bound the completion wait when no new turn can be proven`.
- Open the pull request against `main` and wait for the `verify` check to pass before merging.
- Releases are cut from `main` by a maintainer: notes go in `release-notes/<tag>.md` and the tag
  push publishes the GitHub Release. See **Versioning and releases** in `README.md`.

## Reporting bugs

Use the issue tracker. A useful report includes the panel's **Interface detail** output, the
conversation's query parameters if the DOM is involved, and whether the page had been open across an
extension reload. For anything security-sensitive, follow `SECURITY.md` instead of opening a public
issue.
