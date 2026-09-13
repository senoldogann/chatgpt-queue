import { describe, expect, it } from 'vitest';
import { OWNER_STALL_GRACE_MS, isQueueDriverStalled } from '../src/domain/staleness';
import type { ConversationQueue, QueueItem } from '../src/domain/types';

const item = (state: QueueItem['state']): QueueItem => ({
  id: `item-${state}`,
  content: 'carry on',
  state,
  createdAt: 1,
  updatedAt: 1,
});

const queue = (overrides: Partial<ConversationQueue> = {}): ConversationQueue => ({
  version: 1,
  id: 'q',
  conversationKey: 'conv:a',
  status: 'running',
  items: [item('running')],
  runtime: { phase: 'generating', activeItemId: 'item-running', generationObserved: true },
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

const lease = (expiresAt: number) => ({ tabId: 7, leaseId: 'lease', heartbeatAt: expiresAt - 30_000, expiresAt });

describe('isQueueDriverStalled', () => {
  it('stays quiet while the owner lease is being renewed', () => {
    expect(isQueueDriverStalled({ queue: queue({ owner: lease(60_000) }), now: 50_000 })).toBe(false);
  });

  it('tolerates a lapsed lease for the grace period so a throttled tab is not flagged', () => {
    const now = 100_000;
    expect(isQueueDriverStalled({ queue: queue({ owner: lease(now - OWNER_STALL_GRACE_MS) }), now })).toBe(false);
    expect(isQueueDriverStalled({ queue: queue({ owner: lease(now - OWNER_STALL_GRACE_MS - 1) }), now })).toBe(true);
  });

  it('reports a running queue with in-flight work and no owner at all', () => {
    // Built without the `owner` key so the fixture matches a queue nothing has ever claimed.
    const { owner: _owner, ...unclaimed } = queue({ owner: lease(0) });
    expect(isQueueDriverStalled({ queue: unclaimed, now: 10_000 })).toBe(true);
  });

  it('ignores queues that are not running or have nothing in flight', () => {
    const now = 10_000_000;
    expect(isQueueDriverStalled({ queue: queue({ status: 'paused', owner: lease(0) }), now })).toBe(false);
    expect(isQueueDriverStalled({ queue: queue({ status: 'blocked', owner: lease(0) }), now })).toBe(false);
    expect(isQueueDriverStalled({ queue: queue({ status: 'completed', items: [], owner: lease(0) }), now })).toBe(false);
    expect(isQueueDriverStalled({ queue: queue({ items: [item('queued')], owner: lease(0) }), now })).toBe(false);
    expect(isQueueDriverStalled({ queue: queue({ items: [item('completed')], owner: lease(0) }), now })).toBe(false);
  });

  it('detects a stalled driver in an item that was still being sent', () => {
    expect(isQueueDriverStalled({
      queue: queue({ items: [item('sending')], runtime: { phase: 'sending', activeItemId: 'item-sending' }, owner: lease(0) }),
      now: 10_000_000,
    })).toBe(true);
  });

  it('honours an explicit grace override', () => {
    const input = { queue: queue({ owner: lease(0) }), now: 5_000 };
    expect(isQueueDriverStalled({ ...input, graceMs: 10_000 })).toBe(false);
    expect(isQueueDriverStalled({ ...input, graceMs: 1_000 })).toBe(true);
  });
});
