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

## FlowRun v0.3 unattended CLI bridge

FlowRun is a local-first deterministic workflow runtime built on top of the same fail-closed ChatGPT Queue engine. v0.3 adds **durable CLI submission**: after the extension accepts a job, the CLI is no longer the workflow controller. You can close the terminal or use `--detach`; the extension continues the workflow locally as long as **Chrome remains open, the target ChatGPT tab remains available, and the computer stays awake**.

The runtime still supports direct extension execution through **Workflow → Load workflow**. A workflow can chain completed assistant output into later prompts:

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

The project does not read browser cookies or credentials, call the OpenAI API, send telemetry, or contact an external backend.

## Known limitations

- ChatGPT is a web application whose DOM can change. All ChatGPT-specific selectors and heuristics are isolated in `src/adapter/dom-chatgpt-adapter.ts`; an unrecognized structure blocks the queue rather than guessing.
- The extension can observe only UI state exposed by the current ChatGPT page. It cannot prove server-side delivery after an ambiguous click, which is why unresolved sends are never retried automatically.
- A queue is tied to the ChatGPT conversation identity derived from the current URL. Temporary new-chat state is migrated once a real `/c/<conversation-id>` URL appears.
- Browser notifications depend on the browser/OS notification environment.

## Project structure

- `src/domain/` — pure queue and runtime state logic.
- `src/storage/` — versioned `chrome.storage.local` repository.
- `src/coordinator/` — durable mutations, ownership leases, dispatch reservation, recovery.
- `src/adapter/` — ChatGPT DOM boundary.
- `src/runtime/` — extension RPC/client/runner and conversation identity.
- `src/ui/` — Shadow DOM queue panel.
- `src/flowrun/` — FlowRun schema, templates, receipts, assertions, deterministic engine, bounded run storage, and queue-backed browser runtime.
- `src/cli/` — FlowRun CLI commands and local mailbox client.
- `src/bridge/` — Native Messaging protocol, installer, mailbox, target registry, and unattended job handoff.
- `examples/` — FlowRun workflow examples.
- `e2e/` — deterministic Chromium extension tests.
- `scripts/build.mjs` — production build.
- `scripts/build-cli.mjs` — Node CLI build.
- `scripts/build-native-host.mjs` — local Native Messaging host build.
- `scripts/build-e2e.mjs` — test-only extension build.

## Verification

The main local verification sequence is:

```bash
npm test
npm run typecheck
npm run build
npm run build:cli
npm run build:native-host
npm run test:e2e
```
