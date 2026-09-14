import { isTerminalQueueItemState, MAX_QUEUE_ITEMS, STORAGE_VERSION } from './types';
import type { ConversationQueue, QueueItem } from './types';

const id = (prefix: string) => `${prefix}:${crypto.randomUUID()}`;

const withUpdated = (queue: ConversationQueue, items: QueueItem[], now: number): ConversationQueue => {
  const hasPending = items.some((item) => !isTerminalQueueItemState(item.state));
  const status = hasPending ? (queue.status === 'completed' ? 'idle' : queue.status) : 'completed';
  return { ...queue, items, status, updatedAt: now };
};

export function createQueue(conversationKey: string, now: number): ConversationQueue {
  return {
    version: STORAGE_VERSION,
    id: id('queue'),
    conversationKey,
    status: 'completed',
    items: [],
    runtime: { phase: 'idle' },
    createdAt: now,
    updatedAt: now,
  };
}

export function addItems(queue: ConversationQueue, contents: string[], now: number): ConversationQueue {
  const normalized = contents.map((content) => content.trim()).filter(Boolean);
  if (queue.items.length + normalized.length > MAX_QUEUE_ITEMS) {
    throw new Error(`Queue cannot contain more than ${MAX_QUEUE_ITEMS} items`);
  }
  const added: QueueItem[] = normalized.map((content) => ({
    id: id('item'),
    content,
    state: 'queued',
    createdAt: now,
    updatedAt: now,
  }));
  return withUpdated({ ...queue, status: queue.status === 'completed' ? 'idle' : queue.status }, [...queue.items, ...added], now);
}

export function getNextQueuedItem(queue: ConversationQueue): QueueItem | undefined {
  return queue.items.find((item) => item.state === 'queued');
}

export function canDispatch(queue: ConversationQueue): boolean {
  return queue.status === 'running' && Boolean(getNextQueuedItem(queue));
}

export function pauseQueue(queue: ConversationQueue, now: number): ConversationQueue {
  if (queue.status === 'completed') return queue;
  return { ...queue, status: 'paused', updatedAt: now };
}

export function resumeQueue(queue: ConversationQueue, now: number): ConversationQueue {
  if (!getNextQueuedItem(queue) && !queue.items.some((item) => item.state === 'running' || item.state === 'sending')) {
    return { ...queue, status: 'completed', runtime: { phase: 'idle' }, updatedAt: now };
  }
  const updated: ConversationQueue = { ...queue, status: 'running', runtime: { ...queue.runtime, phase: queue.runtime.activeItemId ? queue.runtime.phase : 'ready_to_send' }, updatedAt: now };
  delete updated.blockedReason;
  return updated;
}

export function editQueuedItem(queue: ConversationQueue, itemId: string, content: string, now: number): ConversationQueue {
  const next = content.trim();
  if (!next) throw new Error('Queue item cannot be empty');
  const item = queue.items.find((candidate) => candidate.id === itemId);
  if (!item || item.state !== 'queued') throw new Error('Only queued items can be edited');
  return withUpdated(queue, queue.items.map((candidate) => candidate.id === itemId ? { ...candidate, content: next, updatedAt: now } : candidate), now);
}

export function deleteQueuedItem(queue: ConversationQueue, itemId: string, now: number): ConversationQueue {
  const item = queue.items.find((candidate) => candidate.id === itemId);
  if (!item || item.state !== 'queued') throw new Error('Only queued items can be deleted');
  return withUpdated(queue, queue.items.filter((candidate) => candidate.id !== itemId), now);
}

export function reorderQueuedItem(queue: ConversationQueue, itemId: string, queuedIndex: number, now: number): ConversationQueue {
  const item = queue.items.find((candidate) => candidate.id === itemId);
  if (!item || item.state !== 'queued') throw new Error('Only queued items can be reordered');
  const queued = queue.items.filter((candidate) => candidate.state === 'queued' && candidate.id !== itemId);
  const target = Math.max(0, Math.min(queuedIndex, queued.length));
  queued.splice(target, 0, item);
  const iterator = queued[Symbol.iterator]();
  const items = queue.items.map((candidate) => candidate.state === 'queued' ? iterator.next().value! : candidate);
  return withUpdated(queue, items, now);
}

export function markItemCompleted(queue: ConversationQueue, itemId: string, now: number): ConversationQueue {
  const items = queue.items.map((item) => item.id === itemId ? { ...item, state: 'completed' as const, completedAt: now, updatedAt: now } : item);
  return withUpdated(queue, items, now);
}
