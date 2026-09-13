/**
 * Deterministic compaction / handoff helpers.
 *
 * ChatGPT Web has no compaction control: a conversation eventually reaches its context limit and
 * the only recovery is a new conversation. Everything here is local and deterministic — no API call
 * and no invented summary — so the brief is produced by the model from the real conversation and
 * then validated before it is allowed to seed a new one.
 *
 * The format is deliberately plain uppercase labels rather than Markdown headings. Assistant text
 * read back out of the page is whitespace-collapsed and has already been rendered, so `## State`
 * arrives as a bare word with no marker; a `STATE:` label survives both the render and the flatten.
 */

export const HANDOFF_BRIEF_SECTIONS = [
  'STATE',
  'DECISIONS',
  'OPEN QUESTIONS',
  'NEXT STEPS',
  'CONSTRAINTS',
] as const;

export type HandoffBriefSection = (typeof HANDOFF_BRIEF_SECTIONS)[number];

export const HANDOFF_PROMPT = [
  'Produce a handoff brief so a brand-new conversation can continue this work without the earlier message history.',
  '',
  'Output only the brief. Start each of these five plain-text labels at the beginning of its own line, in this order, and put the content for that section after the label:',
  '',
  ...HANDOFF_BRIEF_SECTIONS.map((section) => `${section}:`),
  '',
  'What belongs in each section:',
  '- STATE — what exists right now, concretely.',
  '- DECISIONS — choices already settled and why, so they are not re-litigated.',
  '- OPEN QUESTIONS — what is still unknown or unverified.',
  '- NEXT STEPS — the smallest ordered list of actions to take next.',
  '- CONSTRAINTS — rules, limits, and fail-closed behaviors that must keep holding.',
  '',
  'Do not use Markdown headings, preamble, or closing remarks, and do not restate these instructions.',
].join('\n');

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Index of a section label, tolerating markdown decoration and collapsed whitespace. */
const labelIndex = (text: string, label: string): number => {
  const pattern = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(label).replace(/\\ /g, '\\s+')}\\s*:`, 'iu');
  const match = pattern.exec(text);
  return match ? match.index + match[1]!.length : -1;
};

export const MIN_HANDOFF_BRIEF_LENGTH = 120;
export const MIN_HANDOFF_SECTION_LENGTH = 20;

export type HandoffBriefParseResult =
  | { ok: true; brief: string }
  | { ok: false; errors: string[] };

export function parseHandoffBrief(reply: string): HandoffBriefParseResult {
  const brief = reply.replace(/\s+/g, ' ').trim();
  const errors: string[] = [];

  if (brief.length < MIN_HANDOFF_BRIEF_LENGTH) errors.push('brief-too-short');

  const indices: number[] = [];
  for (const section of HANDOFF_BRIEF_SECTIONS) {
    const index = labelIndex(brief, section);
    if (index < 0) {
      errors.push(`missing-section:${section}`);
      indices.push(-1);
      continue;
    }
    indices.push(index);
  }

  const ordered = indices.filter((index) => index >= 0);
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index]! <= ordered[index - 1]!) {
      errors.push('sections-out-of-order');
      break;
    }
  }

  const labelsResolved = !errors.some((error) => error.startsWith('missing-section') || error === 'sections-out-of-order');
  if (labelsResolved) {
    for (let index = 0; index < HANDOFF_BRIEF_SECTIONS.length; index += 1) {
      const start = indices[index]!;
      const end = index + 1 < indices.length ? indices[index + 1]! : brief.length;
      const body = brief.slice(start, end);
      if (body.length < MIN_HANDOFF_SECTION_LENGTH) errors.push(`section-too-short:${HANDOFF_BRIEF_SECTIONS[index]}`);
    }
  }

  return errors.length === 0 ? { ok: true, brief } : { ok: false, errors };
}

export const HANDOFF_SEED_INSTRUCTION = 'Continue this work here. Handoff brief from the previous conversation:';

export const HANDOFF_SEED_REQUEST = 'Confirm the brief in one short line, then continue with the queued follow-ups already in this queue.';

export function buildHandoffSeed(brief: string, carriedItems: string[]): string[] {
  const seed = `${HANDOFF_SEED_INSTRUCTION}\n\n${brief.trim()}\n\n${HANDOFF_SEED_REQUEST}`;
  return [seed, ...carriedItems.map((item) => item.trim()).filter(Boolean)];
}
