// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { QueuePanel } from '../src/ui/queue-panel';
import type { ConversationQueue } from '../src/domain/types';

const stuckQueue = (): ConversationQueue => ({
  version: 1,
  id: 'q',
  conversationKey: 'conv:a',
  status: 'running',
  items: [
    { id: 'active', content: 'keep going', state: 'running', createdAt: 1, updatedAt: 1, dispatchToken: 'd' },
    { id: 'next', content: 'and then', state: 'queued', createdAt: 1, updatedAt: 1 },
  ],
  runtime: { phase: 'generating', activeItemId: 'active', generationObserved: true },
  createdAt: 1,
  updatedAt: 1,
});

const mount = (view: Parameters<QueuePanel['render']>[2]) => {
  sessionStorage.clear();
  const host = document.createElement('div');
  document.body.append(host);
  const panel = new QueuePanel(host, {});
  panel.render(stuckQueue(), undefined, view);
  return host.shadowRoot!;
};

describe('QueuePanel stale states', () => {
  it('shows nothing extra while the extension is reachable', () => {
    const root = mount({});
    expect(root.querySelector('[data-role="stale-banner"]')).toBeNull();
    expect(root.querySelector('[data-role="driver-stalled"]')).toBeNull();
    expect(root.querySelector('.status')?.textContent).toBe('Running');
    expect(root.querySelector('.dock')?.classList.contains('stale')).toBe(false);
  });

  it('reports a disconnected panel instead of a running queue when the extension is gone', () => {
    const root = mount({ stale: true });
    const banner = root.querySelector('[data-role="stale-banner"]');
    expect(banner).not.toBeNull();
    expect(banner!.textContent).toContain('Extension reloaded');
    expect(banner!.textContent).toContain('Reload this page');
    expect(root.querySelector('.status')?.textContent).toBe('Disconnected');
    expect(root.querySelector('[data-role="activity-spinner"]')).toBeNull();
    expect(root.querySelector('.dock')?.classList.contains('stale')).toBe(true);
    // The queue itself stays readable, because it is the user's data.
    expect(root.textContent).toContain('keep going');
    expect(root.textContent).toContain('and then');
  });

  it('removes every control that could no longer work from a disconnected panel', () => {
    const root = mount({ stale: true });
    const css = root.querySelector('style')?.textContent ?? '';
    for (const selector of ['.toolbar', '.composer', '.row-actions', '.workflow-section', '.bridge-row', '.handoff-row', '.capacity-row']) {
      expect(css, selector).toContain(`.dock.stale ${selector}`);
    }
  });

  it('explains a stalled queue whose driver stopped responding', () => {
    const root = mount({ driverStalled: true });
    const notice = root.querySelector('[data-role="driver-stalled"]');
    expect(notice).not.toBeNull();
    expect(notice!.textContent).toContain('stopped responding');
    expect(root.querySelector('[data-role="stale-banner"]')).toBeNull();
    expect(root.querySelector('.status')?.textContent).toBe('Running');
  });

  it('prefers the disconnected state over the stalled notice when both are true', () => {
    const root = mount({ stale: true, driverStalled: true });
    expect(root.querySelector('[data-role="stale-banner"]')).not.toBeNull();
    expect(root.querySelector('[data-role="driver-stalled"]')).toBeNull();
  });
});
