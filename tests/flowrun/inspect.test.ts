import { describe, expect, it } from 'vitest';
import { createDryRunPlan, formatDryRunPlan, formatRunInspection } from '../../src/flowrun/inspect';
import type { WorkflowRun } from '../../src/flowrun/events';
import { validateWorkflowDocument } from '../../src/flowrun/schema';

const workflow = () => {
  const result = validateWorkflowDocument({
    version: 1,
    name: 'dry-plan',
    inputs: { topic: { type: 'string', required: true } },
    steps: [
      { id: 'first', type: 'chat', provider: 'chatgpt', prompt: 'Analyze {{ inputs.topic }}' },
      { id: 'second', type: 'chat', provider: 'chatgpt', prompt: 'Continue from {{ steps.first.output }}' },
    ],
  });
  if (!result.ok) throw new Error('fixture invalid');
  return result.value;
};

describe('FlowRun dry-run and inspection', () => {
  it('creates a deterministic provider-free dry-run plan with synthetic earlier outputs', () => {
    const result = createDryRunPlan(workflow(), { topic: 'queues' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.steps).toEqual([
      { id: 'first', provider: 'chatgpt', prompt: 'Analyze queues' },
      { id: 'second', provider: 'chatgpt', prompt: 'Continue from <output:first>' },
    ]);
    expect(formatDryRunPlan(result.value)).toContain('second [chatgpt]');
    expect(formatDryRunPlan(result.value)).toContain('Continue from <output:first>');
  });

  it('returns input validation errors instead of inventing values', () => {
    const result = createDryRunPlan(workflow(), {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('input.missing_required');
  });

  it('formats run status, step states, and ordered receipt timeline', () => {
    const run: WorkflowRun = {
      id: 'run-1',
      workflowName: 'review-pr',
      workflowVersion: 1,
      status: 'completed',
      inputs: { topic: 'queues' },
      steps: [
        { id: 'first', status: 'completed', output: 'done', dispatchToken: 'dispatch-1' },
      ],
      events: [
        { id: 'e1', runId: 'run-1', at: 100, kind: 'run.created', data: {} },
        { id: 'e2', runId: 'run-1', at: 110, kind: 'step.dispatch_reserved', stepId: 'first', data: { dispatchToken: 'dispatch-1' } },
        { id: 'e3', runId: 'run-1', at: 120, kind: 'run.completed', data: {} },
      ],
      createdAt: 100,
      updatedAt: 120,
    };

    const text = formatRunInspection(run);
    expect(text).toContain('review-pr');
    expect(text).toContain('Status: completed');
    expect(text).toContain('first: completed');
    expect(text.indexOf('run.created')).toBeLessThan(text.indexOf('step.dispatch_reserved'));
    expect(text.indexOf('step.dispatch_reserved')).toBeLessThan(text.indexOf('run.completed'));
  });
});
