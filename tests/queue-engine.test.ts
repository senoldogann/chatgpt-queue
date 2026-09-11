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

  it('rejects more than 50 items', () => {
    const queue = createQueue('conv:a', now);
    expect(() => addItems(queue, Array.from({ length: 51 }, (_, i) => String(i)), now + 1)).toThrow(/50/);
  });
});
