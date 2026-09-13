import { isUsableContextCapacity } from './capacity';
import type { StorageAreaLike } from '../storage/queue-repository';

export const CONTEXT_SETTINGS_KEY = 'chatgptQueueContextSettings';

interface PersistedContextSettings {
  version: 1;
  capacityTokens?: number;
}

const isSettings = (value: unknown): value is PersistedContextSettings => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedContextSettings>;
  return candidate.version === 1
    && (candidate.capacityTokens === undefined || isUsableContextCapacity(candidate.capacityTokens));
};

/**
 * Local context settings.
 *
 * Currently a single explicit capacity override. It exists so the conservative fallback is never
 * the only option: a user who knows their window can make the pressure estimate exact.
 */
export class ContextSettingsRepository {
  constructor(private readonly storage: StorageAreaLike) {}

  async getCapacityTokens(): Promise<number | undefined> {
    const raw = (await this.storage.get(CONTEXT_SETTINGS_KEY))[CONTEXT_SETTINGS_KEY];
    if (raw === undefined) return undefined;
    if (!isSettings(raw)) return undefined;
    return raw.capacityTokens;
  }

  async setCapacityTokens(tokens: number | null): Promise<void> {
    const next: PersistedContextSettings = isUsableContextCapacity(tokens)
      ? { version: 1, capacityTokens: Math.floor(tokens) }
      : { version: 1 };
    await this.storage.set({ [CONTEXT_SETTINGS_KEY]: next });
  }
}
