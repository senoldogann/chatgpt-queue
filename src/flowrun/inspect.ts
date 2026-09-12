import type { WorkflowRun } from './events';
import type { ValidationResult, WorkflowDefinition } from './schema';
import { renderPrompt, validateRunInputs } from './template';

export interface DryRunStep {
  id: string;
  provider: string;
  prompt: string;
}

export interface DryRunPlan {
  workflowName: string;
  inputs: Record<string, string>;
  steps: DryRunStep[];
}

export function createDryRunPlan(
  workflow: WorkflowDefinition,
  inputs: Record<string, string>,
): ValidationResult<DryRunPlan> {
  const validatedInputs = validateRunInputs(workflow, inputs);
  if (!validatedInputs.ok) return validatedInputs;

  const syntheticOutputs: Record<string, { output: string }> = {};
  const steps: DryRunStep[] = [];

  for (const step of workflow.steps) {
    const rendered = renderPrompt(step.prompt, {
      inputs: validatedInputs.value,
      steps: syntheticOutputs,
    });
    if (!rendered.ok) return rendered;

    steps.push({ id: step.id, provider: step.provider, prompt: rendered.value });
    syntheticOutputs[step.id] = { output: `<output:${step.id}>` };
  }

  return {
    ok: true,
    value: {
      workflowName: workflow.name,
      inputs: validatedInputs.value,
      steps,
    },
  };
}

export function formatDryRunPlan(plan: DryRunPlan): string {
  const lines = [`Workflow: ${plan.workflowName}`, `Steps: ${plan.steps.length}`];
  for (const step of plan.steps) {
    lines.push('', `${step.id} [${step.provider}]`, step.prompt);
  }
  return lines.join('\n');
}

export function formatRunInspection(run: WorkflowRun): string {
  const lines = [
    `Run: ${run.id}`,
    `Workflow: ${run.workflowName}`,
    `Status: ${run.status}`,
    '',
    'Steps:',
  ];

  for (const step of run.steps) {
    lines.push(`- ${step.id}: ${step.status}`);
  }

  lines.push('', 'Events:');
  for (const event of run.events) {
    lines.push(`- ${event.at} ${event.kind}${event.stepId ? ` [${event.stepId}]` : ''}`);
  }

  return lines.join('\n');
}
