import { describe, expect, it } from 'vitest';
import {
  HANDOFF_STORAGE_KEY,
  HandoffRepository,
  MAX_PROCESSED_HANDOFF_ITEMS,
} from '../../src/context/handoff-repository';
import type { StorageAreaLike } from '../../src/storage/queue-repository';

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, structuredClone(values)); }
}

const capture = (repo: HandoffRepository, itemId: string, at: number, carriedItems: string[] = []) =>
  repo.capture({
    itemId,
    sourceConversationKey: 'conv:source',
    brief: `brief for ${itemId}`,
    carriedItems,
    now: at,
    idFactory: () => `handoff:${itemId}`,
  });

describe('HandoffRepository', () => {
  it('starts empty and round-trips a pending handoff', async () => {
    const repo = new HandoffRepository(new MemoryStorage());
    expect(await repo.getPending()).toBeUndefined();

    const result = await capture(repo, 'item-1', 10, ['carry me']);
    expect(result).toMatchObject({ ok: true, record: { id: 'handoff:item-1', carriedItems: ['carry me'], createdAt: 10 } });
    expect((await repo.getPending())?.brief).toBe('brief for item-1');
  });

  it('never re-arms a handoff from the same completed queue item', async () => {
    const repo = new HandoffRepository(new MemoryStorage());
    await capture(repo, 'item-1', 10);
    await repo.consume('handoff:item-1', 'temp:new', 20);

    expect(await repo.getPending()).toBeUndefined();
    expect(await capture(repo, 'item-1', 30)).toEqual({ ok: false, reason: 'already-captured' });
    expect(await repo.getPending()).toBeUndefined();
  });

  it('consumes a handoff exactly once', async () => {
    const repo = new HandoffRepository(new MemoryStorage());
    await capture(repo, 'item-1', 10);

    expect((await repo.consume('handoff:item-1', 'temp:new', 20))?.id).toBe('handoff:item-1');
    expect(await repo.consume('handoff:item-1', 'temp:other', 21)).toBeUndefined();
    expect(await repo.getConsumed()).toEqual([
      { id: 'handoff:item-1', consumedByConversationKey: 'temp:new', consumedAt: 20 },
    ]);
  });

  it('replaces the previous pending handoff instead of growing unbounded state', async () => {
    const repo = new HandoffRepository(new MemoryStorage());
    await capture(repo, 'item-1', 10);
    await capture(repo, 'item-2', 11);

    expect((await repo.getPending())?.id).toBe('handoff:item-2');
  });

  it('does not expose a replacement handoff to a claim bound to the previous handoff id', async () => {
    const repo = new HandoffRepository(new MemoryStorage());
    await capture(repo, 'item-a', 10);
    const claimedHandoffId = (await repo.getPending())!.id;
    await capture(repo, 'item-b', 11);
    expect(await repo.getPending(claimedHandoffId)).toBeUndefined();
    expect(await repo.consume(claimedHandoffId, 'temp:a', 12)).toBeUndefined();
    expect((await repo.getPending())?.id).toBe('handoff:item-b');
  });

  it('bounds the processed-item memory and rejects empty briefs', async () => {
    const storage = new MemoryStorage();
    const repo = new HandoffRepository(storage);
    for (let index = 0; index < MAX_PROCESSED_HANDOFF_ITEMS + 5; index += 1) {
      await capture(repo, `item-${index}`, index);
    }

    const state = storage.data[HANDOFF_STORAGE_KEY] as { processedItems: string[] };
    expect(state.processedItems).toHaveLength(MAX_PROCESSED_HANDOFF_ITEMS);
    expect(await capture(repo, 'item-empty', 99)).toMatchObject({ ok: true });
    expect(await repo.capture({
      itemId: 'blank', sourceConversationKey: 'conv:source', brief: '   ', carriedItems: [], now: 1, idFactory: () => 'x',
    })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an unknown persisted schema instead of guessing', async () => {
    const storage = new MemoryStorage();
    storage.data[HANDOFF_STORAGE_KEY] = { version: 2, consumed: [], processedItems: [] };
    await expect(new HandoffRepository(storage).getPending()).rejects.toThrow('unsupported-handoff-storage-version');
  });
});
