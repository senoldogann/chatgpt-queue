import type { WorkflowDefinition } from '../flowrun/schema';

export type BackgroundRequest =
  | { type: 'ensure'; key: string }
  | { type: 'get'; key: string }
  | { type: 'add'; key: string; messages: string[] }
  | { type: 'edit'; key: string; itemId: string; content: string }
  | { type: 'delete'; key: string; itemId: string }
  | { type: 'reorder'; key: string; itemId: string; queuedIndex: number }
  | { type: 'claim'; key: string }
  | { type: 'heartbeat'; key: string }
  | { type: 'start'; key: string }
  | { type: 'pause'; key: string }
  | { type: 'recover'; key: string }
  | { type: 'reserve'; key: string; baselineAssistantCount: number; baselineAssistantTurnKey?: string }
  | { type: 'generationStarted'; key: string; itemId: string; dispatchToken: string; controlObserved: boolean }
  | { type: 'waitingStable'; key: string; itemId: string; dispatchToken: string }
  | { type: 'complete'; key: string; itemId: string; dispatchToken: string }
  | { type: 'block'; key: string; reason: string }
  | { type: 'migrate'; fromKey: string; toKey: string };

export type BridgeControlRequest =
  | {
      type: 'bridgeRegister';
      conversationKey: string;
      queueStatus: 'idle' | 'running' | 'paused' | 'blocked' | 'completed';
      workflowStatus?: 'pending' | 'running' | 'blocked' | 'completed' | 'failed';
      busy: boolean;
    }
  | { type: 'bridgeState' }
  | { type: 'bridgeEnable' }
  | {
      type: 'bridgeJobUpdate';
      jobId: string;
      status: 'accepted' | 'running' | 'blocked' | 'completed' | 'failed';
      workflowRunId?: string;
      error?: string;
    };

export interface BridgeRunMessage {
  type: 'bridgeRun';
  jobId: string;
  targetId: string;
  workflow: WorkflowDefinition;
  inputs: Record<string, string>;
}

export type ExtensionRequest = BackgroundRequest | BridgeControlRequest;

export interface BackgroundEnvelope {
  ok: boolean;
  data?: unknown;
  error?: string;
}
