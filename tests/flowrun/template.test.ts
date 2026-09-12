import { describe, expect, it } from 'vitest';
import { validateWorkflowDocument } from '../../src/flowrun/schema';
import { renderPrompt, validateRunInputs } from '../../src/flowrun/template';

const workflow = () => {
  const result = validateWorkflowDocument({
    version: 1,
    name: 'templating',
    inputs: {
      topic: { type: 'string', required: true },
      tone: { type: 'string', required: false },
    },
    steps: [
      { id: 'first', type: 'chat', provider: 'chatgpt', prompt: 'Analyze {{ inputs.topic }}' },
      { id: 'second', type: 'chat', provider: 'chatgpt', prompt: '{{ steps.first.output }}' },
    ],
  });
  if (!result.ok) throw new Error('fixture invalid');
  return result.value;
};

describe('FlowRun templates', () => {
  it('validates explicit run inputs and rejects missing/unknown inputs', () => {
    expect(validateRunInputs(workflow(), { topic: 'queues' })).toEqual({
      ok: true,
      value: { topic: 'queues' },
    });

    const missing = validateRunInputs(workflow(), {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]?.code).toBe('input.missing_required');

    const unknown = validateRunInputs(workflow(), { topic: 'queues', surprise: 'nope' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.errors[0]?.code).toBe('input.unknown');
  });

  it('renders inputs and prior step outputs exactly', () => {
    const result = renderPrompt(
      'Topic={{ inputs.topic }} | again={{ inputs.topic }} | prior={{ steps.first.output }}',
      {
        inputs: { topic: 'queue' },
        steps: { first: { output: 'analysis result' } },
      },
    );
    expect(result).toEqual({
      ok: true,
      value: 'Topic=queue | again=queue | prior=analysis result',
    });
  });

  it('rejects unresolved and malformed expressions', () => {
    const missing = renderPrompt('{{ steps.missing.output }}', { inputs: {}, steps: {} });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors[0]?.code).toBe('template.unresolved_output');

    const invalid = renderPrompt('{{ process.env.SECRET }}', { inputs: {}, steps: {} });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.errors[0]?.code).toBe('template.invalid_expression');

    const malformed = renderPrompt('hello {{ inputs.topic', { inputs: { topic: 'x' }, steps: {} });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.errors[0]?.code).toBe('template.invalid_expression');
  });

  it('rejects rendered prompts larger than 200000 code units', () => {
    const result = renderPrompt('{{ inputs.big }}', {
      inputs: { big: 'x'.repeat(200_001) },
      steps: {},
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.code).toBe('template.prompt_too_large');
  });
});
