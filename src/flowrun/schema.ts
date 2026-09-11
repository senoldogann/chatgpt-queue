export const FLOWRUN_VERSION = 1 as const;
export const MAX_WORKFLOW_STEPS = 100;
export const MAX_RENDERED_PROMPT_LENGTH = 200_000;

const IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const TOP_LEVEL_KEYS = new Set(['version', 'name', 'inputs', 'steps']);
const INPUT_KEYS = new Set(['type', 'required']);
const STEP_KEYS = new Set(['id', 'type', 'provider', 'prompt', 'assert']);
const OUTPUT_NOT_EMPTY_KEYS = new Set(['type']);
const OUTPUT_CONTAINS_KEYS = new Set(['type', 'value']);

export interface WorkflowInputDefinition {
  type: 'string';
  required?: boolean;
}

export type StepAssertion =
  | { type: 'output_not_empty' }
  | { type: 'output_contains'; value: string };

export interface ChatWorkflowStep {
  id: string;
  type: 'chat';
  provider: string;
  prompt: string;
  assert?: StepAssertion[];
}

export interface WorkflowDefinition {
  version: typeof FLOWRUN_VERSION;
  name: string;
  inputs: Record<string, WorkflowInputDefinition>;
  steps: ChatWorkflowStep[];
}

export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[] };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const pushUnknownKeys = (
  value: Record<string, unknown>,
  allowed: Set<string>,
  path: string,
  code: string,
  errors: ValidationError[],
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push({ code, path: `${path}.${key}`, message: `Unknown key: ${key}` });
    }
  }
};

const identifierIsValid = (value: unknown): value is string =>
  typeof value === 'string' && IDENTIFIER.test(value);

const validateAssertion = (
  value: unknown,
  path: string,
  errors: ValidationError[],
): StepAssertion | undefined => {
  if (!isRecord(value) || typeof value.type !== 'string') {
    errors.push({ code: 'assertion.invalid', path, message: 'Assertion must be an object with a supported type' });
    return undefined;
  }

  if (value.type === 'output_not_empty') {
    pushUnknownKeys(value, OUTPUT_NOT_EMPTY_KEYS, path, 'assertion.invalid', errors);
    return { type: 'output_not_empty' };
  }

  if (value.type === 'output_contains') {
    pushUnknownKeys(value, OUTPUT_CONTAINS_KEYS, path, 'assertion.invalid', errors);
    if (typeof value.value !== 'string' || value.value.length === 0) {
      errors.push({ code: 'assertion.invalid', path: `${path}.value`, message: 'output_contains requires a non-empty string value' });
      return undefined;
    }
    return { type: 'output_contains', value: value.value };
  }

  errors.push({ code: 'assertion.invalid', path: `${path}.type`, message: `Unsupported assertion type: ${value.type}` });
  return undefined;
};

const collectTemplateExpressions = (prompt: string): { expressions: string[]; malformed: boolean } => {
  const expressions: string[] = [];
  const pattern = /{{\s*([^{}]+?)\s*}}/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;
  let remainder = '';

  while ((match = pattern.exec(prompt)) !== null) {
    remainder += prompt.slice(lastIndex, match.index);
    expressions.push(match[1]!.trim());
    lastIndex = pattern.lastIndex;
  }
  remainder += prompt.slice(lastIndex);

  return { expressions, malformed: remainder.includes('{{') || remainder.includes('}}') };
};

const validateTemplateReferences = (
  prompt: string,
  path: string,
  inputNames: Set<string>,
  priorStepIds: Set<string>,
  errors: ValidationError[],
): void => {
  const { expressions, malformed } = collectTemplateExpressions(prompt);
  if (malformed) {
    errors.push({ code: 'template.invalid_expression', path, message: 'Malformed template expression' });
  }

  for (const expression of expressions) {
    const inputMatch = expression.match(/^inputs\.([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})$/);
    if (inputMatch) {
      if (!inputNames.has(inputMatch[1]!)) {
        errors.push({
          code: 'template.unknown_input',
          path,
          message: `Unknown input reference: ${inputMatch[1]}`,
        });
      }
      continue;
    }

    const stepMatch = expression.match(/^steps\.([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})\.output$/);
    if (stepMatch) {
      if (!priorStepIds.has(stepMatch[1]!)) {
        errors.push({
          code: 'template.future_step_reference',
          path,
          message: `Step output reference must target an earlier step: ${stepMatch[1]}`,
        });
      }
      continue;
    }

    errors.push({
      code: 'template.invalid_expression',
      path,
      message: `Unsupported template expression: ${expression}`,
    });
  }
};

export function validateWorkflowDocument(value: unknown): ValidationResult<WorkflowDefinition> {
  const errors: ValidationError[] = [];
  if (!isRecord(value)) {
    return { ok: false, errors: [{ code: 'workflow.invalid', path: '$', message: 'Workflow must be an object' }] };
  }

  pushUnknownKeys(value, TOP_LEVEL_KEYS, '$', 'workflow.unknown_key', errors);

  if (value.version !== FLOWRUN_VERSION) {
    errors.push({ code: 'workflow.invalid_version', path: '$.version', message: `version must be ${FLOWRUN_VERSION}` });
  }
  if (!identifierIsValid(value.name)) {
    errors.push({ code: 'workflow.invalid_name', path: '$.name', message: 'name must be a valid identifier' });
  }

  const inputs: Record<string, WorkflowInputDefinition> = {};
  if (value.inputs !== undefined) {
    if (!isRecord(value.inputs)) {
      errors.push({ code: 'workflow.invalid_inputs', path: '$.inputs', message: 'inputs must be an object' });
    } else {
      for (const [name, definition] of Object.entries(value.inputs)) {
        const path = `$.inputs.${name}`;
        if (!identifierIsValid(name)) {
          errors.push({ code: 'input.invalid_name', path, message: 'input name must be a valid identifier' });
          continue;
        }
        if (!isRecord(definition)) {
          errors.push({ code: 'input.invalid_definition', path, message: 'input definition must be an object' });
          continue;
        }
        pushUnknownKeys(definition, INPUT_KEYS, path, 'input.unknown_key', errors);
        if (definition.type !== 'string') {
          errors.push({ code: 'input.invalid_type', path: `${path}.type`, message: 'only string inputs are supported' });
          continue;
        }
        if (definition.required !== undefined && typeof definition.required !== 'boolean') {
          errors.push({ code: 'input.invalid_required', path: `${path}.required`, message: 'required must be boolean' });
          continue;
        }
        inputs[name] = { type: 'string', ...(definition.required === undefined ? {} : { required: definition.required }) };
      }
    }
  }

  const steps: ChatWorkflowStep[] = [];
  const seenStepIds = new Set<string>();
  const priorStepIds = new Set<string>();
  const inputNames = new Set(Object.keys(inputs));

  if (!Array.isArray(value.steps)) {
    errors.push({ code: 'workflow.invalid_steps', path: '$.steps', message: 'steps must be an array' });
  } else {
    if (value.steps.length > MAX_WORKFLOW_STEPS) {
      errors.push({
        code: 'workflow.too_many_steps',
        path: '$.steps',
        message: `workflow cannot contain more than ${MAX_WORKFLOW_STEPS} steps`,
      });
    }

    value.steps.forEach((rawStep, index) => {
      const path = `$.steps[${index}]`;
      if (!isRecord(rawStep)) {
        errors.push({ code: 'step.invalid', path, message: 'step must be an object' });
        return;
      }

      pushUnknownKeys(rawStep, STEP_KEYS, path, 'step.unknown_key', errors);

      const id = rawStep.id;
      if (!identifierIsValid(id)) {
        errors.push({ code: 'step.invalid_id', path: `${path}.id`, message: 'step id must be a valid identifier' });
      } else if (seenStepIds.has(id)) {
        errors.push({ code: 'step.duplicate_id', path: `${path}.id`, message: `duplicate step id: ${id}` });
      }
      if (typeof id === 'string') seenStepIds.add(id);

      if (rawStep.type !== 'chat') {
        errors.push({ code: 'step.invalid_type', path: `${path}.type`, message: 'only chat steps are supported' });
      }
      if (!identifierIsValid(rawStep.provider)) {
        errors.push({ code: 'step.invalid_provider', path: `${path}.provider`, message: 'provider must be a valid identifier' });
      }
      if (typeof rawStep.prompt !== 'string' || rawStep.prompt.trim().length === 0) {
        errors.push({ code: 'step.empty_prompt', path: `${path}.prompt`, message: 'prompt must be a non-empty string' });
      } else {
        validateTemplateReferences(rawStep.prompt, `${path}.prompt`, inputNames, priorStepIds, errors);
      }

      let assertions: StepAssertion[] | undefined;
      if (rawStep.assert !== undefined) {
        if (!Array.isArray(rawStep.assert)) {
          errors.push({ code: 'assertion.invalid', path: `${path}.assert`, message: 'assert must be an array' });
        } else {
          assertions = rawStep.assert
            .map((assertion, assertionIndex) => validateAssertion(assertion, `${path}.assert[${assertionIndex}]`, errors))
            .filter((assertion): assertion is StepAssertion => Boolean(assertion));
        }
      }

      if (
        identifierIsValid(id)
        && rawStep.type === 'chat'
        && identifierIsValid(rawStep.provider)
        && typeof rawStep.prompt === 'string'
        && rawStep.prompt.trim().length > 0
      ) {
        steps.push({
          id,
          type: 'chat',
          provider: rawStep.provider,
          prompt: rawStep.prompt,
          ...(assertions === undefined ? {} : { assert: assertions }),
        });
      }
      if (identifierIsValid(id)) priorStepIds.add(id);
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      version: FLOWRUN_VERSION,
      name: value.name as string,
      inputs,
      steps,
    },
  };
}
