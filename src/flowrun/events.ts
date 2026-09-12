import type { ProviderReceipt } from './provider';

export type WorkflowRunStatus = 'pending' | 'running' | 'blocked' | 'completed' | 'failed';
export type StepRunStatus = 'pending' | 'ready' | 'dispatching' | 'waiting' | 'completed' | 'blocked' | 'failed';

export type RunEventKind =
  | 'run.created'
  | 'run.started'
  | 'step.ready'
  | 'step.dispatch_reserved'
  | 'step.dispatch_confirmed'
  | 'step.output_captured'
  | 'step.assertion_passed'
  | 'step.assertion_failed'
  | 'step.completed'
  | 'run.blocked'
  | 'run.failed'
  | 'run.completed';

export interface RunEvent {
  id: string;
  runId: string;
  at: number;
  kind: RunEventKind;
  stepId?: string;
  data: Record<string, unknown>;
}

export interface StepRun {
  id: string;
  status: StepRunStatus;
  prompt?: string;
  output?: string;
  dispatchToken?: string;
  receipt?: ProviderReceipt;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  workflowVersion: 1;
  status: WorkflowRunStatus;
  inputs: Record<string, string>;
  steps: StepRun[];
  events: RunEvent[];
  browser?: {
    conversationKey: string;
  };
  createdAt: number;
  updatedAt: number;
}

export function createRunEvent(event: RunEvent): RunEvent {
  return {
    id: event.id,
    runId: event.runId,
    at: event.at,
    kind: event.kind,
    ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
    data: { ...event.data },
  };
}
