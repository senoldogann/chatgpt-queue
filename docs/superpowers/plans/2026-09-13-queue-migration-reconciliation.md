# Queue Migration Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconcile duplicate provisional/final queue keys safely when one side is only an empty placeholder.

**Architecture:** Keep reconciliation entirely inside `QueueRepository.migrateKey()` so callers remain unchanged. Add a small predicate for pristine placeholders and preserve the current fail-closed error when both queues contain meaningful state.

**Tech Stack:** TypeScript, Vitest, Chrome local storage abstraction

**Spec:** `docs/superpowers/specs/2026-09-13-queue-migration-reconciliation-design.md`

## Global Constraints

- Development and verification run locally first.
- Do not merge two meaningful queues.
- Do not add permissions, dependencies, or new storage schema fields.
- Preserve existing migration behavior when the destination key does not exist.

---

### Task 1: Queue repository reconciliation

**Files:**
- Modify: `src/storage/queue-repository.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Consumes: `ConversationQueue` and existing `QueueRepository.migrateKey(fromKey, toKey, now)`
- Produces: same public `migrateKey()` signature with safe placeholder reconciliation

- [x] **Step 1: Write failing tests** for pristine-source/meaningful-target, meaningful-source/pristine-target, and meaningful/meaningful collision.
- [x] **Step 2: Run `npx vitest run tests/storage.test.ts`** and confirm the new reconciliation tests fail for the missing behavior.
- [x] **Step 3: Implement `isPristinePlaceholder(queue)`** and the minimal branches in `migrateKey()`.
- [x] **Step 4: Run `npx vitest run tests/storage.test.ts`** and confirm all storage tests pass.
- [x] **Step 5: Run `npm run verify` and `npm run test:e2e`** to prove no queue/runtime regression.
- [ ] **Step 6: Commit, open PR, require CI success, squash-merge, and prune the completed branch.**
