import { describe, expect, it, vi } from 'vitest';
import {
  HANDOFF_TARGET_TTL_MS,
  handleHandoffRequest,
  type HandoffTarget,
} from '../src/runtime/handoff-handler';

const setup = (options: { tabId?: number; now?: number; target?: HandoffTarget } = {}) => {
  const created: string[] = [];
  let target = options.target;
  const targets = {
    get: async () => target,
    set: async (next: HandoffTarget) => { target = next; },
    clear: async () => { target = undefined; },
  };
  const dependencies = {
    now: () => options.now ?? 1_000,
    createTab: vi.fn(async (url: string) => {
      created.push(url);
      return { id: options.tabId ?? 42 };
    }),
    targets,
  };
  return { dependencies, created, currentTarget: () => target };
};

describe('handleHandoffRequest', () => {
  it('opens a same-origin new chat and remembers it as the only import target', async () => {
    const { dependencies, created, currentTarget } = setup();

    const result = await handleHandoffRequest(
      { type: 'handoffOpen', url: 'https://chatgpt.com/' },
      7,
      'https://chatgpt.com/c/abc',
      dependencies,
    );

    expect(result).toEqual({ tabId: 42 });
    expect(created).toEqual(['https://chatgpt.com/']);
    expect(currentTarget()).toEqual({ tabId: 42, createdAt: 1_000 });
  });

  it('refuses to open a cross-origin or non-http target', async () => {
    const { dependencies, created } = setup();

    await expect(handleHandoffRequest({ type: 'handoffOpen', url: 'https://evil.example/' }, 7, 'https://chatgpt.com/c/abc', dependencies))
      .rejects.toThrow('handoff-url-not-allowed');
    await expect(handleHandoffRequest({ type: 'handoffOpen', url: 'javascript:alert(1)' }, 7, 'https://chatgpt.com/c/abc', dependencies))
      .rejects.toThrow('handoff-url-not-allowed');
    expect(created).toEqual([]);
  });

  it('only lets the tab the extension opened claim the import, once', async () => {
    const { dependencies } = setup();
    await handleHandoffRequest({ type: 'handoffOpen', url: 'https://chatgpt.com/' }, 7, 'https://chatgpt.com/c/abc', dependencies);

    expect(await handleHandoffRequest({ type: 'handoffClaim' }, 999, undefined, dependencies)).toEqual({ claimed: false });
    expect(await handleHandoffRequest({ type: 'handoffClaim' }, 42, undefined, dependencies)).toEqual({ claimed: true });
    expect(await handleHandoffRequest({ type: 'handoffClaim' }, 42, undefined, dependencies)).toEqual({ claimed: false });
  });

  it('expires a stale claim instead of leaking it to a later tab', async () => {
    const { dependencies, currentTarget } = setup({
      target: { tabId: 42, createdAt: 0 },
      now: HANDOFF_TARGET_TTL_MS + 1,
    });

    expect(await handleHandoffRequest({ type: 'handoffClaim' }, 42, undefined, dependencies)).toEqual({ claimed: false });
    expect(currentTarget()).toBeUndefined();
  });

  it('fails closed when the sender URL is unavailable', async () => {
    const { dependencies } = setup();
    await expect(handleHandoffRequest({ type: 'handoffOpen', url: 'https://chatgpt.com/' }, 7, undefined, dependencies))
      .rejects.toThrow('handoff-sender-url-unavailable');
  });
});
