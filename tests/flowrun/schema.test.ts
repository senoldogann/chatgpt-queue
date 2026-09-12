import { describe, expect, it } from 'vitest';
import { validateWorkflowDocument } from '../../src/flowrun/schema';

const validWorkflow = () => ({
  version: 1,
  name: 'review-pr',
  inputs: {
    diff: { type: 'string', required: true },
  },
  steps: [
    {
      id: 'architecture',
      type: 'chat',
      provider: 'chatgpt',
      prompt: 'Review {{ inputs.diff }}',
    },
    {
      id: 'bugs',
      type: 'chat',
      provider: 'chatgpt',
      prompt: 'Find bugs in {{ steps.architecture.output }}',
      assert: [{ type: 'output_not_empty' }],
    },
  ],
});

describe('FlowRun workflow schema', () => {
  it('accepts a valid workflow', () => {
    const result = validateWorkflowDocument(validWorkflow());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe('review-pr');
      expect(result.value.steps).toHaveLength(2);
    }
  });

  it('rejects invalid version/name and unknown top-level keys', () => {
    const result = validateWorkflowDocument({ ...validWorkflow(), version: 2, name: 'bad name', extra: true });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
        'workflow.invalid_version',
        'workflow.invalid_name',
        'workflow.unknown_key',
      ]));
    }
  });

  it('rejects duplicate ids, invalid providers and empty prompts', () => {
    const workflow = validWorkflow();
    workflow.steps = [
      { id: 'same', type: 'chat', provider: '', prompt: 'hello' } as any,
      { id: 'same', type: 'chat', provider: 'chatgpt', prompt: '   ' } as any,
    ];
    const result = validateWorkflowDocument(workflow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
        'step.duplicate_id',
        'step.invalid_provider',
        'step.empty_prompt',
      ]));
    }
  });

  it('rejects workflows with more than 100 steps', () => {
    const workflow = validWorkflow();
    workflow.steps = Array.from({ length: 101 }, (_, index) => ({
      id: `step-${index}`,
      type: 'chat',
      provider: 'chatgpt',
      prompt: 'hello',
    }));
    const result = validateWorkflowDocument(workflow);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((error) => error.code === 'workflow.too_many_steps')).toBe(true);
  });

  it('rejects unknown inputs and self/future step references', () => {
    const workflow = validWorkflow();
    workflow.steps = [
      { id: 'first', type: 'chat', provider: 'chatgpt', prompt: '{{ inputs.missing }} {{ steps.first.output }} {{ steps.second.output }}' },
      { id: 'second', type: 'chat', provider: 'chatgpt', prompt: 'ok' },
    ];
    const result = validateWorkflowDocument(workflow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
        'template.unknown_input',
        'template.future_step_reference',
      ]));
    }
  });

  it('rejects malformed expressions and unknown step keys/assertions', () => {
    const workflow = validWorkflow();
    workflow.steps = [{
      id: 'one',
      type: 'chat',
      provider: 'chatgpt',
      prompt: '{{ process.env.SECRET }}',
      extra: true,
      assert: [{ type: 'something_else' }],
    } as any];
    const result = validateWorkflowDocument(workflow);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.map((error) => error.code)).toEqual(expect.arrayContaining([
        'step.unknown_key',
        'template.invalid_expression',
        'assertion.invalid',
      ]));
    }
  });
});
