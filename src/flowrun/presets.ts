import type { WorkflowDefinition } from './schema';

export interface WorkflowPreset {
  id: string;
  label: string;
  description: string;
  /** Turkish UI text. Falls back to the English field; the prompts themselves are never translated. */
  labelTr?: string;
  descriptionTr?: string;
  workflow: WorkflowDefinition;
}

/** Picks the preset label/description for a panel locale without touching the workflow prompts. */
export const localizedPresetText = (
  preset: WorkflowPreset,
  locale: string,
): { label: string; description: string } => (locale === 'tr'
  ? { label: preset.labelTr ?? preset.label, description: preset.descriptionTr ?? preset.description }
  : { label: preset.label, description: preset.description });

const requiredOutput = [{ type: 'output_not_empty' as const }];

// The `open-code-review` preset below adapts the review pipeline published by Alibaba's
// Open Code Review (https://github.com/alibaba/open-code-review, Apache-2.0): deterministic file
// selection, rule-matched defect detection, an independent positioning pass, and a reflection pass
// that trades recall for precision. It is a prompt workflow derived from that methodology, not a
// binding to the `ocr` binary.

const presets: WorkflowPreset[] = [
  {
    id: 'production-readiness',
    label: 'Production Readiness',
    description: 'Architecture, correctness, verification, and release-risk review before shipping.',
    labelTr: 'Yayına Hazırlık',
    descriptionTr: 'Yayına almadan önce mimari, doğruluk, doğrulama ve sürüm riski incelemesi.',
    workflow: {
      version: 1,
      name: 'production-readiness',
      inputs: {
        change: { type: 'string', required: true },
        context: { type: 'string' },
      },
      steps: [
        {
          id: 'architecture',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Act as a senior production-readiness reviewer. Analyze the proposed change below without assuming undocumented behavior.

Change:
{{ inputs.change }}

Additional context:
{{ inputs.context }}

Map the affected architecture and runtime boundaries. Identify state transitions, persistence or ownership concerns, external dependencies, backwards-compatibility risk, security/privacy exposure, and assumptions that still need evidence. Separate confirmed facts from inferred risks. Do not propose broad refactors unrelated to the change.`,
          assert: requiredOutput,
        },
        {
          id: 'correctness',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Using the architecture review below, perform a correctness and failure-mode review of the same change.

Architecture review:
{{ steps.architecture.output }}

Original change:
{{ inputs.change }}

Prioritize concrete failure modes: data loss or duplication, stale state, concurrency/ordering, retries and idempotency, interrupted execution, invalid input, permission boundaries, upgrade/reload behavior, and user-visible recovery. For each material finding, state the trigger, impact, and the smallest safe remediation or evidence needed to dismiss it. Avoid speculative findings with no plausible trigger.`,
          assert: requiredOutput,
        },
        {
          id: 'verification',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Build a verification plan from the architecture and correctness reviews.

Architecture:
{{ steps.architecture.output }}

Correctness findings:
{{ steps.correctness.output }}

Produce a risk-based matrix covering the minimum meaningful unit, integration, end-to-end, migration/recovery, and manual acceptance checks. For every check, specify what behavior it proves and what failure would mean. Distinguish existing evidence from checks that still need to run. Do not claim a behavior is verified merely because a build or unrelated test passes.`,
          assert: requiredOutput,
        },
        {
          id: 'release-decision',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Act as the release gate. Give a concise production decision using only the evidence below.

Correctness review:
{{ steps.correctness.output }}

Verification plan/evidence assessment:
{{ steps.verification.output }}

Return: (1) GO, GO WITH CONDITIONS, or NO-GO; (2) blocking findings only; (3) required pre-release checks; (4) rollback/recovery considerations; and (5) post-release signals worth watching. Treat missing evidence as missing evidence, not success.`,
          assert: requiredOutput,
        },
      ],
    },
  },
  {
    id: 'code-review',
    label: 'Code Review',
    description: 'Intent, concrete defects, regression coverage, and prioritized review findings.',
    labelTr: 'Kod İncelemesi',
    descriptionTr: 'Amaç, somut kusurlar, regresyon kapsamı ve önceliklendirilmiş inceleme bulguları.',
    workflow: {
      version: 1,
      name: 'code-review',
      inputs: {
        diff: { type: 'string', required: true },
        context: { type: 'string' },
      },
      steps: [
        {
          id: 'intent',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Review this change as a senior engineer. First reconstruct its intended behavior and boundaries from the evidence provided.

Diff/change:
{{ inputs.diff }}

Context:
{{ inputs.context }}

Summarize the behavior being changed, invariants that must remain true, touched interfaces/state, and any ambiguity that prevents confident review. Do not praise style or restate the diff line by line.`,
          assert: requiredOutput,
        },
        {
          id: 'defects',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Find concrete defects or regression risks in the change below, using the reconstructed intent as the contract.

Intended behavior:
{{ steps.intent.output }}

Diff/change:
{{ inputs.diff }}

Focus on issues that can produce wrong behavior: edge cases, state corruption, error paths, async ordering, resource lifecycle, security boundaries, backwards compatibility, and mismatches with existing conventions. For each finding, provide severity, exact reasoning, and a specific fix direction. Exclude stylistic preferences unless they hide a correctness risk.`,
          assert: requiredOutput,
        },
        {
          id: 'tests',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Design regression coverage for the reviewed change.

Intent/invariants:
{{ steps.intent.output }}

Defect analysis:
{{ steps.defects.output }}

List the smallest tests that would prove the intended behavior and catch each credible regression. Separate unit, integration, and end-to-end cases. Include negative/failure-path tests and explain what each test protects. Do not recommend tests that merely mirror implementation details.`,
          assert: requiredOutput,
        },
        {
          id: 'review-summary',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Produce the final code-review summary from the evidence below.

Defects:
{{ steps.defects.output }}

Regression coverage:
{{ steps.tests.output }}

Return only actionable findings, ordered by severity. Clearly distinguish blockers from non-blocking improvements. If no blocking defect is supported by evidence, say so explicitly without inventing one. End with the minimum verification required before merge.`,
          assert: requiredOutput,
        },
      ],
    },
  },
  {
    id: 'root-cause-debugging',
    label: 'Root Cause Debugging',
    description: 'Evidence-first diagnosis, hypothesis ranking, root-cause trace, and minimal regression-safe fix.',
    labelTr: 'Kök Neden Hata Ayıklama',
    descriptionTr: 'Kanıt öncelikli teşhis, hipotez sıralaması, kök neden izi ve minimum regresyon güvenli düzeltme.',
    workflow: {
      version: 1,
      name: 'root-cause-debugging',
      inputs: {
        symptom: { type: 'string', required: true },
        evidence: { type: 'string' },
      },
      steps: [
        {
          id: 'facts',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Treat this as a production debugging investigation. Do not jump to a fix.

Symptom:
{{ inputs.symptom }}

Available evidence:
{{ inputs.evidence }}

Separate observed facts from assumptions. Define the narrowest reproducible failure, identify the component boundaries involved, and list the missing observations that would most reduce uncertainty. Call out any evidence that contradicts the obvious explanation.`,
          assert: requiredOutput,
        },
        {
          id: 'hypotheses',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Generate and rank root-cause hypotheses from the evidence inventory.

Evidence inventory:
{{ steps.facts.output }}

For each plausible hypothesis, state why it fits, what it fails to explain, and one discriminating check that could confirm or eliminate it. Prefer checks at component boundaries and data/state transitions. Rank by evidence, not familiarity.`,
          assert: requiredOutput,
        },
        {
          id: 'root-cause',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Trace the failure backward and determine the strongest supported root cause.

Facts:
{{ steps.facts.output }}

Ranked hypotheses:
{{ steps.hypotheses.output }}

Explain the causal chain from originating condition to observed symptom, including the exact boundary where expected state diverges from actual state. If the evidence is insufficient to name one root cause, say what remains unproven and specify the next check instead of guessing.`,
          assert: requiredOutput,
        },
        {
          id: 'fix-plan',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Design the smallest safe correction for the supported root cause.

Root-cause analysis:
{{ steps.root-cause.output }}

Original symptom:
{{ inputs.symptom }}

Specify the minimal code/config/state change, why it fixes the cause rather than the symptom, the regression test that must fail before and pass after the fix, and any recovery/migration step needed for already-affected state. Avoid unrelated cleanup.`,
          assert: requiredOutput,
        },
      ],
    },
  },
  {
    id: 'release-gate',
    label: 'Release Gate',
    description: 'Evidence-based go/no-go decision with blockers, rollback readiness, and acceptance checks.',
    labelTr: 'Sürüm Kapısı',
    descriptionTr: 'Engelleyiciler, geri dönüş hazırlığı ve kabul kontrolleriyle kanıta dayalı devam/dur kararı.',
    workflow: {
      version: 1,
      name: 'release-gate',
      inputs: {
        release: { type: 'string', required: true },
        evidence: { type: 'string' },
      },
      steps: [
        {
          id: 'scope',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Establish the release contract from the material below.

Release scope:
{{ inputs.release }}

Current verification evidence:
{{ inputs.evidence }}

List the user-visible and operational behaviors that must be true at release time, the affected compatibility/security/data boundaries, and any claims that currently lack evidence. Keep requirements concrete and testable.`,
          assert: requiredOutput,
        },
        {
          id: 'risk',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Assess release risk against the established contract.

Release contract:
{{ steps.scope.output }}

Analyze failure blast radius, persistence/migration risk, backwards compatibility, permission/security changes, dependency assumptions, recovery behavior, and operational observability. Rank only credible risks and identify which ones are release blockers versus monitored risks.`,
          assert: requiredOutput,
        },
        {
          id: 'evidence-check',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Audit whether the supplied evidence actually proves release readiness.

Contract:
{{ steps.scope.output }}

Risk assessment:
{{ steps.risk.output }}

Provided evidence:
{{ inputs.evidence }}

Map evidence to each blocking requirement and high-risk behavior. Mark each as PROVEN, PARTIAL, or MISSING and explain why. Do not treat successful compilation, unrelated tests, or stale results as proof of runtime behavior.`,
          assert: requiredOutput,
        },
        {
          id: 'gate',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Issue the release gate decision.

Risk assessment:
{{ steps.risk.output }}

Evidence audit:
{{ steps.evidence-check.output }}

Return GO, GO WITH CONDITIONS, or NO-GO. List blockers, required final checks, rollback/recovery readiness, and the first post-release signals to monitor. A missing proof for a blocking requirement must prevent an unconditional GO.`,
          assert: requiredOutput,
        },
      ],
    },
  },
  {
    id: 'implementation-plan',
    label: 'Implementation Plan',
    description: 'Scope, architecture, incremental tasks, verification gates, and acceptance criteria.',
    labelTr: 'Uygulama Planı',
    descriptionTr: 'Kapsam, mimari, artımlı görevler, doğrulama kapıları ve kabul ölçütleri.',
    workflow: {
      version: 1,
      name: 'implementation-plan',
      inputs: {
        requirements: { type: 'string', required: true },
        context: { type: 'string' },
      },
      steps: [
        {
          id: 'scope',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Convert these requirements into an implementation contract before planning code changes.

Requirements:
{{ inputs.requirements }}

Existing-system context:
{{ inputs.context }}

Extract goals, non-goals, constraints, compatibility expectations, data/state invariants, error/recovery behavior, and explicit acceptance criteria. Highlight ambiguities that materially affect architecture or irreversible decisions; make conservative assumptions only for small reversible details.`,
          assert: requiredOutput,
        },
        {
          id: 'architecture',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Design the smallest architecture that satisfies this implementation contract.

Contract:
{{ steps.scope.output }}

Identify existing components to reuse, files/modules likely to change, new boundaries only where necessary, data/control flow, persistence implications, and failure handling. Prefer incremental changes over rewrites and call out where current abstractions should remain untouched.`,
          assert: requiredOutput,
        },
        {
          id: 'tasks',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Turn the approved contract and architecture into implementation tasks.

Contract:
{{ steps.scope.output }}

Architecture:
{{ steps.architecture.output }}

Order tasks so each produces a reviewable, testable increment. For every task specify files/components, behavior to add or change, the test-first verification step, and dependencies on earlier tasks. Include migration/recovery work where applicable. Exclude unrelated refactors and placeholders.`,
          assert: requiredOutput,
        },
        {
          id: 'final-plan',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Produce the final execution-ready implementation plan.

Contract:
{{ steps.scope.output }}

Architecture:
{{ steps.architecture.output }}

Task decomposition:
{{ steps.tasks.output }}

Present the ordered tasks with acceptance criteria, local verification gates, integration/end-to-end checks, rollout or migration notes, and the exact conditions for calling the work complete. Distinguish implementation completion from PR/CI/merge/release status.`,
          assert: requiredOutput,
        },
      ],
    },
  },
  {
    id: 'open-code-review',
    label: 'Open Code Review',
    description: 'Precision-first review adapted from Alibaba Open Code Review: scope selection, specialized bug rules, line-level positioning.',
    labelTr: 'Open Code Review',
    descriptionTr: 'Alibaba Open Code Review\u2019dan uyarlanmış hassasiyet öncelikli inceleme: kapsam seçimi, özel hata kuralları, satır düzeyinde konumlama.',
    workflow: {
      version: 1,
      name: 'open-code-review',
      inputs: {
        diff: { type: 'string', required: true },
        context: { type: 'string' },
      },
      steps: [
        {
          id: 'scope',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Select exactly what deserves review before looking for defects. This mirrors a deterministic file-selection stage: decide first, review second.

Change:
{{ inputs.diff }}

Repository context:
{{ inputs.context }}

Produce two lists. MUST REVIEW: files whose behavior, data, contracts, or state ownership changed, with the specific reason each one matters. SKIP: generated code, vendored files, formatting-only edits, lockfiles, and unchanged reordering, with the reason. Group files that must be read together as one review unit (for example a resource file and its translation, a schema and its migration, an interface and its consumers) so a change cannot be judged in isolation. Never silently drop a file that changed behavior.`,
          assert: requiredOutput,
        },
        {
          id: 'rules',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Review the MUST REVIEW set from the scope step using file-specific rule families, not generic style advice.

Scope selection:
{{ steps.scope.output }}

Change:
{{ inputs.diff }}

Context:
{{ inputs.context }}

For each review unit, first state which rule families apply. Consider at minimum: null/undefined dereference and uninitialized state, concurrency and shared mutable state, injection and untrusted input (including SQL/command/template injection and XSS), resource lifecycle and cleanup, error and exception paths, integer/encoding and boundary handling, and language- or framework-specific hazards for the files involved. Then report each defect with: file, symbol, the exact code excerpt, the rule family, the concrete trigger, and the resulting incorrect behavior. Report only defects you can justify from the code in front of you; exclude style preferences and speculative concerns that lack a plausible trigger.`,
          assert: requiredOutput,
        },
        {
          id: 'position',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Verify every reported finding against the real code, as an independent positioning pass.

Rule-matched findings:
{{ steps.rules.output }}

Change:
{{ inputs.diff }}

For each finding, confirm the quoted code actually exists at the stated file and location. Where the location drifted or the excerpt was paraphrased, correct it or drop the finding. Where a finding depends on behavior outside the diff, say what it depends on and whether that dependency was established. Mark each surviving finding as CONFIRMED or UNPROVEN.`,
          assert: requiredOutput,
        },
        {
          id: 'reflection',
          type: 'chat',
          provider: 'chatgpt',
          prompt: `Reflect on each confirmed finding and keep only real defects, deliberately trading recall for precision.

Rule-matched findings:
{{ steps.rules.output }}

Positioned findings:
{{ steps.position.output }}

For each finding, argue the strongest reason it might not be a real defect. Drop it if that reason holds; keep it only when the failure can actually occur. Return the surviving findings ordered by severity (blocker, then non-blocking), each with file, location, why it is a real defect, and the smallest correct fix. If nothing survives, say so explicitly instead of inventing a finding, and end with the minimum verification the change still needs.`,
          assert: requiredOutput,
        },
      ],
    },
  },
];

export const WORKFLOW_PRESETS: readonly WorkflowPreset[] = presets;

export const getWorkflowPreset = (id: string): WorkflowPreset | undefined => {
  const preset = presets.find((candidate) => candidate.id === id);
  return preset ? structuredClone(preset) : undefined;
};
