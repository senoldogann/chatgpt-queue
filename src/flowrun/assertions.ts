import type { StepAssertion } from './schema';

export type AssertionEvaluation =
  | { ok: true }
  | { ok: false; failed: StepAssertion };

export function evaluateAssertions(output: string, assertions: StepAssertion[] = []): AssertionEvaluation {
  for (const assertion of assertions) {
    if (assertion.type === 'output_not_empty' && output.trim().length === 0) {
      return { ok: false, failed: assertion };
    }
    if (assertion.type === 'output_contains' && !output.includes(assertion.value)) {
      return { ok: false, failed: assertion };
    }
  }
  return { ok: true };
}
