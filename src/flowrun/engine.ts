import { evaluateAssertions } from './assertions';
import { createRunEvent } from './events';
import type { RunEvent, WorkflowRun } from './events';
import type { ChatProvider } from './provider';
import type { WorkflowDefinition } from './schema';
import { renderPrompt, validateRunInputs } from './template';

export interface ExecuteWorkflowOptions {
  idFactory?: (prefix: string) => string;
  now?: () => number;
  onEvent?: (event: RunEvent) => void;
}

const defaultIdFactory = (prefix: string): string => `${prefix}:${crypto.randomUUID()}`;
const defaultNow = (): number => Date.now();

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  inputs: Record<string, string>,
  providers: Record<string, ChatProvider>,
  options: ExecuteWorkflowOptions = {},
): Promise<WorkflowRun> {
  const idFactory = options.idFactory ?? defaultIdFactory;
  const now = options.now ?? defaultNow;
  const runId = idFactory('run');
  const createdAt = now();

  const run: WorkflowRun = {
    id: runId,
    workflowName: workflow.name,
    workflowVersion: 1,
    status: 'pending',
    inputs: { ...inputs },
    steps: workflow.steps.map((step) => ({ id: step.id, status: 'pending' })),
    events: [],
    createdAt,
    updatedAt: createdAt,
  };

  const emit = (kind: RunEvent['kind'], stepId: string | undefined, data: Record<string, unknown>): void => {
    const at = now();
    const event = createRunEvent({
      id: idFactory('event'),
      runId,
      at,
      kind,
      ...(stepId === undefined ? {} : { stepId }),
      data,
    });
    run.events.push(event);
    run.updatedAt = at;
    options.onEvent?.(event);
  };

  emit('run.created', undefined, { workflowName: workflow.name });

  const validatedInputs = validateRunInputs(workflow, inputs);
  if (!validatedInputs.ok) {
    run.status = 'failed';
    emit('run.failed', undefined, { reason: 'invalid-inputs', errors: validatedInputs.errors });
    return run;
  }

  run.status = 'running';
  emit('run.started', undefined, {});

  const outputs: Record<string, { output: string }> = {};

  for (let index = 0; index < workflow.steps.length; index += 1) {
    const definition = workflow.steps[index]!;
    const step = run.steps[index]!;

    const rendered = renderPrompt(definition.prompt, { inputs: validatedInputs.value, steps: outputs });
    if (!rendered.ok) {
      step.status = 'failed';
      step.error = rendered.errors.map((error) => error.message).join('; ');
      run.status = 'failed';
      emit('run.failed', definition.id, { reason: 'template-error', errors: rendered.errors });
      return run;
    }

    step.status = 'ready';
    step.prompt = rendered.value;
    emit('step.ready', definition.id, { promptLength: rendered.value.length });

    const provider = providers[definition.provider];
    if (!provider) {
      step.status = 'failed';
      step.error = `Provider unavailable: ${definition.provider}`;
      run.status = 'failed';
      emit('run.failed', definition.id, { reason: 'provider-unavailable', provider: definition.provider });
      return run;
    }

    const dispatchToken = idFactory('dispatch');
    step.status = 'dispatching';
    step.dispatchToken = dispatchToken;
    emit('step.dispatch_reserved', definition.id, {
      provider: definition.provider,
      dispatchToken,
    });

    step.status = 'waiting';
    const result = await provider.execute({
      runId,
      stepId: definition.id,
      prompt: rendered.value,
      dispatchToken,
    });

    if (result.kind === 'blocked') {
      step.status = 'blocked';
      step.error = result.reason;
      if (result.receipt) step.receipt = result.receipt;
      run.status = 'blocked';
      emit('run.blocked', definition.id, {
        reason: result.reason,
        ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
      });
      return run;
    }

    step.receipt = result.receipt;
    emit('step.dispatch_confirmed', definition.id, { receipt: result.receipt });

    step.output = result.output;
    outputs[definition.id] = { output: result.output };
    emit('step.output_captured', definition.id, { outputLength: result.output.length });

    const assertionResult = evaluateAssertions(result.output, definition.assert ?? []);
    if (!assertionResult.ok) {
      step.status = 'failed';
      step.error = 'Assertion failed';
      emit('step.assertion_failed', definition.id, { assertion: assertionResult.failed });
      run.status = 'failed';
      emit('run.failed', definition.id, { reason: 'assertion.failed', assertion: assertionResult.failed });
      return run;
    }

    if ((definition.assert?.length ?? 0) > 0) {
      emit('step.assertion_passed', definition.id, { count: definition.assert!.length });
    }

    step.status = 'completed';
    emit('step.completed', definition.id, {});
  }

  run.status = 'completed';
  emit('run.completed', undefined, {});
  return run;
}
