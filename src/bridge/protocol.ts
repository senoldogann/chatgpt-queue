import { validateWorkflowDocument, type WorkflowDefinition } from '../flowrun/schema';

export const BRIDGE_PROTOCOL_VERSION = 1 as const;
export const NATIVE_HOST_NAME = 'com.senoldogan.flowrun';
export const MAX_BRIDGE_REQUEST_BYTES = 1024 * 1024;
export const DEFAULT_BRIDGE_REQUEST_TTL_MS = 10 * 60 * 1000;

const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TARGET_ID = /^[a-zA-Z0-9][a-zA-Z0-9:._-]{0,127}$/;

export interface BridgeTargetsPayload {}

export interface BridgeRunPayload {
  workflow: WorkflowDefinition;
  inputs: Record<string, string>;
  targetId?: string;
}

export type BridgeJobRequest =
  | {
      version: typeof BRIDGE_PROTOCOL_VERSION;
      jobId: string;
      secret: string;
      kind: 'targets';
      createdAt: number;
      expiresAt: number;
      payload: BridgeTargetsPayload;
    }
  | {
      version: typeof BRIDGE_PROTOCOL_VERSION;
      jobId: string;
      secret: string;
      kind: 'run';
      createdAt: number;
      expiresAt: number;
      payload: BridgeRunPayload;
    };

export type BridgeJobStatus = 'accepted' | 'running' | 'blocked' | 'completed' | 'failed';

export interface BridgeJobRecord {
  version: typeof BRIDGE_PROTOCOL_VERSION;
  jobId: string;
  kind: 'run';
  targetId: string;
  conversationKey: string;
  status: BridgeJobStatus;
  workflowRunId?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BridgeTarget {
  targetId: string;
  provider: 'chatgpt';
  conversationKey: string;
  busy: boolean;
}

export type BridgeJobResult =
  | { version: 1; jobId: string; kind: 'targets'; status: 'completed'; targets: BridgeTarget[]; error?: string }
  | { version: 1; jobId: string; kind: 'run'; status: BridgeJobStatus; record?: BridgeJobRecord; error?: string };

export type BridgeValidationResult =
  | { ok: true; value: BridgeJobRequest }
  | { ok: false; error: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const constantTimeEqual = (left: string, right: string): boolean => {
  const max = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < max; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
};

const serializedByteLength = (value: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return MAX_BRIDGE_REQUEST_BYTES + 1;
  }
};

const validInputs = (value: unknown): value is Record<string, string> =>
  isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

export function validateBridgeRequest(raw: unknown, now: number, expectedSecret: string): BridgeValidationResult {
  if (serializedByteLength(raw) > MAX_BRIDGE_REQUEST_BYTES) {
    return { ok: false, error: 'bridge.request-too-large' };
  }
  if (!isRecord(raw)) return { ok: false, error: 'bridge.invalid-request' };
  if (raw.version !== BRIDGE_PROTOCOL_VERSION) return { ok: false, error: 'bridge.invalid-version' };
  if (typeof raw.jobId !== 'string' || !JOB_ID.test(raw.jobId)) return { ok: false, error: 'bridge.invalid-job-id' };
  if (typeof raw.secret !== 'string' || !constantTimeEqual(raw.secret, expectedSecret)) return { ok: false, error: 'bridge.invalid-secret' };
  if (typeof raw.createdAt !== 'number' || typeof raw.expiresAt !== 'number' || raw.expiresAt <= now || raw.createdAt > raw.expiresAt) {
    return { ok: false, error: 'bridge.expired' };
  }

  if (raw.kind === 'targets') {
    if (!isRecord(raw.payload) || Object.keys(raw.payload).length !== 0) return { ok: false, error: 'bridge.invalid-targets-payload' };
    return { ok: true, value: raw as unknown as BridgeJobRequest };
  }

  if (raw.kind !== 'run' || !isRecord(raw.payload)) return { ok: false, error: 'bridge.invalid-run-payload' };
  const workflow = validateWorkflowDocument(raw.payload.workflow);
  if (!workflow.ok || !validInputs(raw.payload.inputs)) return { ok: false, error: 'bridge.invalid-run-payload' };
  if (raw.payload.targetId !== undefined && (typeof raw.payload.targetId !== 'string' || !TARGET_ID.test(raw.payload.targetId))) {
    return { ok: false, error: 'bridge.invalid-run-payload' };
  }

  return {
    ok: true,
    value: {
      version: BRIDGE_PROTOCOL_VERSION,
      jobId: raw.jobId,
      secret: raw.secret,
      kind: 'run',
      createdAt: raw.createdAt,
      expiresAt: raw.expiresAt,
      payload: {
        workflow: workflow.value,
        inputs: { ...raw.payload.inputs },
        ...(raw.payload.targetId === undefined ? {} : { targetId: raw.payload.targetId as string }),
      },
    },
  };
}
