import { describe, expect, it } from 'vitest';
import { getWorkflowPreset, localizedPresetText, WORKFLOW_PRESETS } from '../../src/flowrun/presets';
import { validateWorkflowDocument } from '../../src/flowrun/schema';

describe('FlowRun workflow presets', () => {
  it('ships the approved professional preset catalog with stable unique ids', () => {
    expect(WORKFLOW_PRESETS.map((preset) => preset.id)).toEqual([
      'production-readiness',
      'code-review',
      'root-cause-debugging',
      'release-gate',
      'implementation-plan',
      'open-code-review',
    ]);
    expect(new Set(WORKFLOW_PRESETS.map((preset) => preset.id)).size).toBe(WORKFLOW_PRESETS.length);
    expect(WORKFLOW_PRESETS.every((preset) => preset.label.trim().length > 0 && preset.description.trim().length > 0)).toBe(true);
  });

  it('carries Turkish UI text for every preset but never translates prompts', () => {
    for (const preset of WORKFLOW_PRESETS) {
      const tr = localizedPresetText(preset, 'tr');
      const en = localizedPresetText(preset, 'en');
      expect(tr.label.trim(), preset.id).not.toBe('');
      expect(tr.description.trim(), preset.id).not.toBe('');
      expect(en.label).toBe(preset.label);
      expect(en.description).toBe(preset.description);
      expect(preset.workflow.steps.every((step) => !/[çğıöşüÇĞİÖŞÜ]/.test(step.prompt))).toBe(true);
    }
    expect(localizedPresetText(WORKFLOW_PRESETS[0]!, 'tr').label).toBe('Yayına Hazırlık');
  });

  it('keeps every built-in workflow valid, chained, and fail-closed on empty model output', () => {
    for (const preset of WORKFLOW_PRESETS) {
      const validation = validateWorkflowDocument(preset.workflow);
      expect(validation, preset.id).toEqual({ ok: true, value: preset.workflow });
      expect(preset.workflow.steps.length, preset.id).toBeGreaterThanOrEqual(3);
      expect(preset.workflow.steps.every((step) => step.assert?.some((assertion) => assertion.type === 'output_not_empty'))).toBe(true);
      expect(preset.workflow.steps.slice(1).some((step) => step.prompt.includes('{{ steps.'))).toBe(true);
    }
  });

  it('returns an isolated preset copy so selected workflows cannot mutate the catalog', () => {
    const first = getWorkflowPreset('code-review');
    const second = getWorkflowPreset('code-review');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
    expect(first!.workflow).not.toBe(second!.workflow);

    first!.workflow.steps[0]!.prompt = 'mutated';
    expect(getWorkflowPreset('code-review')!.workflow.steps[0]!.prompt).not.toBe('mutated');
  });
});
