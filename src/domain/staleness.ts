import type { ConversationQueue } from './types';

/**
 * How long a lapsed owner lease is tolerated before the driver is called stalled.
 *
 * The lease is renewed every heartbeat (10 s) and lasts 30 s, so a live owner refreshes it long
 * before it lapses. Chrome throttles timers in hidden tabs to roughly one wake-up per minute and
 * can freeze or discard a tab entirely, so the grace is deliberately several multiples of that
 * cycle: this is meant to catch a driver that is gone, not to flag a tab that is merely asleep.
 */
export const OWNER_STALL_GRACE_MS = 5 * 60_000;

export interface QueueStallInput {
  queue: ConversationQueue;
  now: number;
  graceMs?: number;
}

/**
 * Whether the tab responsible for this queue has stopped driving it.
 *
 * Only persisted data is inspected, so any tab — including a freshly loaded one — can tell that a
 * queue which claims to be running has nobody behind it. This is a pure predicate on purpose: it
 * reports the situation so the panel can be honest about it, and it never resumes anything by
 * itself. Recovery stays an explicit, user-visible action (reloading the page takes the lease and
 * re-evaluates from the page's real state).
 */
export const isQueueDriverStalled = ({ queue, now, graceMs = OWNER_STALL_GRACE_MS }: QueueStallInput): boolean => {
  if (queue.status !== 'running') return false;
  const inFlight = queue.items.some((item) => item.state === 'sending' || item.state === 'running');
  if (!inFlight) return false;
  if (!queue.owner) return true;
  return now > queue.owner.expiresAt + graceMs;
};
