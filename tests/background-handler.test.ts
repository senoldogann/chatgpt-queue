import { describe, expect, it } from 'vitest';
import { handleBackgroundRequest } from '../src/runtime/background-handler';
import { QueueCoordinator } from '../src/coordinator/queue-coordinator';
import { QueueRepository, type StorageAreaLike } from '../src/storage/queue-repository';

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, values); }
}

const makeCoordinator = () => new QueueCoordinator(new QueueRepository(new MemoryStorage()), {
  now: () => 100,
  uuid: (() => { let i = 0; return () => `id-${++i}`; })(),
  leaseMs: 1000,
});

describe('background request handler', () => {
  it('routes queue lifecycle requests using the sender tab as owner identity', async () => {
    const coordinator = makeCoordinator();
    await handleBackgroundRequest({ type: 'ensure', key: 'conv:a' }, 1, coordinator);
    await handleBackgroundRequest({ type: 'add', key: 'conv:a', messages: ['one'] }, 1, coordinator);
    expect(await handleBackgroundRequest({ type: 'claim', key: 'conv:a' }, 1, coordinator)).toMatchObject({ kind: 'acquired' });
    await handleBackgroundRequest({ type: 'start', key: 'conv:a' }, 1, coordinator);

    const queue = await handleBackgroundRequest({ type: 'get', key: 'conv:a' }, 1, coordinator);
    expect(queue.status).toBe('running');
  });

  it('isolates owners across conversations and rejects a second owner for the same one', async () => {
    const coordinator = makeCoordinator();
    await handleBackgroundRequest({ type: 'ensure', key: 'conv:a' }, 1, coordinator);
    await handleBackgroundRequest({ type: 'ensure', key: 'conv:b' }, 2, coordinator);
    await handleBackgroundRequest({ type: 'claim', key: 'conv:a' }, 1, coordinator);

    expect(await handleBackgroundRequest({ type: 'claim', key: 'conv:a' }, 2, coordinator)).toEqual({ kind: 'conflict', ownerTabId: 1 });
    expect(await handleBackgroundRequest({ type: 'claim', key: 'conv:b' }, 2, coordinator)).toMatchObject({ kind: 'acquired' });
  });

  it('routes queued-item editing, reordering, deletion and migration', async () => {
    const coordinator = makeCoordinator();
    await handleBackgroundRequest({ type: 'ensure', key: 'temp:x' }, 1, coordinator);
    let queue = await handleBackgroundRequest({ type: 'add', key: 'temp:x', messages: ['one', 'two', 'three'] }, 1, coordinator);
    const [one, two, three] = queue.items;
    queue = await handleBackgroundRequest({ type: 'edit', key: 'temp:x', itemId: two.id, content: 'two edited' }, 1, coordinator);
    queue = await handleBackgroundRequest({ type: 'reorder', key: 'temp:x', itemId: three.id, queuedIndex: 0 }, 1, coordinator);
    queue = await handleBackgroundRequest({ type: 'delete', key: 'temp:x', itemId: one.id }, 1, coordinator);
    queue = await handleBackgroundRequest({ type: 'migrate', fromKey: 'temp:x', toKey: 'conv:real' }, 1, coordinator);

    expect(queue.conversationKey).toBe('conv:real');
    expect(queue.items.map((item: { content: string }) => item.content)).toEqual(['three', 'two edited']);
  });
});
