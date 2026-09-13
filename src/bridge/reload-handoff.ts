const BRIDGE_RELOAD_TAB_KEY = 'flowrunBridgeReloadTabId';

export interface BridgeReloadStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export class BridgeReloadHandoff {
  constructor(private readonly storage: BridgeReloadStorageArea) {}

  async arm(tabId: number): Promise<void> {
    await this.storage.set({ [BRIDGE_RELOAD_TAB_KEY]: tabId });
  }

  async consume(): Promise<number | undefined> {
    const raw = (await this.storage.get(BRIDGE_RELOAD_TAB_KEY))[BRIDGE_RELOAD_TAB_KEY];
    if (raw === undefined) return undefined;
    await this.storage.remove(BRIDGE_RELOAD_TAB_KEY);
    return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
  }
}

export const chromeBridgeReloadStorageArea = (): BridgeReloadStorageArea => ({
  get: async (key) => chrome.storage.local.get(key),
  set: async (values) => chrome.storage.local.set(values),
  remove: async (key) => chrome.storage.local.remove(key),
});
