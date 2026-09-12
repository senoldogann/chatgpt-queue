import { NATIVE_HOST_NAME, type BridgeJobRecord, type BridgeJobRequest, type BridgeJobResult, validateBridgeRequest } from './protocol';
import { BridgeJobRepository } from './job-repository';
import { TargetRegistry } from './target-registry';

export interface NativePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export type NativeBridgeState = 'disabled' | 'disconnected' | 'connected';

export interface NativeBridgeServiceDependencies {
  hasPermission(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  connectNative(name: string): NativePortLike;
  repository: BridgeJobRepository;
  registry: TargetRegistry;
  routeToTab(tabId: number, message: unknown): Promise<unknown>;
  now?: () => number;
  consumeLastError?: () => void;
  scheduleReconnect?: (callback: () => Promise<void>) => void;
}

const isHello = (value: unknown): value is { type: 'bridge.hello'; version: 1; secret: string } => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.type === 'bridge.hello'
    && candidate.version === 1
    && typeof candidate.secret === 'string'
    && /^[a-f0-9]{64}$/i.test(candidate.secret);
};

const requestIdentity = (raw: unknown): { jobId?: string; kind?: 'targets' | 'run' } => {
  if (!raw || typeof raw !== 'object') return {};
  const candidate = raw as Record<string, unknown>;
  const jobId = typeof candidate.jobId === 'string' ? candidate.jobId : undefined;
  const kind = candidate.kind === 'targets' || candidate.kind === 'run' ? candidate.kind : undefined;
  return { ...(jobId ? { jobId } : {}), ...(kind ? { kind } : {}) };
};

export class NativeBridgeService {
  private port: NativePortLike | undefined;
  private bridgeState: NativeBridgeState = 'disconnected';
  private expectedSecret: string | undefined;
  private readonly now: () => number;
  private reconnectScheduled = false;

  constructor(private readonly deps: NativeBridgeServiceDependencies) {
    this.now = deps.now ?? (() => Date.now());
  }

  state(): NativeBridgeState {
    return this.bridgeState;
  }

  async ensureConnected(): Promise<boolean> {
    if (this.port) return true;
    if (!await this.deps.hasPermission()) {
      this.bridgeState = 'disabled';
      return false;
    }
    try {
      const port = this.deps.connectNative(NATIVE_HOST_NAME);
      this.port = port;
      this.bridgeState = 'disconnected';
      this.expectedSecret = undefined;
      port.onMessage.addListener((message) => { void this.handleHostMessage(message); });
      port.onDisconnect.addListener(() => {
        if (this.port !== port) return;
        this.deps.consumeLastError?.();
        this.port = undefined;
        this.expectedSecret = undefined;
        this.bridgeState = 'disconnected';
        if (this.reconnectScheduled) return;
        this.reconnectScheduled = true;
        const reconnect = async () => {
          this.reconnectScheduled = false;
          await this.ensureConnected();
        };
        if (this.deps.scheduleReconnect) this.deps.scheduleReconnect(reconnect);
        else setTimeout(() => { void reconnect(); }, 1_000);
      });
      return true;
    } catch {
      this.bridgeState = 'disconnected';
      return false;
    }
  }

  async enable(): Promise<boolean> {
    const granted = await this.deps.requestPermission();
    if (!granted) {
      this.bridgeState = 'disabled';
      return false;
    }
    return this.ensureConnected();
  }

  async handleHostMessage(raw: unknown): Promise<void> {
    if (isHello(raw)) {
      this.expectedSecret = raw.secret;
      this.bridgeState = 'connected';
      return;
    }
    const identity = requestIdentity(raw);
    if (!this.expectedSecret) {
      this.postError(identity.jobId, identity.kind, 'bridge.handshake-required');
      return;
    }

    // Authenticate and structurally validate first, but defer TTL rejection for run jobs
    // until after idempotent lookup. Accepted jobs remain replayable after request expiry.
    const validated = validateBridgeRequest(raw, this.now(), this.expectedSecret, { allowExpired: true });
    if (!validated.ok) {
      this.postError(identity.jobId, identity.kind, validated.error);
      return;
    }
    const request = validated.value;

    if (request.kind === 'targets') {
      if (request.expiresAt <= this.now()) {
        this.postError(request.jobId, 'targets', 'bridge.expired');
        return;
      }
      this.port?.postMessage({
        version: 1,
        jobId: request.jobId,
        kind: 'targets',
        status: 'completed',
        targets: this.deps.registry.list(this.now()),
      } satisfies BridgeJobResult);
      return;
    }

    const existing = await this.deps.repository.get(request.jobId);
    if (existing) {
      this.postRecord(existing);
      return;
    }
    if (request.expiresAt <= this.now()) {
      this.postError(request.jobId, 'run', 'bridge.expired');
      return;
    }
    await this.acceptRun(request);
  }

  async publishJobUpdate(
    jobId: string,
    patch: Partial<Pick<BridgeJobRecord, 'status' | 'workflowRunId' | 'error' | 'updatedAt'>>,
  ): Promise<BridgeJobRecord> {
    const record = await this.deps.repository.update(jobId, { ...patch, updatedAt: patch.updatedAt ?? this.now() });
    this.postRecord(record);
    return record;
  }

  private async acceptRun(request: Extract<BridgeJobRequest, { kind: 'run' }>): Promise<void> {
    const targetId = request.payload.targetId;
    if (!targetId) {
      this.postError(request.jobId, 'run', 'bridge.target-required');
      return;
    }
    const target = this.deps.registry.resolve(targetId, this.now());
    if (!target) {
      if (await this.postExistingIfPresent(request.jobId)) return;
      this.postError(request.jobId, 'run', 'bridge.target-unavailable');
      return;
    }
    if (target.busy) {
      if (await this.postExistingIfPresent(request.jobId)) return;
      this.postError(request.jobId, 'run', 'bridge.target-busy');
      return;
    }

    const at = this.now();
    let accepted: { record: BridgeJobRecord; created: boolean };
    try {
      accepted = await this.deps.repository.accept({
        version: 1,
        jobId: request.jobId,
        kind: 'run',
        targetId,
        conversationKey: target.conversationKey,
        ownerTabId: target.tabId,
        status: 'accepted',
        createdAt: at,
        updatedAt: at,
      });
    } catch (error) {
      this.postError(request.jobId, 'run', error instanceof Error ? error.message : String(error));
      return;
    }
    this.postRecord(accepted.record);
    if (!accepted.created) return;

    try {
      const routed = await this.deps.routeToTab(target.tabId, {
        type: 'bridgeRun',
        jobId: request.jobId,
        targetId,
        workflow: request.payload.workflow,
        inputs: request.payload.inputs,
      });
      if (routed && typeof routed === 'object' && 'ok' in routed && (routed as { ok?: boolean }).ok === false) {
        const error = 'error' in routed ? String((routed as { error?: unknown }).error ?? 'bridge.route-failed') : 'bridge.route-failed';
        await this.publishJobUpdate(request.jobId, { status: 'failed', error });
      }
    } catch (error) {
      await this.publishJobUpdate(request.jobId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async postExistingIfPresent(jobId: string): Promise<boolean> {
    const existing = await this.deps.repository.get(jobId);
    if (!existing) return false;
    this.postRecord(existing);
    return true;
  }

  private postRecord(record: BridgeJobRecord): void {
    this.port?.postMessage({
      version: 1,
      jobId: record.jobId,
      kind: 'run',
      status: record.status,
      record,
    } satisfies BridgeJobResult);
  }

  private postError(jobId: string | undefined, kind: 'targets' | 'run' | undefined, error: string): void {
    if (!jobId) return;
    if (kind === 'targets') {
      this.port?.postMessage({ version: 1, jobId, kind: 'targets', status: 'completed', targets: [], error });
      return;
    }
    this.port?.postMessage({ version: 1, jobId, kind: 'run', status: 'failed', error } satisfies BridgeJobResult);
  }
}
