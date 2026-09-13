import { describe, expect, it } from 'vitest';
import {
  HANDOFF_BRIEF_SECTIONS,
  HANDOFF_PROMPT,
  HANDOFF_SEED_INSTRUCTION,
  buildHandoffSeed,
  parseHandoffBrief,
} from '../../src/context/handoff';

const validBrief = [
  'STATE: The extension builds, the queue runtime stores durable state in chrome.storage.local, and the CLI bridge is connected.',
  'DECISIONS: Queue advancement is observation-driven and elapsed time is never used to guess completion.',
  'OPEN QUESTIONS: Whether the current ChatGPT web build exposes any compaction control at all.',
  'NEXT STEPS: 1. Ship the context meter. 2. Validate the handoff path in a real browser session.',
  'CONSTRAINTS: Fail closed on any unrecognized DOM and never resend an ambiguous send.',
].join('\n');

/** The artifact read back from the page has already been rendered and whitespace-collapsed. */
const flattened = (text: string) => text.replace(/\s+/g, ' ').trim();

describe('handoff brief', () => {
  it('asks for exactly the required labels in one deterministic prompt', () => {
    expect(HANDOFF_PROMPT).toBe(HANDOFF_PROMPT);
    for (const section of HANDOFF_BRIEF_SECTIONS) {
      expect(HANDOFF_PROMPT).toContain(`${section}:`);
    }
    expect(HANDOFF_PROMPT).toContain('Output only the brief');
    expect(HANDOFF_PROMPT).toContain('Do not use Markdown headings');
  });

  it('accepts a complete brief and normalizes it', () => {
    expect(parseHandoffBrief(validBrief)).toEqual({ ok: true, brief: flattened(validBrief) });
  });

  it('accepts the flattened text that a DOM read produces', () => {
    const result = parseHandoffBrief(flattened(validBrief));

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ brief: flattened(validBrief) });
  });

  it('accepts a rendered-markdown variant where the labels are bolded or headed', () => {
    const rendered = validBrief
      .split('\n')
      .map((line) => `**${line}**`)
      .join('\n');

    expect(parseHandoffBrief(rendered).ok).toBe(true);
  });

  it('rejects a brief that is missing or reordering sections instead of seeding a new chat', () => {
    const missing = validBrief.replace('CONSTRAINTS:', 'NOTES:');
    expect(parseHandoffBrief(missing)).toMatchObject({
      ok: false,
      errors: ['missing-section:CONSTRAINTS'],
    });

    const reordered = [
      'NEXT STEPS: 1. Ship the context meter. 2. Validate the handoff path in a real browser session.',
      'STATE: The extension builds, the queue runtime stores durable state in chrome.storage.local, and the CLI bridge is connected.',
      'DECISIONS: Queue advancement is observation-driven and elapsed time is never used to guess completion.',
      'OPEN QUESTIONS: Whether the current ChatGPT web build exposes any compaction control at all.',
      'CONSTRAINTS: Fail closed on any unrecognized DOM and never resend an ambiguous send.',
    ].join('\n');
    expect(parseHandoffBrief(reordered)).toMatchObject({ ok: false, errors: ['sections-out-of-order'] });
  });

  it('rejects a brief whose sections are present but empty', () => {
    const result = parseHandoffBrief(HANDOFF_BRIEF_SECTIONS.map((section) => `${section}:`).join('\n'));

    expect(result.ok).toBe(false);
    expect(result).toMatchObject({
      errors: expect.arrayContaining(['brief-too-short', 'section-too-short:STATE', 'section-too-short:CONSTRAINTS']),
    });
  });

  it('does not treat a body word as a section label', () => {
    const result = parseHandoffBrief([
      'STATE: The current state of the queue runtime is described here in enough detail to pass.',
      'DECISIONS: A decision that was settled earlier and is written down here for the next chat.',
      'OPEN QUESTIONS: Still unknown.',
      'NEXT STEPS: Do the next thing and then the one after that, in this order.',
      'CONSTRAINTS: Fail closed and never resend an ambiguous send under any circumstances.',
    ].join('\n'));

    expect(result.ok).toBe(true);
  });

  it('seeds the new conversation with the brief first and the carried follow-ups after it', () => {
    const seed = buildHandoffSeed(validBrief, ['  write the release notes  ', '', 'cut rc.5']);

    expect(seed).toHaveLength(3);
    expect(seed[0]).toContain(HANDOFF_SEED_INSTRUCTION);
    expect(seed[0]).toContain('NEXT STEPS:');
    expect(seed.slice(1)).toEqual(['write the release notes', 'cut rc.5']);
  });
});
