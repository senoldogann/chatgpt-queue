import { describe, expect, it } from 'vitest';
import { BridgeReloadHandoff, type BridgeReloadStorageArea } from '../../src/bridge/reload-handoff';

class MemoryStorage implements BridgeReloadStorageArea {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, values); }
  async remove(key: string) { delete this.data[key]; }
}

describe('BridgeReloadHandoff', () => {
  it('hands one target tab across an extension reload exactly once', async () => {
    const storage = new MemoryStorage();
    const handoff = new BridgeReloadHandoff(storage);

    await handoff.arm(17);

    expect(await handoff.consume()).toBe(17);
    expect(await handoff.consume()).toBeUndefined();
  });

  it('clears malformed persisted values without returning a tab', async () => {
    const storage = new MemoryStorage();
    storage.data.flowrunBridgeReloadTabId = '17';
    const handoff = new BridgeReloadHandoff(storage);

    expect(await handoff.consume()).toBeUndefined();
    expect(storage.data.flowrunBridgeReloadTabId).toBeUndefined();
  });
});
