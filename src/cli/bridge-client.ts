import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { BridgeMailbox } from '../bridge/mailbox';
import { bridgePaths } from '../bridge/install';
import { BRIDGE_PROTOCOL_VERSION, DEFAULT_BRIDGE_REQUEST_TTL_MS, type BridgeJobRequest, type BridgeJobResult, type BridgeTarget } from '../bridge/protocol';
import type { WorkflowDefinition } from '../flowrun/schema';

interface BridgeConfig {
  version: 1;
  secret: string;
  bridgeRoot: string;
  extensionId: string;
}

export interface SubmitRunArgs {
  workflow: WorkflowDefinition;
  inputs: Record<string, string>;
  targetId: string;
}

export interface BridgeCliApi {
  listTargets(): Promise<BridgeTarget[]>;
  submitRun(args: SubmitRunArgs): Promise<{ jobId: string; result: BridgeJobResult }>;
  follow(jobId: string): Promise<BridgeJobResult>;
  status(jobId: string): Promise<BridgeJobResult | undefined>;
}

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isResult = (value: unknown, jobId: string): value is BridgeJobResult => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 && candidate.jobId === jobId && typeof candidate.kind === 'string' && typeof candidate.status === 'string';
};

export class NodeBridgeClient implements BridgeCliApi {
  constructor(
    private readonly mailbox: BridgeMailbox,
    private readonly secret: string,
    private readonly now: () => number = () => Date.now(),
    private readonly idFactory: () => string = () => randomUUID(),
    private readonly sleep: (ms: number) => Promise<void> = sleepDefault,
  ) {}

  static async fromHome(homeDir: string): Promise<NodeBridgeClient> {
    const config = JSON.parse(await readFile(bridgePaths(homeDir).configPath, 'utf8')) as BridgeConfig;
    if (config.version !== 1 || typeof config.secret !== 'string' || typeof config.bridgeRoot !== 'string') {
      throw new Error('bridge.invalid-config');
    }
    return new NodeBridgeClient(new BridgeMailbox(config.bridgeRoot), config.secret);
  }

  private requestBase(kind: 'targets' | 'run') {
    const createdAt = this.now();
    return {
      version: BRIDGE_PROTOCOL_VERSION,
      jobId: this.idFactory(),
      secret: this.secret,
      kind,
      createdAt,
      expiresAt: createdAt + DEFAULT_BRIDGE_REQUEST_TTL_MS,
    } as const;
  }

  private async waitForObserved(jobId: string, timeoutMs: number): Promise<BridgeJobResult> {
    const deadline = this.now() + timeoutMs;
    let seenEvents = 0;
    while (this.now() <= deadline) {
      const result = await this.mailbox.readResult(jobId);
      if (isResult(result, jobId)) return result;
      const events = await this.mailbox.readEvents(jobId);
      for (let index = seenEvents; index < events.length; index += 1) {
        const event = events[index];
        if (isResult(event, jobId)) return event;
      }
      seenEvents = events.length;
      await this.sleep(100);
    }
    throw new Error('bridge-response-timeout');
  }

  async listTargets(): Promise<BridgeTarget[]> {
    const base = this.requestBase('targets');
    const request: BridgeJobRequest = { ...base, kind: 'targets', payload: {} };
    await this.mailbox.submit(request);
    const result = await this.waitForObserved(request.jobId, 5_000);
    if (result.kind !== 'targets' || result.status !== 'completed') throw new Error('bridge-targets-failed');
    return result.targets;
  }

  async submitRun(args: SubmitRunArgs): Promise<{ jobId: string; result: BridgeJobResult }> {
    const base = this.requestBase('run');
    const request: BridgeJobRequest = {
      ...base,
      kind: 'run',
      payload: { workflow: args.workflow, inputs: { ...args.inputs }, targetId: args.targetId },
    };
    await this.mailbox.submit(request);
    const result = await this.waitForObserved(request.jobId, 10_000);
    return { jobId: request.jobId, result };
  }

  async follow(jobId: string): Promise<BridgeJobResult> {
    const terminal = new Set(['completed', 'blocked', 'failed']);
    while (true) {
      const result = await this.mailbox.readResult(jobId);
      if (isResult(result, jobId) && terminal.has(result.status)) return result;
      await this.sleep(250);
    }
  }

  async status(jobId: string): Promise<BridgeJobResult | undefined> {
    const result = await this.mailbox.readResult(jobId);
    if (isResult(result, jobId)) return result;
    const events = await this.mailbox.readEvents(jobId);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (isResult(event, jobId)) return event;
    }
    return undefined;
  }
}
