export const STORAGE_VERSION = 1 as const;
export const MAX_QUEUE_ITEMS = 50;

export type QueueStatus = 'idle' | 'running' | 'paused' | 'blocked' | 'completed';
export type QueueItemState = 'queued' | 'sending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RuntimePhase =
  | 'idle'
  | 'ready_to_send'
  | 'sending'
  | 'waiting_generation_start'
  | 'generating'
  | 'waiting_stable_completion'
  | 'completed_current_item'
  | 'ready_to_send_next'
  | 'paused'
  | 'blocked';

export interface QueueItem {
  id: string;
  content: string;
  state: QueueItemState;
  createdAt: number;
  updatedAt: number;
  dispatchToken?: string;
  sendAttemptedAt?: number;
  startedAt?: number;
  completedAt?: number;
}

export interface ConversationOwner {
  tabId: number;
  leaseId: string;
  heartbeatAt: number;
  expiresAt: number;
}

export interface QueueRuntime {
  phase: RuntimePhase;
  activeItemId?: string;
  baselineAssistantCount?: number;
  generationObserved?: boolean;
}

export interface ConversationQueue {
  version: typeof STORAGE_VERSION;
  id: string;
  conversationKey: string;
  status: QueueStatus;
  items: QueueItem[];
  owner?: ConversationOwner;
  runtime: QueueRuntime;
  blockedReason?: string;
  createdAt: number;
  updatedAt: number;
}

export interface PageSnapshot {
  domRecognized: boolean;
  isGenerating: boolean;
  composerReady: boolean;
  sendControlPresent: boolean;
  assistantMessageCount: number;
  assistantCompletionControlPresent: boolean;
  domStable: boolean;
  confirmationVisible: boolean;
  blockingReason: string | null;
}

export type RuntimeDecision =
  | { action: 'send' }
  | { action: 'generation_started'; controlObserved: boolean }
  | { action: 'wait_for_stability' }
  | { action: 'complete' }
  | { action: 'wait' }
  | { action: 'block'; reason: string };
