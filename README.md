# ChatGPT Queue

ChatGPT Queue is a free Chrome/Edge Manifest V3 extension for `chatgpt.com` that lets you queue 1–50 follow-up messages for a conversation. It does not use the OpenAI API, a backend, external telemetry, or external message storage.

The extension advances the queue by observing the real ChatGPT page state. It does **not** use elapsed generation time to guess when a response is finished.

## Features

- Per-conversation follow-up queues with up to 50 items.
- Add, edit, delete, and reorder queued items.
- Start, pause, and resume queue execution.
- Durable `chrome.storage.local` state.
- Durable `queued -> sending` reservation with a unique dispatch token before touching the page.
- Generation must be observed before an item becomes `running`.
- Fail-closed handling for ambiguous sends, ChatGPT errors, confirmation/tool-approval UI, unrecognized DOM, and ownership conflicts.
- Recovery blocks unresolved `sending` items as `uncertain-send` instead of automatically resending them.
- Conversation-level owner leases prevent two tabs from driving the same conversation at the same time.
- Different conversations can run independently in different tabs.
- Temporary new-chat queue keys migrate to the real conversation ID after ChatGPT assigns one.
- Local completion/blocked notifications.
- CSS-only running activity indicator in both expanded and collapsed Queue UI.
- Non-mutating adapter interface health, with on-demand diagnostics, so ChatGPT DOM drift is visible before it blocks a queue.
- A local context-pressure estimate driven by a runtime-resolved capacity instead of a hardcoded model limit.
- **Compact & continue**: ask the current conversation for a validated handoff brief, then open a fresh chat seeded with that brief and the follow-ups you had queued.
- **English and Turkish panel UI**, switchable at any time from the panel header (`Auto`, `EN`, `TR`); `Auto` follows the browser language.
- **Built-in usage guide**: a step-by-step walkthrough that highlights the real control each step describes, with visible progress, directly in the panel.

## Requirements

- Node.js with npm.
- Chrome or Edge for normal use.
- Playwright bundled Chromium for deterministic extension E2E tests.

## Install dependencies

```bash
npm ci
```

For browser E2E on a new machine, install Playwright's bundled Chromium once:

```bash
npx playwright install chromium
```

## Build

```bash
npm run build
```

The production extension is written to `dist/`.

## FlowRun unattended CLI bridge (FlowRun schema v0.3)

FlowRun is a local-first deterministic workflow runtime built on top of the same fail-closed ChatGPT Queue engine. FlowRun schema v0.3 adds **durable CLI submission**: after the extension accepts a job, the CLI is no longer the workflow controller. You can close the terminal or use `--detach`; the extension continues the workflow locally as long as **Chrome remains open, the target ChatGPT tab remains available, and the computer stays awake**.

The runtime also supports direct extension execution from the **Workflow** section. You can choose one of the built-in professional workflows or load your own `.flowrun.json` file. Built-in workflows use the same versioned FlowRun schema, local execution path, assertions, and fail-closed behavior as custom workflows; selecting one does not add network access or call an API.

Built-in workflows:

- **Production Readiness** — architecture, correctness, verification evidence, and release-decision review.
- **Code Review** — reconstructs intent, identifies concrete defects, designs regression coverage, and produces a severity-ordered review.
- **Root Cause Debugging** — separates facts from assumptions, ranks hypotheses, traces the causal chain, and proposes the smallest regression-tested fix.
- **Release Gate** — defines the release contract, ranks credible risk, audits evidence, and returns `GO`, `GO WITH CONDITIONS`, or `NO-GO`.
- **Implementation Plan** — converts requirements into a bounded contract, minimal architecture, incremental tasks, and explicit completion gates.
- **Open Code Review** — a precision-first review adapted from Alibaba's [Open Code Review](https://github.com/alibaba/open-code-review) (Apache-2.0): deterministic scope selection, rule-matched defect detection, an independent positioning pass, and a reflection pass that drops unproven findings. It is a prompt workflow derived from that published methodology; the `ocr` binary is not bundled and no external service is contacted.

Each preset contains chained ChatGPT steps and requires non-empty output at every stage. Presets are copied before use, so a selected workflow cannot mutate the built-in catalog. **Load custom workflow** remains available for developer-authored files.

A workflow can chain completed assistant output into later prompts:

```json
{
  "version": 1,
  "name": "review-pr",
  "inputs": {
    "diff": { "type": "string", "required": true }
  },
  "steps": [
    {
      "id": "review",
      "type": "chat",
      "provider": "chatgpt",
      "prompt": "Review this change:\n{{ inputs.diff }}"
    },
    {
      "id": "tests",
      "type": "chat",
      "provider": "chatgpt",
      "prompt": "Using this review:\n{{ steps.review.output }}\n\nWrite regression tests."
    }
  ]
}
```

### Build the developer tools

```bash
npm run build:cli
npm run build:native-host
```

### Install the local CLI bridge (macOS + Chrome developer install)

1. Build the production extension and load `dist/` unpacked in Chrome.
2. Copy the extension ID shown on `chrome://extensions`.
3. Build the CLI and native host.
4. Install the host manifest for that exact extension ID:

```bash
./dist-cli/flowrun.js bridge install --extension-id <chrome-extension-id>
./dist-cli/flowrun.js bridge doctor
```

The installer creates a user-local bridge under `~/.flowrun/bridge/` and a Chrome Native Messaging manifest under your user Chrome profile support directory. It does **not** start a daemon or open a localhost port. The host accepts only the configured extension origin.

In the Queue panel, click **Enable** next to **CLI bridge**. This explicitly grants Chrome's optional `nativeMessaging` permission. Normal Queue use does not require that permission.

### Run unattended workflows

List currently registered ChatGPT conversations:

```bash
./dist-cli/flowrun.js targets
```

Submit a workflow:

```bash
./dist-cli/flowrun.js run examples/review-pr.flowrun.json \
  --input 'diff=example change' \
  --detach
```

If exactly one eligible ChatGPT target is available it is selected automatically. If several are available, FlowRun fails closed and requires `--target <target-id>`. Busy targets are never selected automatically.

After the CLI prints `Accepted: <job-id>`, execution belongs to the extension. The terminal can exit without cancelling or duplicating the run. Inspect it later with:

```bash
./dist-cli/flowrun.js status <job-id>
```

This unattended boundary is intentionally narrow: **Chrome must remain running and the Mac must remain awake**. v0.3 does not wake a sleeping computer, auto-launch Chrome after shutdown, remotely monitor the run, or automatically retry ambiguous ChatGPT sends. A browser/tab reload during an active workflow remains fail-closed as `browser-session-interrupted`.

The bridge uses an atomic local mailbox plus Chrome Native Messaging. Requests are versioned, capped at 1 MiB, expire after 10 minutes if not accepted, and use idempotent job IDs. The extension stores at most 50 bridge jobs, FlowRun stores the 20 most recent runs, and the local completed mailbox history is count-bounded. No workflow can execute shell commands through the bridge.

### Runtime behavior

FlowRun sends exactly one step at a time through the existing QueueCoordinator → QueueRunner → ChatGPT DOM adapter path. Completed assistant text is captured locally and can be referenced as `{{ steps.<id>.output }}`. A normal Queue that is already active prevents a FlowRun workflow from starting.

ChatGPT's `Message delivery timed out. Please try again.` state is classified as `message-delivery-timeout` and remains fail-closed without automatic retry. Reload/restart ambiguity, confirmation UI, network errors, and uncertain sends remain fail-closed as well.

The Queue panel shows a CSS-only activity spinner while Queue or FlowRun execution is running, including on the collapsed right-edge tab. The spinner stops for Idle, Paused, Blocked, Completed, and Failed states and honors `prefers-reduced-motion`.

See `docs/superpowers/specs/2026-09-12-flowrun-v0.3-unattended-cli-bridge-design.md` for the bridge architecture.

## Context and handoff

The Queue panel shows a **Context** section next to the adapter interface state. It answers one question — how close is this conversation to running out of room? — without calling an API or reading anything the page does not already display.

**The capacity is resolved at runtime, never assumed.** `src/context/capacity.ts` resolves it in this order and labels which source won:

1. a capacity the host page declares about itself (`data-context-window-tokens`) — `Reported by the page`,
2. the value you type into **Capacity override (tokens)** — `Configured by you`,
3. a deliberately conservative fallback — `Conservative fallback`.

Only the third source is a constant, and it is always shown as such. Nothing in the pressure maths compares against a fixed model limit: the levels (`watch`, `compact`, `critical`) are fractions of whatever capacity was resolved, so a larger window moves the thresholds automatically.

**The reading is an estimate and says so.** Used tokens are approximated from the visible conversation text, so the panel prints `~N% of <capacity> tokens (est. … over N turns, <source>)`. Treat it as a trend indicator, not a measurement; if you know your real window, set the override and the percentage becomes exact relative to that number.

**Compact & continue** recovers a conversation that is close to its limit. Pressing it:

1. enqueues one deterministic handoff prompt at the front of the queue and starts it,
2. reads the reply back out of the page and validates it — it must contain the five required labels (`STATE`, `DECISIONS`, `OPEN QUESTIONS`, `NEXT STEPS`, `CONSTRAINTS`) with content and in order,
3. stores the validated brief locally and **pauses** the source queue, so the follow-ups still queued are not spent on a conversation that is out of headroom,
4. opens a fresh ChatGPT conversation, which imports the brief plus those queued follow-ups on load.

Fail-closed throughout: an unrecognized or incomplete brief never becomes a handoff, and the source queue is only paused after a validated brief exists. If validation fails, nothing about your queue changes. The new chat is opened through the extension background script, which only ever opens the same origin it was called from, and only that created tab may claim the import.

See `docs/superpowers/specs/2026-09-13-context-handoff-compaction-design.md` for the capacity-resolution rules and the handoff protocol.

## Tests

Run unit/integration tests:

```bash
npm test
```

Run TypeScript checking:

```bash
npm run typecheck
```

Run the real-browser extension E2E suite:

```bash
npm run test:e2e
```

The E2E build uses a separate `dist-e2e/` manifest that is scoped to a local deterministic ChatGPT-like fixture. The production manifest is not modified and never receives localhost permissions.

## Load unpacked in Chrome

1. Run `npm run build`.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select this project's `dist/` directory.
6. Open `https://chatgpt.com/` and use the injected **Queue** panel.

Edge uses the equivalent extension-management page and unpacked-extension flow.

## Usage

New to the panel? Press the **?** button in the panel header. The usage guide walks through every control one step at a time, highlights the control each step is talking about, and shows progress as you advance. It is non-destructive: it only scrolls and highlights, and the panel keeps working while it is open.

1. Open a ChatGPT conversation.
2. Add one or more follow-up messages in the Queue panel.
3. Reorder or edit queued items if needed.
4. Press **Start**.
5. The extension reserves exactly one item in local storage before placing it in the ChatGPT composer and clicking Send.
6. The next item is not sent until generation has been observed, an assistant response has appeared, the composer/send state is ready again, and the DOM has reached a short quiescent period.
7. Use **Pause** to stop queue advancement. **Resume** continues from the preserved observation phase.

## Fail-closed behavior

Safety takes precedence over automatic progress. If the extension cannot prove that continuing is safe, it blocks the queue instead of guessing or retrying.

Examples include:

- Network/connection errors.
- Rate limits.
- Expired session/login UI.
- ChatGPT error or **Try again** UI.
- Message delivery timeout (`message-delivery-timeout`).
- Confirmation/tool approval dialogs.
- Unrecognized ChatGPT DOM.
- Conversation ownership conflicts.
- A send click whose result cannot be confirmed.
- Recovery after a reload/restart while an item is still in `sending`.
- `completion-not-observed`: the page went idle after an observed response but no completed assistant turn could ever be proven, so the queue blocks after a bounded wait instead of pretending it can still finish the item.

An unresolved persisted `sending` item is intentionally recovered as `blocked: uncertain-send`. Automatic resend is forbidden because the original click may already have reached ChatGPT.

## Multi-tab behavior

`tabId` and `conversationId` are separate concepts.

Each conversation has one owner lease. If the same conversation is open in two tabs, only the owner tab may drive queue execution. A second tab shows an ownership notice and does not dispatch messages. An expired lease can be taken over safely by another tab.

Two different conversations use different queue records and can be driven independently.

## Storage and privacy

Queue state, message contents, and bounded FlowRun run history are stored only in `chrome.storage.local` for this extension.

The production manifest requests:

- `storage` — durable local queue state.
- `notifications` — local completion/blocked notifications.
- Host access only to `https://chatgpt.com/*`.
- Optional `nativeMessaging` — requested only when the user explicitly enables the FlowRun CLI bridge.

The compact-and-continue handoff record (the validated brief plus the follow-up contents it carries) is stored in the same local `chrome.storage.local` area, bounded to one pending handoff, and the id of the new chat tab it opened is kept briefly in `chrome.storage.session` (10-minute expiry). No new permissions are required for either: opening a tab needs no permission, and `storage` already covers `storage.session`.

The project does not read browser cookies or credentials, call the OpenAI API, send telemetry, or contact an external backend.

## Known limitations

- ChatGPT is a web application whose DOM can change. All ChatGPT-specific selectors and heuristics are isolated in `src/adapter/dom-chatgpt-adapter.ts`; an unrecognized structure blocks the queue rather than guessing.
- The extension can observe only UI state exposed by the current ChatGPT page. It cannot prove server-side delivery after an ambiguous click, which is why unresolved sends are never retried automatically.
- A queue is tied to the ChatGPT conversation identity derived from the current URL. Temporary new-chat state is migrated once a real `/c/<conversation-id>` URL appears.
- Reloading or updating the extension orphans the content scripts already running in open ChatGPT tabs. Such a page can neither read nor write its queue until it is reloaded, so the panel detects that state and reports **Disconnected** with a reload hint instead of continuing to show the queue as running. The persisted queue is untouched and resumes when the page is reloaded.
- A queue whose owner lease lapses while work is in flight (a tab that crashed, was frozen, or was discarded) is reported as stalled by any tab that opens it. Recovery is explicit: reloading the page takes the lease and re-evaluates from the page's real state.
- When the page goes idle after an observed response but no completed assistant turn can be proven, the queue blocks with `completion-not-observed` instead of waiting forever. The bound is measured from the moment the page became idle, so a long answer is never cut short by a long generation.
- Browser notifications depend on the browser/OS notification environment.
- The context percentage is a character-based estimate, not token accounting; ChatGPT Web exposes no usage counter. The adapter interface check reports only what the current page structure proves, and it does not verify the model or plan.

## Project structure

- `src/domain/` — pure queue and runtime state logic.
- `src/storage/` — versioned `chrome.storage.local` repository.
- `src/coordinator/` — durable mutations, ownership leases, dispatch reservation, recovery.
- `src/adapter/` — ChatGPT DOM boundary.
- `src/runtime/` — extension RPC/client/runner and conversation identity.
- `src/ui/` — Shadow DOM queue panel, the EN/TR message catalog, the in-panel usage guide steps, and durable UI preferences.
- `src/context/` — runtime-resolved context capacity, the local pressure estimate, and the compaction handoff (brief prompt, validation, seed, bounded storage).
- `src/flowrun/` — FlowRun schema, templates, receipts, assertions, deterministic engine, bounded run storage, and queue-backed browser runtime.
- `src/cli/` — FlowRun CLI commands and local mailbox client.
- `src/bridge/` — Native Messaging protocol, installer, mailbox, target registry, and unattended job handoff.
- `examples/` — FlowRun workflow examples.
- `e2e/` — deterministic Chromium extension tests.
- `scripts/build.mjs` — production build.
- `scripts/build-cli.mjs` — Node CLI build.
- `scripts/build-native-host.mjs` — local Native Messaging host build.
- `scripts/build-e2e.mjs` — test-only extension build.
- `scripts/check-version.mjs` — release version contract check.
- `scripts/package-release.mjs` — release asset packaging (zip plus checksum).
- `release-notes/` — reviewed release notes, one file per release tag.

## Verification

The main local verification sequence is:

```bash
npm test
npm run typecheck
npm run check:version
npm run build
npm run build:cli
npm run build:native-host
npm run test:e2e
```

`npm run verify` runs the typecheck, version check, unit/integration tests, and the three builds. The browser E2E suite is separate because it needs Playwright's Chromium.

## Versioning and releases

`package.json` and `manifest.json` always carry the same extension version, and that contract is enforced rather than assumed: `npm run check:version` fails when the two disagree, when a version is not a valid Chrome extension version, or when a release tag targets a different version. It runs on every CI build and again against the tag before anything is packaged.

A Chrome Manifest V3 version can only contain 1–4 dot-separated integers, so a release candidate keeps the base extension version and the candidate number lives only in the tag:

| release tag | packaged extension version |
| --- | --- |
| `v0.1.0` | `0.1.0` |
| `v0.1.0-rc.3` | `0.1.0` |

`FlowRun v0.1`–`v0.3` labels used in this README and in `docs/superpowers/` describe FlowRun workflow-runtime generations, not the extension release version.

Cut a release:

1. Bump `version` in `package.json` and `manifest.json` together when the base version changes.
2. Copy `release-notes/TEMPLATE.md` to `release-notes/<tag>.md` and fill in every section.
3. Merge that change to `main`, then push the tag: `git tag v0.1.0-rc.4 && git push origin v0.1.0-rc.4`.
4. The Release workflow verifies the tagged commit (unit/integration tests, typecheck, production/CLI/native-host builds, browser E2E), confirms the tag is an ancestor of `main`, requires the release notes file, packages the extension from that same verified build, and publishes the GitHub Release with `chatgpt-queue-<tag>.zip` and `chatgpt-queue-<tag>.zip.sha256`. Tags containing a suffix such as `-rc.4` are published as pre-releases.

To rehearse without publishing, run the **Release** workflow from the Actions tab with `dry_run` left enabled; the packaged assets then stay workflow artifacts.

The same packaging step is available locally:

```bash
npm run build
npm run package:release -- --tag v0.1.0-rc.4
```

The packaging script is deterministic: it stages the built `dist/` files with a fixed timestamp, refuses to package a build whose manifest references a file that is not present, and writes the archive plus `<archive>.sha256` into the git-ignored `release/` directory.

