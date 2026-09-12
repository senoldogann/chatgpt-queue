import { MAX_RENDERED_PROMPT_LENGTH } from './schema';
import type { ValidationError, ValidationResult, WorkflowDefinition } from './schema';

export interface TemplateContext {
  inputs: Record<string, string>;
  steps: Record<string, { output: string }>;
}

export function validateRunInputs(
  workflow: WorkflowDefinition,
  inputs: Record<string, string>,
): ValidationResult<Record<string, string>> {
  const errors: ValidationError[] = [];

  for (const [name, definition] of Object.entries(workflow.inputs)) {
    if (definition.required && !(name in inputs)) {
      errors.push({
        code: 'input.missing_required',
        path: `inputs.${name}`,
        message: `Missing required input: ${name}`,
      });
    }
  }

  for (const [name, value] of Object.entries(inputs)) {
    if (!(name in workflow.inputs)) {
      errors.push({
        code: 'input.unknown',
        path: `inputs.${name}`,
        message: `Unknown input: ${name}`,
      });
      continue;
    }
    if (typeof value !== 'string') {
      errors.push({
        code: 'input.invalid_value',
        path: `inputs.${name}`,
        message: `Input ${name} must be a string`,
      });
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: { ...inputs } };
}

export function renderPrompt(prompt: string, context: TemplateContext): ValidationResult<string> {
  const errors: ValidationError[] = [];
  let rendered = '';
  let cursor = 0;
  const pattern = /{{\s*([^{}]+?)\s*}}/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(prompt)) !== null) {
    rendered += prompt.slice(cursor, match.index);
    const expression = match[1]!.trim();

    const inputMatch = expression.match(/^inputs\.([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/);
    if (inputMatch) {
      const name = inputMatch[1]!;
      if (!(name in context.inputs)) {
        errors.push({
          code: 'template.unresolved_input',
          path: 'prompt',
          message: `Unresolved input: ${name}`,
        });
      } else {
        rendered += context.inputs[name]!;
      }
      cursor = pattern.lastIndex;
      continue;
    }

    const stepMatch = expression.match(/^steps\.([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\.output$/);
    if (stepMatch) {
      const stepId = stepMatch[1]!;
      const output = context.steps[stepId]?.output;
      if (output === undefined) {
        errors.push({
          code: 'template.unresolved_output',
          path: 'prompt',
          message: `Unresolved step output: ${stepId}`,
        });
      } else {
        rendered += output;
      }
      cursor = pattern.lastIndex;
      continue;
    }

    errors.push({
      code: 'template.invalid_expression',
      path: 'prompt',
      message: `Unsupported template expression: ${expression}`,
    });
    cursor = pattern.lastIndex;
  }

  const remainder = prompt.slice(cursor);
  if (remainder.includes('{{') || remainder.includes('}}')) {
    errors.push({ code: 'template.invalid_expression', path: 'prompt', message: 'Malformed template expression' });
  }
  rendered += remainder;

  if (errors.length > 0) return { ok: false, errors };
  if (rendered.length > MAX_RENDERED_PROMPT_LENGTH) {
    return {
      ok: false,
      errors: [{
        code: 'template.prompt_too_large',
        path: 'prompt',
        message: `Rendered prompt exceeds ${MAX_RENDERED_PROMPT_LENGTH} code units`,
      }],
    };
  }

  return { ok: true, value: rendered };
}
