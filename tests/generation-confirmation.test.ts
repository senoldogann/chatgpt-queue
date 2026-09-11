import { describe, expect, it } from 'vitest';
import { QueueCoordinator } from '../src/coordinator/queue-coordinator';
import { QueueRepository, type StorageAreaLike } from '../src/storage/queue-repository';

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, values); }
}

describe('generation confirmation', () => {
  it('atomically confirms a reserved sending item as running generation', async () => {
    let seq = 0;
    const coordinator = new QueueCoordinator(new QueueRepository(new MemoryStorage()), {
      now: () => 10,
      uuid: () => `id-${++seq}`,
    });
    await coordinator.ensureQueue('conv:a');
    await coordinator.add('conv:a', ['one']);
    await coordinator.claim('conv:a', 1);
    await coordinator.start('conv:a', 1);
    const reservation = await coordinator.reserveNext('conv:a', 1, 3);

    const queue = await coordinator.confirmGenerationStarted('conv:a', 1, reservation!.itemId, reservation!.dispatchToken);

    expect(queue.items[0]?.state).toBe('running');
    expect(queue.runtime.phase).toBe('generating');
    expect(queue.runtime.generationObserved).toBe(true);
  });
});
