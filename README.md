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

Queue state and message contents are stored only in `chrome.storage.local` for this extension.

The production manifest requests:

- `storage` — durable local queue state.
- `notifications` — local completion/blocked notifications.
- Host access only to `https://chatgpt.com/*`.

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
- `e2e/` — deterministic Chromium extension tests.
- `scripts/build.mjs` — production build.
- `scripts/build-e2e.mjs` — test-only extension build.

## Verification

The main local verification sequence is:

```bash
npm test
npm run typecheck
npm run build
npm run test:e2e
```
