export interface ProviderReceipt {
  provider: string;
  dispatchToken: string;
  startedAt?: number;
  completedAt?: number;
  conversationKey?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ChatExecutionRequest {
  runId: string;
  stepId: string;
  prompt: string;
  dispatchToken: string;
}

export type ChatExecutionResult =
  | { kind: 'completed'; output: string; receipt: ProviderReceipt }
  | { kind: 'blocked'; reason: string; receipt?: ProviderReceipt };

export interface ChatProvider {
  readonly id: string;
  execute(request: ChatExecutionRequest): Promise<ChatExecutionResult>;
}
