import type { MessageKey } from './i18n';

/**
 * The in-panel usage guide.
 *
 * Every step points at a real control in the shadow root so the guide can highlight what it is
 * talking about instead of describing a screenshot. Targets are best-effort: a step whose control
 * is not currently rendered (for example `Start queue` with an empty queue) falls through to a
 * fallback target or is shown without a highlight.
 */
export interface GuideStep {
  id: string;
  title: MessageKey;
  body: MessageKey;
  target: string;
  fallbackTargets?: readonly string[];
}

export const GUIDE_STEPS: readonly GuideStep[] = [
  {
    id: 'welcome',
    title: 'guide.welcome.title',
    body: 'guide.welcome.body',
    target: '.dock',
  },
  {
    id: 'add',
    title: 'guide.add.title',
    body: 'guide.add.body',
    target: '[data-role="new-message"]',
    fallbackTargets: ['.composer'],
  },
  {
    id: 'start',
    title: 'guide.start.title',
    body: 'guide.start.body',
    target: '[data-action="start"]',
    fallbackTargets: ['[data-action="pause"]', '[data-action="resume"]', '.toolbar'],
  },
  {
    id: 'items',
    title: 'guide.items.title',
    body: 'guide.items.body',
    target: 'li.item.queued',
    fallbackTargets: ['li.item', '.body ul', '[data-role="new-message"]'],
  },
  {
    id: 'status',
    title: 'guide.status.title',
    body: 'guide.status.body',
    target: '.status',
    fallbackTargets: ['.header'],
  },
  {
    id: 'context',
    title: 'guide.context.title',
    body: 'guide.context.body',
    target: '.context-section',
  },
  {
    id: 'handoff',
    title: 'guide.handoff.title',
    body: 'guide.handoff.body',
    target: '[data-action="prepare-handoff"]',
    fallbackTargets: ['[data-action="open-handoff"]', '.handoff-row'],
  },
  {
    id: 'workflow',
    title: 'guide.workflow.title',
    body: 'guide.workflow.body',
    target: '.workflow-section',
  },
  {
    id: 'bridge',
    title: 'guide.bridge.title',
    body: 'guide.bridge.body',
    target: '.bridge-row',
  },
  {
    id: 'interface',
    title: 'guide.interface.title',
    body: 'guide.interface.body',
    target: '[data-action="toggle-adapter-detail"]',
    fallbackTargets: ['[data-role="adapter-health"]', '.context-section'],
  },
];

export const GUIDE_STEP_COUNT = GUIDE_STEPS.length;

export const clampGuideIndex = (index: number): number =>
  Math.max(0, Math.min(GUIDE_STEP_COUNT - 1, Number.isFinite(index) ? Math.trunc(index) : 0));
