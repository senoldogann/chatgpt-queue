import { describe, expect, it } from 'vitest';
import { CONTEXT_SETTINGS_KEY, ContextSettingsRepository } from '../../src/context/settings';
import type { StorageAreaLike } from '../../src/storage/queue-repository';

class MemoryStorage implements StorageAreaLike {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, structuredClone(values)); }
}

describe('ContextSettingsRepository', () => {
  it('has no override by default', async () => {
    expect(await new ContextSettingsRepository(new MemoryStorage()).getCapacityTokens()).toBeUndefined();
  });

  it('stores a configured capacity and clears it when set to null', async () => {
    const storage = new MemoryStorage();
    const repo = new ContextSettingsRepository(storage);

    await repo.setCapacityTokens(1_310_000);
    expect(await repo.getCapacityTokens()).toBe(1_310_000);

    await repo.setCapacityTokens(null);
    expect(await repo.getCapacityTokens()).toBeUndefined();
    expect(storage.data[CONTEXT_SETTINGS_KEY]).toEqual({ version: 1 });
  });

  it('ignores a persisted value outside the usable range', async () => {
    const storage = new MemoryStorage();
    storage.data[CONTEXT_SETTINGS_KEY] = { version: 1, capacityTokens: 12 };

    expect(await new ContextSettingsRepository(storage).getCapacityTokens()).toBeUndefined();
  });
});
