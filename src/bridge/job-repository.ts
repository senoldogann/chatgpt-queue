import type { BridgeJobRecord } from './protocol';

export const BRIDGE_JOB_STORAGE_KEY = 'flowrunBridgeJobs';
export const MAX_BRIDGE_JOB_HISTORY = 50;

interface BridgeJobStoreState {
  version: 1;
  jobs: Record<string, BridgeJobRecord>;
  order: string[];
}

export interface BridgeStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

const emptyState = (): BridgeJobStoreState => ({ version: 1, jobs: {}, order: [] });

const isState = (value: unknown): value is BridgeJobStoreState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BridgeJobStoreState>;
  return candidate.version === 1
    && Boolean(candidate.jobs)
    && typeof candidate.jobs === 'object'
    && Array.isArray(candidate.order);
};

export class BridgeJobRepository {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly storage: BridgeStorageArea) {}

  private async load(): Promise<BridgeJobStoreState> {
    const raw = (await this.storage.get(BRIDGE_JOB_STORAGE_KEY))[BRIDGE_JOB_STORAGE_KEY];
    if (raw === undefined) return emptyState();
    if (!isState(raw)) throw new Error('unsupported-bridge-job-storage-version');
    return structuredClone(raw);
  }

  private async save(state: BridgeJobStoreState): Promise<void> {
    await this.storage.set({ [BRIDGE_JOB_STORAGE_KEY]: structuredClone(state) });
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationTail.then(operation, operation);
    this.mutationTail = run.then(() => undefined, () => undefined);
    return run;
  }

  async get(jobId: string): Promise<BridgeJobRecord | undefined> {
    const state = await this.load();
    const record = state.jobs[jobId];
    return record ? structuredClone(record) : undefined;
  }

  async list(): Promise<BridgeJobRecord[]> {
    const state = await this.load();
    return state.order
      .map((jobId) => state.jobs[jobId])
      .filter((record): record is BridgeJobRecord => Boolean(record))
      .map((record) => structuredClone(record));
  }

  async accept(record: BridgeJobRecord): Promise<{ record: BridgeJobRecord; created: boolean }> {
    return this.exclusive(async () => {
      const state = await this.load();
      const existing = state.jobs[record.jobId];
      if (existing) return { record: structuredClone(existing), created: false };

      state.jobs[record.jobId] = structuredClone(record);
      state.order.push(record.jobId);
      while (state.order.length > MAX_BRIDGE_JOB_HISTORY) {
        const removed = state.order.shift();
        if (removed) delete state.jobs[removed];
      }
      await this.save(state);
      return { record: structuredClone(record), created: true };
    });
  }

  async bindOwner(jobId: string, ownerTabId: number): Promise<BridgeJobRecord> {
    return this.exclusive(async () => {
      const state = await this.load();
      const existing = state.jobs[jobId];
      if (!existing) throw new Error('bridge-job-not-found');
      if (existing.ownerTabId !== undefined && existing.ownerTabId !== ownerTabId) {
        throw new Error('bridge-target-owner-mismatch');
      }
      if (existing.ownerTabId === ownerTabId) return structuredClone(existing);
      const updated: BridgeJobRecord = { ...existing, ownerTabId };
      state.jobs[jobId] = updated;
      await this.save(state);
      return structuredClone(updated);
    });
  }

  async update(
    jobId: string,
    patch: Partial<Pick<BridgeJobRecord, 'status' | 'workflowRunId' | 'error' | 'updatedAt'>>,
  ): Promise<BridgeJobRecord> {
    return this.exclusive(async () => {
      const state = await this.load();
      const existing = state.jobs[jobId];
      if (!existing) throw new Error('bridge-job-not-found');
      const updated: BridgeJobRecord = { ...existing, ...patch };
      state.jobs[jobId] = updated;
      await this.save(state);
      return structuredClone(updated);
    });
  }
}

export const chromeBridgeStorageArea = (): BridgeStorageArea => ({
  get: async (key) => chrome.storage.local.get(key),
  set: async (values) => chrome.storage.local.set(values),
});
