# ChatGPT Queue v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Manifest V3 Chrome/Edge extension that safely queues follow-up messages per ChatGPT conversation with fail-closed multi-tab coordination.

**Architecture:** A service-worker coordinator is the only durable-state mutation boundary. Content scripts observe ChatGPT through a dedicated DOM adapter, reserve sends durably before touching the page, and advance only after multi-signal stable completion.

**Tech Stack:** TypeScript, Manifest V3, Chrome Extension APIs, chrome.storage.local, MutationObserver, Vitest, jsdom, Playwright, esbuild.

**Spec:** Approved user specification from 2026-09-11, mirrored by this plan and README requirements.

## Global Constraints

- Production host scope: `https://chatgpt.com/*` only.
- No backend, API billing, telemetry, cookie extraction, or external message storage.
- Queue size: 1–50 items.
- No elapsed-time based generation completion; only DOM state plus short quiescence stability.
- Any ambiguity blocks the queue rather than guessing or retrying.
- `chrome.storage.local` is authoritative; worker memory is never authoritative.
- Same conversation has one active tab owner; different conversations are independent.

---

### Task 1: Domain queue engine and state machine

**Files:** Create `src/domain/types.ts`, `src/domain/queue-engine.ts`, `src/domain/state-machine.ts`; test in `tests/queue-engine.test.ts` and `tests/state-machine.test.ts`.

- [ ] Write tests for item selection, pause/resume, edit/delete/reorder, empty completion, state transitions and fail-closed blocking.
- [ ] Run the focused tests and verify RED because modules do not exist.
- [ ] Implement the smallest pure functions and types required by the tests.
- [ ] Run focused tests and verify GREEN.

### Task 2: Persistence, leases, idempotent dispatch

**Files:** Create `src/storage/*`, `src/coordinator/*`; test in `tests/storage.test.ts`, `tests/coordinator.test.ts`, `tests/lease.test.ts`.

- [ ] Write tests for schema round-trip, restart recovery, temporary-key migration, owner exclusivity, stale-owner recovery, duplicate completion, and uncertain-send recovery.
- [ ] Run tests and verify RED.
- [ ] Implement a versioned storage repository and serialized coordinator mutations.
- [ ] Persist `sending` plus dispatch token before page send; on recovery, block unresolved `sending` items instead of resending.
- [ ] Run focused tests and verify GREEN.

### Task 3: ChatGPT DOM adapter

**Files:** Create `src/adapter/chatgpt-adapter.ts`, `src/adapter/dom-chatgpt-adapter.ts`; test in `tests/dom-adapter.test.ts`.

- [ ] Write jsdom fixture tests for stop/send/composer, blocking error, confirmation UI, assistant-count change, and completion confidence.
- [ ] Run tests and verify RED.
- [ ] Implement all selectors/heuristics inside the adapter boundary.
- [ ] Run focused tests and verify GREEN.

### Task 4: Extension runtime and queue UI

**Files:** Create `src/background.ts`, `src/content.ts`, `src/ui/*`, `manifest.json`, `scripts/build.mjs`.

- [ ] Write integration tests for RPC/coordinator decisions and content-runner decision logic before implementation.
- [ ] Implement background message handling and injected vanilla DOM UI.
- [ ] Drive the runner from MutationObserver/URL changes; use a short debounce only to establish DOM quiescence, never as a run timeout.
- [ ] Implement completion/block notifications.
- [ ] Build and typecheck.

### Task 5: Browser E2E and multi-tab validation

**Files:** Create `e2e/*`, `playwright.config.ts`, and a test-only build manifest.

- [ ] Load the built extension in Chromium against a local ChatGPT-like fixture.
- [ ] Verify two queued messages send in order only after simulated completion.
- [ ] Verify two tabs on one conversation do not both send; two conversations remain independent.
- [ ] Verify refresh/reload does not duplicate an uncertain item and fail-closed state is visible.

### Task 6: Documentation, final verification, GitHub

**Files:** Create `README.md`, `.gitignore`; inspect all diffs.

- [ ] Run `npm run typecheck`, `npm test`, `npm run build`, and `npm run test:e2e`.
- [ ] Perform read-safe inspection on an open real ChatGPT tab if accessible; do not send a real message unless required and explicitly minimal.
- [ ] Review diff and Git status; remove unrelated/generated noise.
- [ ] Commit with a clear message, create `senoldogann/chatgpt-queue` if possible, set origin, and push the verified branch.
