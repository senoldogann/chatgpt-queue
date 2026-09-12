import type { WorkflowRun } from '../flowrun/events';
import type { WorkflowDefinition } from '../flowrun/schema';
import type { BridgeJobStatus } from './protocol';

export interface BridgeRunJob {
  jobId: string;
  workflow: WorkflowDefinition;
  inputs: Record<string, string>;
}

export interface BridgeJobUpdate {
  status: BridgeJobStatus;
  workflowRunId?: string;
  error?: string;
}

export interface BridgeContentControllerOptions {
  run(
    workflow: WorkflowDefinition,
    inputs: Record<string, string>,
    context: { bridgeJobId: string },
  ): Promise<WorkflowRun>;
  publish(jobId: string, update: BridgeJobUpdate): Promise<void>;
}

const terminalError = (run: WorkflowRun): string | undefined => {
  for (let index = run.steps.length - 1; index >= 0; index -= 1) {
    const error = run.steps[index]?.error;
    if (error) return error;
  }
  return undefined;
};

export async function publishRecoveredBridgeRun(
  run: WorkflowRun,
  publish: (jobId: string, update: BridgeJobUpdate) => Promise<void>,
): Promise<boolean> {
  const jobId = run.browser?.bridgeJobId;
  if (!jobId) return false;

  if (run.status === 'completed') {
    await publish(jobId, { status: 'completed', workflowRunId: run.id });
    return true;
  }
  if (run.status === 'blocked') {
    await publish(jobId, {
      status: 'blocked',
      workflowRunId: run.id,
      error: terminalError(run) ?? 'workflow-blocked',
    });
    return true;
  }
  if (run.status === 'failed') {
    await publish(jobId, {
      status: 'failed',
      workflowRunId: run.id,
      error: terminalError(run) ?? 'workflow-failed',
    });
    return true;
  }
  return false;
}

export class BridgeContentController {
  private readonly active = new Map<string, Promise<void>>();

  constructor(private readonly options: BridgeContentControllerOptions) {}

  accept(job: BridgeRunJob): Promise<void> {
    const existing = this.active.get(job.jobId);
    if (existing) return existing;

    const execution = this.execute(job).finally(() => {
      // Keep a completed promise in the map for the lifetime of the content script.
      // This is a second idempotency layer behind the background job repository.
    });
    this.active.set(job.jobId, execution);
    return execution;
  }

  private async execute(job: BridgeRunJob): Promise<void> {
    await this.options.publish(job.jobId, { status: 'running' });
    try {
      const run = await this.options.run(job.workflow, { ...job.inputs }, { bridgeJobId: job.jobId });
      if (run.status === 'completed') {
        await this.options.publish(job.jobId, { status: 'completed', workflowRunId: run.id });
        return;
      }
      if (run.status === 'blocked') {
        await this.options.publish(job.jobId, {
          status: 'blocked',
          workflowRunId: run.id,
          error: terminalError(run) ?? 'workflow-blocked',
        });
        return;
      }
      await this.options.publish(job.jobId, {
        status: 'failed',
        workflowRunId: run.id,
        error: terminalError(run) ?? `workflow-${run.status}`,
      });
    } catch (error) {
      await this.options.publish(job.jobId, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
