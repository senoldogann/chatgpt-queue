// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { GUIDE_STEP_COUNT, GUIDE_STEPS } from '../src/ui/guide';
import { QueuePanel } from '../src/ui/queue-panel';
import type { ConversationQueue } from '../src/domain/types';

const idleQueue = (): ConversationQueue => ({
  version: 1,
  id: 'q',
  conversationKey: 'conv:a',
  status: 'completed',
  items: [],
  runtime: { phase: 'idle' },
  createdAt: 1,
  updatedAt: 2,
});

const mount = (actions = {}) => {
  sessionStorage.clear();
  const host = document.createElement('div');
  document.body.append(host);
  const panel = new QueuePanel(host, actions);
  return { panel, root: host.shadowRoot! };
};

describe('QueuePanel usage guide', () => {
  it('is closed until the guide button is pressed, then shows the first step', () => {
    const { panel, root } = mount();
    panel.render(idleQueue());
    expect(root.querySelector('[data-role="guide-card"]')).toBeNull();
    expect(root.querySelector('[data-action="open-guide"]')!.getAttribute('aria-label')).toBe('Open the guide');

    root.querySelector<HTMLButtonElement>('[data-action="open-guide"]')!.click();
    const card = root.querySelector<HTMLElement>('[data-role="guide-card"]');
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain('Welcome');
    expect(card!.textContent).toContain(`Step 1 / ${GUIDE_STEP_COUNT}`);
    expect(root.querySelector<HTMLButtonElement>('[data-action="guide-prev"]')!.disabled).toBe(true);
    expect(root.querySelector('[data-action="guide-next"]')!.textContent).toBe('Next');
  });

  it('advances one step at a time and highlights what the step describes', () => {
    const { panel, root } = mount();
    panel.render(idleQueue());
    root.querySelector<HTMLButtonElement>('[data-action="open-guide"]')!.click();

    expect(root.querySelectorAll('.guide-highlight')).toHaveLength(1);
    expect(root.querySelector('.dock')?.classList.contains('guide-highlight')).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-action="guide-next"]')!.click();
    expect(root.querySelector('[data-role="guide-card"]')!.textContent).toContain('Add a follow-up');
    expect(root.querySelector('[data-role="guide-card"]')!.textContent).toContain(`Step 2 / ${GUIDE_STEP_COUNT}`);
    expect(root.querySelector('.dock')?.classList.contains('guide-highlight')).toBe(false);
    expect(root.querySelector('[data-role="new-message"]')?.classList.contains('guide-highlight')).toBe(true);

    root.querySelector<HTMLButtonElement>('[data-action="guide-prev"]')!.click();
    expect(root.querySelector('[data-role="guide-card"]')!.textContent).toContain('Welcome');
    expect(root.querySelector('.dock')?.classList.contains('guide-highlight')).toBe(true);
  });

  it('walks every step, then finishes and closes on the last one', () => {
    const { panel, root } = mount();
    panel.render(idleQueue());
    root.querySelector<HTMLButtonElement>('[data-action="open-guide"]')!.click();

    for (let index = 1; index < GUIDE_STEP_COUNT; index += 1) {
      root.querySelector<HTMLButtonElement>('[data-action="guide-next"]')!.click();
      expect(root.querySelector('[data-role="guide-card"]')!.textContent)
        .toContain(`Step ${index + 1} / ${GUIDE_STEP_COUNT}`);
    }
    expect(root.querySelector('[data-action="guide-next"]')!.textContent).toBe('Finish');

    root.querySelector<HTMLButtonElement>('[data-action="guide-next"]')!.click();
    expect(root.querySelector('[data-role="guide-card"]')).toBeNull();
    expect(root.querySelectorAll('.guide-highlight')).toHaveLength(0);
  });

  it('closes on Escape and exposes dots for visual progress', () => {
    const { panel, root } = mount();
    panel.render(idleQueue());
    root.querySelector<HTMLButtonElement>('[data-action="open-guide"]')!.click();
    expect(root.querySelectorAll('.guide-dot')).toHaveLength(GUIDE_STEP_COUNT);
    expect(root.querySelectorAll('.guide-dot.active')).toHaveLength(1);

    root.querySelector<HTMLElement>('[data-role="guide-card"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(root.querySelector('[data-role="guide-card"]')).toBeNull();
  });

  it('keeps the guide open across a re-render so a live queue update does not dismiss it', () => {
    const { panel, root } = mount();
    panel.render(idleQueue());
    root.querySelector<HTMLButtonElement>('[data-action="open-guide"]')!.click();
    root.querySelector<HTMLButtonElement>('[data-action="guide-next"]')!.click();

    panel.render({ ...idleQueue(), updatedAt: 99 });
    expect(root.querySelector('[data-role="guide-card"]')!.textContent).toContain(`Step 2 / ${GUIDE_STEP_COUNT}`);
  });
});

describe('QueuePanel locale', () => {
  it('renders English by default and offers auto/en/tr in the selector', () => {
    const { panel, root } = mount();
    panel.render(idleQueue());
    expect(root.textContent).toContain('No queued messages.');
    const select = root.querySelector<HTMLSelectElement>('[data-role="locale"]')!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(['auto', 'en', 'tr']);
  });

  it('renders the panel, guide and reasons in Turkish when the view asks for it', () => {
    const { panel, root } = mount();
    panel.render(idleQueue(), undefined, { locale: 'tr', localePreference: 'tr' });
    expect(root.textContent).toContain('Sırada mesaj yok.');
    expect(root.querySelector<HTMLSelectElement>('[data-role="locale"]')!.value).toBe('tr');

    root.querySelector<HTMLButtonElement>('[data-action="open-guide"]')!.click();
    expect(root.querySelector('[data-role="guide-card"]')!.textContent).toContain('Hoş geldiniz');
    expect(root.querySelector('[data-action="guide-next"]')!.textContent).toBe('İleri');

    panel.render({ ...idleQueue(), blockedReason: 'dom-unrecognized' }, undefined, { locale: 'tr' });
    expect(root.textContent).toContain('ChatGPT arayüzü tanınamadı');
  });

  it('localizes preset labels and descriptions without touching the workflow prompts', () => {
    const { panel, root } = mount();
    panel.render(idleQueue(), undefined, { locale: 'tr', localePreference: 'tr' });
    const select = root.querySelector<HTMLSelectElement>('[data-role="workflow-preset"]')!;
    expect(Array.from(select.options).map((option) => option.textContent)).toContain('Yayına Hazırlık');
    expect(root.querySelector('[data-role="workflow-preset-description"]')?.textContent).toContain('Kanıtlanmış');

    select.value = 'root-cause-debugging';
    select.dispatchEvent(new Event('change'));
    expect(root.querySelector('[data-role="workflow-preset-description"]')?.textContent).toContain('Kanıt öncelikli');
  });

  it('requests a locale change without translating the panel itself', async () => {
    const setLocale = vi.fn();
    const { panel, root } = mount({ setLocale });
    panel.render(idleQueue());
    const select = root.querySelector<HTMLSelectElement>('[data-role="locale"]')!;
    select.value = 'tr';
    select.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(setLocale).toHaveBeenCalledWith('tr');
  });
});
