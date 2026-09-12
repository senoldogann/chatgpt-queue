import { createRunEvent, type WorkflowRun } from './events';

export const FLOWRUN_STORAGE_KEY = 'flowrunState';
export const MAX_FLOWRUN_HISTORY = 20;

interface PersistedFlowRunState {
  version: 1;
  runs: Record<string, WorkflowRun>;
  order: string[];
}

export interface FlowRunStorageArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
}

export interface InterruptedRecoveryHelpers {
  now(): number;
  idFactory(): string;
}

const emptyState = (): PersistedFlowRunState => ({ version: 1, runs: {}, order: [] });

const isState = (value: unknown): value is PersistedFlowRunState => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<PersistedFlowRunState>;
  return candidate.version === 1
    && Boolean(candidate.runs)
    && typeof candidate.runs === 'object'
    && Array.isArray(candidate.order);
};

export class FlowRunRunRepository {
  constructor(private readonly storage: FlowRunStorageArea) {}

  private async load(): Promise<PersistedFlowRunState> {
    const raw = (await this.storage.get(FLOWRUN_STORAGE_KEY))[FLOWRUN_STORAGE_KEY];
    if (raw === undefined) return emptyState();
    if (!isState(raw)) throw new Error('unsupported-flowrun-storage-version');
    return structuredClone(raw);
  }

  private async save(state: PersistedFlowRunState): Promise<void> {
    await this.storage.set({ [FLOWRUN_STORAGE_KEY]: structuredClone(state) });
  }

  async get(runId: string): Promise<WorkflowRun | undefined> {
    const state = await this.load();
    const value = state.runs[runId];
    return value ? structuredClone(value) : undefined;
  }

  async list(): Promise<WorkflowRun[]> {
    const state = await this.load();
    return state.order
      .map((runId) => state.runs[runId])
      .filter((run): run is WorkflowRun => Boolean(run))
      .map((run) => structuredClone(run));
  }

  async put(run: WorkflowRun): Promise<void> {
    const state = await this.load();
    state.runs[run.id] = structuredClone(run);
    state.order = state.order.filter((runId) => runId !== run.id);
    state.order.push(run.id);

    while (state.order.length > MAX_FLOWRUN_HISTORY) {
      const removed = state.order.shift();
      if (removed) delete state.runs[removed];
    }

    await this.save(state);
  }

  async latestForConversation(conversationKey: string): Promise<WorkflowRun | undefined> {
    const state = await this.load();
    for (let index = state.order.length - 1; index >= 0; index -= 1) {
      const run = state.runs[state.order[index]!];
      if (run?.browser?.conversationKey === conversationKey) return structuredClone(run);
    }
    return undefined;
  }

  async blockInterruptedForConversation(
    conversationKey: string,
    helpers: InterruptedRecoveryHelpers,
  ): Promise<WorkflowRun | undefined> {
    const run = await this.latestForConversation(conversationKey);
    if (!run || run.status !== 'running') return run;

    const at = helpers.now();
    const active = run.steps.find((step) => ['ready', 'dispatching', 'waiting'].includes(step.status));
    if (active) {
      active.status = 'blocked';
      active.error = 'browser-session-interrupted';
    }
    run.status = 'blocked';
    run.updatedAt = at;
    run.events.push(createRunEvent({
      id: helpers.idFactory(),
      runId: run.id,
      at,
      kind: 'run.blocked',
      data: { reason: 'browser-session-interrupted' },
    }));
    await this.put(run);
    return structuredClone(run);
  }
}

export const chromeFlowRunStorageArea = (): FlowRunStorageArea => ({
  get: async (key) => chrome.storage.local.get(key),
  set: async (values) => chrome.storage.local.set(values),
});
