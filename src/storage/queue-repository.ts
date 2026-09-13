import { STORAGE_VERSION } from '../domain/types';
import type { ConversationQueue } from '../domain/types';

const STORAGE_KEY = 'chatgptQueueState';

interface PersistedState {
  version: typeof STORAGE_VERSION;
  queues: Record<string, ConversationQueue>;
}

export interface StorageAreaLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export class UnsupportedStorageVersionError extends Error {
  constructor(version: unknown) {
    super(`Unsupported storage version: ${String(version)}`);
    this.name = 'UnsupportedStorageVersionError';
  }
}

const emptyState = (): PersistedState => ({ version: STORAGE_VERSION, queues: {} });

const isPristinePlaceholder = (queue: ConversationQueue): boolean =>
  queue.items.length === 0
  && queue.status === 'completed'
  && queue.runtime.phase === 'idle'
  && Object.keys(queue.runtime).length === 1
  && queue.owner === undefined
  && queue.blockedReason === undefined;

export class QueueRepository {
  constructor(private readonly storage: StorageAreaLike) {}

  private async load(): Promise<PersistedState> {
    const raw = (await this.storage.get(STORAGE_KEY))[STORAGE_KEY];
    if (raw === undefined) return emptyState();
    if (!raw || typeof raw !== 'object' || !('version' in raw)) {
      throw new UnsupportedStorageVersionError('missing');
    }
    const state = raw as { version?: unknown; queues?: unknown };
    if (state.version !== STORAGE_VERSION || !state.queues || typeof state.queues !== 'object') {
      throw new UnsupportedStorageVersionError(state.version);
    }
    return structuredClone(raw as PersistedState);
  }

  private async save(state: PersistedState): Promise<void> {
    await this.storage.set({ [STORAGE_KEY]: structuredClone(state) });
  }

  async get(conversationKey: string): Promise<ConversationQueue | undefined> {
    const state = await this.load();
    const queue = state.queues[conversationKey];
    return queue ? structuredClone(queue) : undefined;
  }

  async put(queue: ConversationQueue): Promise<void> {
    const state = await this.load();
    state.queues[queue.conversationKey] = structuredClone(queue);
    await this.save(state);
  }

  async list(): Promise<ConversationQueue[]> {
    const state = await this.load();
    return Object.values(state.queues).map((queue) => structuredClone(queue));
  }

  async migrateKey(fromKey: string, toKey: string, now: number): Promise<ConversationQueue> {
    const state = await this.load();
    const source = state.queues[fromKey];
    if (!source) throw new Error(`Queue not found for ${fromKey}`);
    const target = state.queues[toKey];

    if (target) {
      if (isPristinePlaceholder(source)) {
        delete state.queues[fromKey];
        await this.save(state);
        return structuredClone(target);
      }
      if (!isPristinePlaceholder(target)) {
        throw new Error(`Target queue already exists for ${toKey}`);
      }
    }

    const migrated: ConversationQueue = { ...source, conversationKey: toKey, updatedAt: now };
    delete state.queues[fromKey];
    state.queues[toKey] = migrated;
    await this.save(state);
    return structuredClone(migrated);
  }
}

export const chromeStorageArea = (): StorageAreaLike => ({
  get: async (key) => chrome.storage.local.get(key),
  set: async (values) => chrome.storage.local.set(values),
});
