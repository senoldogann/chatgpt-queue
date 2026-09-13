# Queue Command Center UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the ChatGPT Queue panel into a tabbed command center with aggregate queue collapsing, collapsed-row deletion, and a live total-active-time indicator.

**Architecture:** Keep queue/runtime domain semantics unchanged and implement the redesign inside `QueuePanel` as presentation state. Add a small pure duration helper for deterministic calculation/formatting, update only the timer DOM node once per second, and preserve drafts/tab/collapse state across re-renders for the same conversation.

**Tech Stack:** TypeScript, Shadow DOM, Vitest/jsdom, Playwright extension E2E, existing EN/TR i18n catalogs.

**Spec:** `docs/superpowers/specs/2026-09-14-queue-command-center-ui-design.md`

## Global Constraints

- Work only in `/Users/dogan/Desktop/chatgpt-queue` on `feat/context-workflow-queue-ux`.
- Do not change stored queue schema or runtime/domain semantics for UI-only state.
- Preserve existing fail-closed behavior and existing `actions.remove(itemId)` deletion path.
- Preserve unsaved queue/workflow/composer drafts and focus across same-conversation renders.
- New user-facing strings and accessibility text must be complete in English and Turkish.
- Full local verification must pass before commit/push/PR.

---

### Task 1: Active-duration calculation and live header timer

**Files:**
- Modify: `src/ui/queue-panel.ts`
- Modify: `src/ui/i18n.ts`
- Test: `tests/ui.test.ts`
- Test: `tests/ui-i18n.test.ts`

**Interfaces:**
- Consumes: `QueueItem.startedAt?: number`, `QueueItem.completedAt?: number`, current wall-clock milliseconds.
- Produces: pure `totalActiveDurationMs(queue, now)` and `formatActiveDuration(ms)` helpers plus a `[data-role="active-duration"]` DOM node updated by a single panel-owned interval.

- [ ] **Step 1: Write failing duration/UI/i18n tests**

Add deterministic tests equivalent to:

```ts
expect(totalActiveDurationMs(queueWithCompletedAndRunningItems, 20_000)).toBe(12_000);
expect(formatActiveDuration(3_723_000)).toBe('01:02:03');
expect(root.querySelector('[data-role="active-duration"]')?.textContent).toContain('00:00:12');
expect(translate('tr', 'timer.active')).toBe('Aktif süre');
```

Use fake timers to prove the timer text changes after one second without calling `panel.render()` again.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/ui.test.ts tests/ui-i18n.test.ts`
Expected: FAIL because timer helpers/labels/node do not exist yet.

- [ ] **Step 3: Implement minimal duration helper and timer lifecycle**

Implement pure duration math that sums only valid non-negative active intervals. For an active item with `startedAt` and no `completedAt`, use `now`. Render the formatted value in the persistent header. Start at most one one-second interval per `QueuePanel` instance and update only the timer text node; safely reset it when needed.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/ui.test.ts tests/ui-i18n.test.ts`
Expected: PASS.

---

### Task 2: Queue aggregate collapse and collapsed-row actions

**Files:**
- Modify: `src/ui/queue-panel.ts`
- Modify: `src/ui/i18n.ts`
- Test: `tests/ui.test.ts`
- Test: `tests/ui-i18n.test.ts`

**Interfaces:**
- Consumes: existing `collapsedQueueItemIds`, `actions.remove(itemId)`, queued textarea drafts.
- Produces: one aggregate Collapse/Expand toolbar action; collapsed rows with queue position, Expand, and icon Delete actions.

- [ ] **Step 1: Extend failing collapse/delete tests**

Assert that one aggregate Collapse click collapses all queued rows, toggles its accessible label to Expand, and each collapsed row contains both:

```ts
row.querySelector('[data-action="toggle-item"]');
row.querySelector('[data-action="delete"]');
```

Click the collapsed delete control and assert `remove` receives that item ID. Assert unsaved draft text survives collapse then expand and is used for the collapsed preview.

- [ ] **Step 2: Run focused test and confirm failure**

Run: `npx vitest run tests/ui.test.ts tests/ui-i18n.test.ts`
Expected: FAIL because the current collapsed row does not expose delete next to Expand and aggregate semantics/copy do not match the approved design.

- [ ] **Step 3: Implement collapsed-row command layout**

Keep the existing collapse set as presentation-only state. Make the aggregate toolbar button the primary collapse affordance. Render queue position and compact preview in collapsed rows, with Expand and an icon-sized Delete button adjacent. Keep edit/reorder/save actions in expanded state.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/ui.test.ts tests/ui-i18n.test.ts`
Expected: PASS.

---

### Task 3: Queue / Workflow / System tab architecture

**Files:**
- Modify: `src/ui/queue-panel.ts`
- Modify: `src/ui/i18n.ts`
- Test: `tests/ui.test.ts`
- Test: `tests/ui-i18n.test.ts`

**Interfaces:**
- Consumes: existing queue composer/list, workflow section, context section, bridge control.
- Produces: panel-local `activeTab: 'queue' | 'workflow' | 'system'` and semantic tab controls/panels.

- [ ] **Step 1: Add failing tab behavior and accessibility tests**

Assert the tablist contains Queue, Workflow, and System; Queue starts selected; switching tabs updates `aria-selected` and panel visibility. Type drafts before switching and assert they remain after switching back. Render Turkish and assert `Sıra`, `İş Akışı`, and `Sistem`.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `npx vitest run tests/ui.test.ts tests/ui-i18n.test.ts`
Expected: FAIL because tabs do not exist.

- [ ] **Step 3: Implement presentation-only tabs**

Move Queue, Workflow, and System content into semantic `role="tabpanel"` containers. Add a `role="tablist"`; switch panels without mutating queue state. Preserve active tab for same conversation and default to Queue for a new conversation. Ensure stale mode still removes unavailable actions safely.

- [ ] **Step 4: Run focused tests**

Run: `npx vitest run tests/ui.test.ts tests/ui-i18n.test.ts`
Expected: PASS.

---

### Task 4: Visual hierarchy and responsive polish

**Files:**
- Modify: `src/ui/queue-panel.ts`
- Test: `tests/ui.test.ts`

**Interfaces:**
- Consumes: existing Shadow DOM CSS and semantic DOM from Tasks 1–3.
- Produces: local CSS tokens, compact header chips, active-tab styles, improved queue-card hierarchy, responsive tab behavior, and reduced-motion-safe transitions.

- [ ] **Step 1: Add structural assertions for durable styling hooks**

Assert the panel exposes stable classes/data roles for the tab bar, header metrics, queued position, collapsed actions, and running-item styling. Avoid tests for exact pixel values.

- [ ] **Step 2: Run focused UI test and confirm failure for new hooks**

Run: `npx vitest run tests/ui.test.ts`
Expected: FAIL until the new structural hooks exist.

- [ ] **Step 3: Implement CSS hierarchy**

Introduce local CSS custom properties for surface, border, muted text, radii, and spacing. Reduce redundant borders, style the active tab as the strongest navigation state, keep destructive actions visually distinct, and make narrow layouts wrap cleanly. Keep `prefers-reduced-motion` support.

- [ ] **Step 4: Run focused UI test**

Run: `npx vitest run tests/ui.test.ts`
Expected: PASS.

---

### Task 5: Browser coverage, documentation, and full verification

**Files:**
- Modify: `e2e/extension.spec.ts`
- Modify if navigation requires it: `e2e/flowrun.spec.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: final DOM/actions from Tasks 1–4.
- Produces: browser-level regression coverage and user-facing documentation.

- [ ] **Step 1: Update browser tests**

Extend the existing collapse E2E to prove one aggregate click collapses all rows, a collapsed row exposes Expand and Delete, and expanding restores the draft. Add tab-switch coverage that reaches Workflow/System and returns to Queue. Assert the active-duration node is visible and formatted as `HH:MM:SS`.

- [ ] **Step 2: Run targeted E2E**

Run: `npx playwright test e2e/extension.spec.ts e2e/flowrun.spec.ts --workers=1`
Expected: PASS.

- [ ] **Step 3: Update README**

Document the three-tab command center, aggregate collapse behavior, collapsed-row deletion, and real-time total active duration.

- [ ] **Step 4: Run repository verification**

Run: `git diff --check`
Run: `npm run verify`
Run: `npm run test:e2e`
Expected: all PASS.

- [ ] **Step 5: Review scoped diff before publication**

Confirm no unrelated files or generated artifacts are included; then follow repository rules for staging, commit, push, PR, CI, merge, and continuity checkpoint.