import type { StorageAreaLike } from '../storage/queue-repository';

export const HANDOFF_STORAGE_KEY = 'chatgptQueueHandoff';

/** Bounded so re-processing an old handoff item after a reload stays cheap and finite. */
export const MAX_PROCESSED_HANDOFF_ITEMS = 20;

export interface HandoffRecord {
  version: 1;
  id: string;
  sourceConversationKey: string;
  brief: string;
  carriedItems: string[];
  createdAt: number;
}

interface ConsumedHandoff {
  id: string;
  consumedByConversationKey: string;
  consumedAt: number;
}

interface PersistedHandoffState {
  version: 1;
  pending?: HandoffRecord;
  consumed: ConsumedHandoff[];
  processedItems: string[];
}

export interface HandoffCaptureInput {
  itemId: string;
  sourceConversationKey: string;
  brief: string;
  carriedItems: string[];
  now: number;
  idFactory: () => string;
}

export type HandoffCaptureResult =
  | { ok: true; record: HandoffRecord }
  | { ok: false; reason: 'already-captured' | 'invalid' };

export const emptyHandoffState = (): PersistedHandoffState => ({
  version: 1,
  consumed: [],
  processedItems: [],
});

const isRecord = (value: unknown): value is HandoffRecord => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<HandoffRecord>;
  return candidate.version === 1
    && typeof candidate.id === 'string'
    && typeof candidate.sourceConversationKey === 'string'
    && typeof candidate.brief === 'string'
    && Array.isArray(candidate.carriedItems)
    && candidate.carriedItems.every((item) => typeof item === 'string')
    && typeof candidate.createdAt === 'number';
};

const isState = (value: unknown): value is PersistedHandoffState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedHandoffState>;
  return candidate.version === 1
    && (candidate.pending === undefined || isRecord(candidate.pending))
    && Array.isArray(candidate.consumed)
    && Array.isArray(candidate.processedItems)
    && candidate.processedItems.every((item) => typeof item === 'string');
};

/**
 * Durable, bounded handoff state.
 *
 * At most one handoff is pending: preparing a second one replaces the first instead of growing an
 * unbounded queue of briefs. Captures are keyed by the completed queue item that produced them, so
 * a page reload cannot re-arm a handoff that the new conversation already imported.
 */
export class HandoffRepository {
  constructor(private readonly storage: StorageAreaLike) {}

  private async load(): Promise<PersistedHandoffState> {
    const raw = (await this.storage.get(HANDOFF_STORAGE_KEY))[HANDOFF_STORAGE_KEY];
    if (raw === undefined) return emptyHandoffState();
    if (!isState(raw)) throw new Error('unsupported-handoff-storage-version');
    return structuredClone(raw);
  }

  private async save(state: PersistedHandoffState): Promise<void> {
    await this.storage.set({ [HANDOFF_STORAGE_KEY]: structuredClone(state) });
  }

  async getPending(): Promise<HandoffRecord | undefined> {
    const state = await this.load();
    return state.pending ? structuredClone(state.pending) : undefined;
  }

  async getConsumed(): Promise<ConsumedHandoff[]> {
    const state = await this.load();
    return structuredClone(state.consumed);
  }

  async capture(input: HandoffCaptureInput): Promise<HandoffCaptureResult> {
    const brief = input.brief.trim();
    const carriedItems = input.carriedItems.map((item) => item.trim()).filter(Boolean);
    if (!brief) return { ok: false, reason: 'invalid' };

    const state = await this.load();
    if (state.processedItems.includes(input.itemId)) return { ok: false, reason: 'already-captured' };

    const record: HandoffRecord = {
      version: 1,
      id: input.idFactory(),
      sourceConversationKey: input.sourceConversationKey,
      brief,
      carriedItems,
      createdAt: input.now,
    };
    state.pending = record;
    state.processedItems = [...state.processedItems, input.itemId].slice(-MAX_PROCESSED_HANDOFF_ITEMS);
    await this.save(state);
    return { ok: true, record };
  }

  async consume(id: string, conversationKey: string, now: number): Promise<HandoffRecord | undefined> {
    const state = await this.load();
    const pending = state.pending;
    if (!pending || pending.id !== id) return undefined;
    delete state.pending;
    state.consumed = [...state.consumed, { id, consumedByConversationKey: conversationKey, consumedAt: now }].slice(-1);
    await this.save(state);
    return structuredClone(pending);
  }
}

export const chromeHandoffStorageArea = (): StorageAreaLike => ({
  get: async (key) => chrome.storage.local.get(key),
  set: async (values) => chrome.storage.local.set(values),
});
