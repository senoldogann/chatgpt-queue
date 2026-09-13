import { describe, expect, it } from 'vitest';
import { addItems, createQueue } from '../src/domain/queue-engine';
import { QueueRepository, UnsupportedStorageVersionError, type StorageAreaLike } from '../src/storage/queue-repository';

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, values); }
}

describe('queue repository', () => {
  it('round-trips queues and survives repository recreation', async () => {
    const storage = new MemoryStorage();
    const first = new QueueRepository(storage);
    const queue = addItems(createQueue('temp:7:x', 1), ['one', 'two'], 2);
    await first.put(queue);

    const afterWorkerRestart = new QueueRepository(storage);
    expect((await afterWorkerRestart.get('temp:7:x'))?.items.map((item) => item.content)).toEqual(['one', 'two']);
  });

  it('migrates a temporary new-chat queue to the real conversation key', async () => {
    const storage = new MemoryStorage();
    const repo = new QueueRepository(storage);
    await repo.put(addItems(createQueue('temp:7:x', 1), ['one'], 2));

    const migrated = await repo.migrateKey('temp:7:x', 'conv:abc', 3);
    expect(migrated.conversationKey).toBe('conv:abc');
    expect(await repo.get('temp:7:x')).toBeUndefined();
    expect((await repo.get('conv:abc'))?.items[0]?.content).toBe('one');
  });

  it('discards a pristine source placeholder when the target queue already exists', async () => {
    const storage = new MemoryStorage();
    const repo = new QueueRepository(storage);
    await repo.put(createQueue('temp:7:x', 1));
    await repo.put(addItems(createQueue('conv:abc', 1), ['existing'], 2));

    const migrated = await repo.migrateKey('temp:7:x', 'conv:abc', 3);

    expect(migrated.conversationKey).toBe('conv:abc');
    expect(migrated.items.map((item) => item.content)).toEqual(['existing']);
    expect(await repo.get('temp:7:x')).toBeUndefined();
  });

  it('replaces a pristine target placeholder with a meaningful source queue', async () => {
    const storage = new MemoryStorage();
    const repo = new QueueRepository(storage);
    await repo.put(addItems(createQueue('temp:7:x', 1), ['draft'], 2));
    await repo.put(createQueue('conv:abc', 1));

    const migrated = await repo.migrateKey('temp:7:x', 'conv:abc', 3);

    expect(migrated.conversationKey).toBe('conv:abc');
    expect(migrated.items.map((item) => item.content)).toEqual(['draft']);
    expect(await repo.get('temp:7:x')).toBeUndefined();
  });

  it('still fails closed when both source and target queues contain meaningful state', async () => {
    const storage = new MemoryStorage();
    const repo = new QueueRepository(storage);
    await repo.put(addItems(createQueue('temp:7:x', 1), ['source'], 2));
    await repo.put(addItems(createQueue('conv:abc', 1), ['target'], 2));

    await expect(repo.migrateKey('temp:7:x', 'conv:abc', 3))
      .rejects.toThrow('Target queue already exists for conv:abc');
    expect((await repo.get('temp:7:x'))?.items.map((item) => item.content)).toEqual(['source']);
    expect((await repo.get('conv:abc'))?.items.map((item) => item.content)).toEqual(['target']);
  });

  it('rejects an unknown persisted schema version instead of guessing', async () => {
    const storage = new MemoryStorage();
    storage.data.chatgptQueueState = { version: 99, queues: {} };
    const repo = new QueueRepository(storage);
    await expect(repo.get('conv:a')).rejects.toBeInstanceOf(UnsupportedStorageVersionError);
  });
});
