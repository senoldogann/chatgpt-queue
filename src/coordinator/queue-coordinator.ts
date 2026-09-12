import {
  addItems,
  createQueue,
  deleteQueuedItem,
  editQueuedItem,
  getNextQueuedItem,
  pauseQueue,
  reorderQueuedItem,
} from '../domain/queue-engine';
import type { ConversationQueue, QueueItem } from '../domain/types';
import { QueueRepository } from '../storage/queue-repository';

export interface CoordinatorOptions {
  now?: () => number;
  uuid?: () => string;
  leaseMs?: number;
}

export type ClaimResult =
  | { kind: 'acquired'; leaseId: string }
  | { kind: 'conflict'; ownerTabId: number };

export interface DispatchReservation {
  itemId: string;
  content: string;
  dispatchToken: string;
}

export class OwnershipError extends Error {
  constructor() {
    super('conversation-owner-mismatch');
    this.name = 'OwnershipError';
  }
}

export class QueueCoordinator {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly leaseMs: number;
  private mutationTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly repo: QueueRepository, options: CoordinatorOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.uuid = options.uuid ?? (() => crypto.randomUUID());
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  private async requiredQueue(key: string): Promise<ConversationQueue> {
    const queue = await this.repo.get(key);
    if (!queue) throw new Error(`Queue not found for ${key}`);
    return queue;
  }

  private requireOwner(queue: ConversationQueue, tabId: number): void {
    const owner = queue.owner;
    if (!owner || owner.tabId !== tabId) throw new OwnershipError();
    // The lease timer bounds how long *another* tab waits before taking over a
    // conversation whose driver stopped heartbeating (`claim` enforces that). It must not
    // invalidate the owning tab's own work: Chrome throttles timers in hidden tabs to about
    // one wake-up per minute and a suspend/resume skips them entirely, so a live owner can
    // legitimately look expired while it is still the only tab driving this conversation.
    // A tab proves its own liveness by calling in with its tab id; a foreign tab still has to
    // claim the record, which only succeeds once the lease has actually lapsed.
  }

  async get(key: string): Promise<ConversationQueue | undefined> {
    return this.repo.get(key);
  }

  async ensureQueue(key: string): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const existing = await this.repo.get(key);
      if (existing) return existing;
      const queue = createQueue(key, this.now());
      await this.repo.put(queue);
      return queue;
    });
  }

  async add(key: string, contents: string[]): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = (await this.repo.get(key)) ?? createQueue(key, this.now());
      const updated = addItems(queue, contents, this.now());
      await this.repo.put(updated);
      return updated;
    });
  }

  async edit(key: string, itemId: string, content: string): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const updated = editQueuedItem(await this.requiredQueue(key), itemId, content, this.now());
      await this.repo.put(updated);
      return updated;
    });
  }

  async remove(key: string, itemId: string): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const updated = deleteQueuedItem(await this.requiredQueue(key), itemId, this.now());
      await this.repo.put(updated);
      return updated;
    });
  }

  async reorder(key: string, itemId: string, queuedIndex: number): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const updated = reorderQueuedItem(await this.requiredQueue(key), itemId, queuedIndex, this.now());
      await this.repo.put(updated);
      return updated;
    });
  }

  async claim(key: string, tabId: number): Promise<ClaimResult> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      const now = this.now();
      if (queue.owner && queue.owner.tabId !== tabId && queue.owner.expiresAt > now) {
        return { kind: 'conflict', ownerTabId: queue.owner.tabId };
      }
      const leaseId = queue.owner?.tabId === tabId && queue.owner.expiresAt > now ? queue.owner.leaseId : this.uuid();
      const updated: ConversationQueue = {
        ...queue,
        owner: { tabId, leaseId, heartbeatAt: now, expiresAt: now + this.leaseMs },
        updatedAt: now,
      };
      await this.repo.put(updated);
      return { kind: 'acquired', leaseId };
    });
  }

  async heartbeat(key: string, tabId: number): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      const now = this.now();
      const updated: ConversationQueue = {
        ...queue,
        owner: { ...queue.owner!, heartbeatAt: now, expiresAt: now + this.leaseMs },
        updatedAt: now,
      };
      await this.repo.put(updated);
      return updated;
    });
  }

  async start(key: string, tabId: number): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      if (!getNextQueuedItem(queue) && !queue.items.some((item) => item.state === 'running')) return queue;
      const active = queue.runtime.activeItemId
        ? queue.items.find((item) => item.id === queue.runtime.activeItemId)
        : undefined;
      const resumedRuntime = queue.runtime.phase === 'blocked'
        ? active?.state === 'sending'
          ? { ...queue.runtime, phase: 'sending' as const }
          : active?.state === 'running'
            ? { ...queue.runtime, phase: 'generating' as const }
            : { phase: 'ready_to_send' as const }
        : queue.runtime.activeItemId
          ? queue.runtime
          : { phase: 'ready_to_send' as const };
      const updated: ConversationQueue = {
        ...queue,
        status: 'running',
        runtime: resumedRuntime,
        updatedAt: this.now(),
      };
      delete updated.blockedReason;
      await this.repo.put(updated);
      return updated;
    });
  }

  async pause(key: string, tabId: number): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      const updated = pauseQueue(queue, this.now());
      await this.repo.put(updated);
      return updated;
    });
  }

  async reserveNext(key: string, tabId: number, baselineAssistantCount: number, baselineAssistantTurnKey?: string): Promise<DispatchReservation | null> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      if (queue.status !== 'running' || !['ready_to_send', 'ready_to_send_next'].includes(queue.runtime.phase)) return null;
      const item = getNextQueuedItem(queue);
      if (!item) return null;
      const now = this.now();
      const dispatchToken = this.uuid();
      const items = queue.items.map((candidate): QueueItem => candidate.id === item.id
        ? { ...candidate, state: 'sending', dispatchToken, sendAttemptedAt: now, updatedAt: now }
        : candidate);
      const updated: ConversationQueue = {
        ...queue,
        items,
        runtime: {
          phase: 'sending',
          activeItemId: item.id,
          baselineAssistantCount,
          ...(baselineAssistantTurnKey === undefined ? {} : { baselineAssistantTurnKey }),
          generationObserved: false,
        },
        updatedAt: now,
      };
      await this.repo.put(updated);
      return { itemId: item.id, content: item.content, dispatchToken };
    });
  }

  async ackSent(key: string, tabId: number, itemId: string, dispatchToken: string): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item || item.dispatchToken !== dispatchToken) throw new Error('dispatch-token-mismatch');
      if (item.state === 'running') return queue;
      if (item.state !== 'sending') throw new Error(`cannot-ack-item-in-${item.state}`);
      const now = this.now();
      const updated: ConversationQueue = {
        ...queue,
        items: queue.items.map((candidate) => candidate.id === itemId ? { ...candidate, state: 'running', startedAt: now, updatedAt: now } : candidate),
        runtime: { ...queue.runtime, phase: 'waiting_generation_start' },
        updatedAt: now,
      };
      await this.repo.put(updated);
      return updated;
    });
  }

  async markGenerationStarted(key: string, tabId: number, itemId: string, dispatchToken: string): Promise<ConversationQueue> {
    return this.setRuntimePhase(key, tabId, itemId, dispatchToken, 'generating');
  }

  async markWaitingForStability(key: string, tabId: number, itemId: string, dispatchToken: string): Promise<ConversationQueue> {
    return this.setRuntimePhase(key, tabId, itemId, dispatchToken, 'waiting_stable_completion');
  }

  private async setRuntimePhase(
    key: string,
    tabId: number,
    itemId: string,
    dispatchToken: string,
    phase: 'generating' | 'waiting_stable_completion',
  ): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item || item.dispatchToken !== dispatchToken || item.state !== 'running') throw new Error('active-dispatch-mismatch');
      const now = this.now();
      const runtime = { ...queue.runtime, phase, generationObserved: true };
      if (phase === 'waiting_stable_completion') {
        runtime.stableWaitStartedAt = queue.runtime.stableWaitStartedAt ?? now;
      } else {
        delete runtime.stableWaitStartedAt;
      }
      const updated: ConversationQueue = {
        ...queue,
        runtime,
        updatedAt: now,
      };
      await this.repo.put(updated);
      return updated;
    });
  }

  async confirmGenerationStarted(key: string, tabId: number, itemId: string, dispatchToken: string, controlObserved: boolean): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item || item.dispatchToken !== dispatchToken || !['sending', 'running'].includes(item.state)) throw new Error('active-dispatch-mismatch');
      const now = this.now();
      const updated: ConversationQueue = {
        ...queue,
        items: queue.items.map((candidate) => candidate.id === itemId ? { ...candidate, state: 'running', startedAt: candidate.startedAt ?? now, updatedAt: now } : candidate),
        runtime: { ...queue.runtime, phase: 'generating', generationObserved: (queue.runtime.generationObserved ?? false) || controlObserved },
        updatedAt: now,
      };
      await this.repo.put(updated);
      return updated;
    });
  }

  async completeCurrent(key: string, tabId: number, itemId: string, dispatchToken: string): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item || item.dispatchToken !== dispatchToken) throw new Error('active-dispatch-mismatch');
      if (item.state === 'completed') return queue;
      if (item.state !== 'running') throw new Error(`cannot-complete-item-in-${item.state}`);
      const now = this.now();
      const items = queue.items.map((candidate): QueueItem => candidate.id === itemId
        ? { ...candidate, state: 'completed', completedAt: now, updatedAt: now }
        : candidate);
      const hasQueued = items.some((candidate) => candidate.state === 'queued');
      const updated: ConversationQueue = {
        ...queue,
        items,
        status: hasQueued ? (queue.status === 'paused' ? 'paused' : 'running') : 'completed',
        runtime: hasQueued ? { phase: 'ready_to_send_next' } : { phase: 'idle' },
        updatedAt: now,
      };
      await this.repo.put(updated);
      return updated;
    });
  }

  async block(key: string, tabId: number, reason: string): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      this.requireOwner(queue, tabId);
      const updated: ConversationQueue = {
        ...queue,
        status: 'blocked',
        runtime: { ...queue.runtime },
        blockedReason: reason,
        updatedAt: this.now(),
      };
      await this.repo.put(updated);
      return updated;
    });
  }

  async recover(key: string): Promise<ConversationQueue> {
    return this.exclusive(async () => {
      const queue = await this.requiredQueue(key);
      if (!queue.items.some((item) => item.state === 'sending')) return queue;
      const updated: ConversationQueue = {
        ...queue,
        status: 'blocked',
        runtime: { ...queue.runtime, phase: 'blocked' },
        blockedReason: 'uncertain-send',
        updatedAt: this.now(),
      };
      await this.repo.put(updated);
      return updated;
    });
  }

  async migrateKey(fromKey: string, toKey: string): Promise<ConversationQueue> {
    return this.exclusive(() => this.repo.migrateKey(fromKey, toKey, this.now()));
  }
}
