import { describe, expect, it } from 'vitest';
import {
  addItems,
  canDispatch,
  createQueue,
  deleteQueuedItem,
  editQueuedItem,
  getNextQueuedItem,
  markItemCompleted,
  reorderQueuedItem,
  resumeQueue,
  pauseQueue,
} from '../src/domain/queue-engine';

const now = 1_700_000_000_000;

describe('queue engine', () => {
  it('selects the first queued item and never reselects completed items', () => {
    let queue = createQueue('conv:a', now);
    queue = addItems(queue, ['one', 'two'], now + 1);
    expect(getNextQueuedItem(queue)?.content).toBe('one');

    queue = markItemCompleted(queue, queue.items[0]!.id, now + 2);
    expect(getNextQueuedItem(queue)?.content).toBe('two');
  });

  it('does not dispatch while paused and resumes without losing position', () => {
    let queue = addItems(createQueue('conv:a', now), ['one'], now + 1);
    queue = pauseQueue(queue, now + 2);
    expect(canDispatch(queue)).toBe(false);
    expect(getNextQueuedItem(queue)?.content).toBe('one');

    queue = resumeQueue(queue, now + 3);
    expect(canDispatch(queue)).toBe(true);
    expect(getNextQueuedItem(queue)?.content).toBe('one');
  });

  it('edits, deletes and reorders only queued items', () => {
    let queue = addItems(createQueue('conv:a', now), ['one', 'two', 'three'], now + 1);
    const [one, two, three] = queue.items;
    queue = editQueuedItem(queue, two!.id, 'two edited', now + 2);
    queue = reorderQueuedItem(queue, three!.id, 0, now + 3);
    queue = deleteQueuedItem(queue, one!.id, now + 4);

    expect(queue.items.map((item) => item.content)).toEqual(['three', 'two edited']);
  });

  it('marks an empty or fully completed queue completed', () => {
    let queue = createQueue('conv:a', now);
    expect(queue.status).toBe('completed');

    queue = addItems(queue, ['one'], now + 1);
    expect(queue.status).toBe('idle');
    queue = markItemCompleted(queue, queue.items[0]!.id, now + 2);
    expect(queue.status).toBe('completed');
  });

  it('treats failed items as terminal when the last queued item is removed', () => {
    let queue = addItems(createQueue('conv:a', now), ['failed', 'pending'], now + 1);
    const [failed, pending] = queue.items;
    queue = {
      ...queue,
      items: [
        { ...failed!, state: 'failed', completedAt: now + 2, updatedAt: now + 2 },
        pending!,
      ],
    };

    queue = deleteQueuedItem(queue, pending!.id, now + 3);

    expect(queue.status).toBe('completed');
  });

  it('prunes the oldest terminal history item to admit a new follow-up at capacity', () => {
    let queue = addItems(createQueue('conv:a', now), Array.from({ length: 50 }, (_, i) => `item-${i}`), now + 1);
    const oldestId = queue.items[0]!.id;
    queue = markItemCompleted(queue, oldestId, now + 2);

    queue = addItems(queue, ['item-50'], now + 3);

    expect(queue.items).toHaveLength(50);
    expect(queue.items.some((item) => item.id === oldestId)).toBe(false);
    expect(queue.items.at(-1)).toMatchObject({ content: 'item-50', state: 'queued' });
    expect(queue.items.filter((item) => item.state === 'queued')).toHaveLength(50);
  });

  it('never prunes active items to make room for new follow-ups', () => {
    let queue = addItems(createQueue('conv:a', now), Array.from({ length: 50 }, (_, i) => `item-${i}`), now + 1);
    queue = markItemCompleted(queue, queue.items[0]!.id, now + 2);

    expect(() => addItems(queue, ['item-50', 'item-51'], now + 3)).toThrow(/50/);
    expect(queue.items).toHaveLength(50);
  });

  it('rejects more than 50 items', () => {
    const queue = createQueue('conv:a', now);
    expect(() => addItems(queue, Array.from({ length: 51 }, (_, i) => String(i)), now + 1)).toThrow(/50/);
  });
});
