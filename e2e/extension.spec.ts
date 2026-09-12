import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { createFixtureServer, type FixtureServer } from './fixture-server';

const extensionPath = resolve(import.meta.dirname, '..', 'dist-e2e');
const STORAGE_KEY = 'chatgptQueueState';
let fixture: FixtureServer;

const test = base.extend<{
  extensionContext: BrowserContext;
  extensionWorker: Worker;
}>({
  extensionContext: async ({}, use) => {
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    try {
      await use(context);
    } finally {
      await context.close();
    }
  },
  extensionWorker: async ({ extensionContext }, use) => {
    let [worker] = extensionContext.serviceWorkers();
    if (!worker) worker = await extensionContext.waitForEvent('serviceworker');
    await use(worker);
  },
});

test.beforeAll(async () => {
  fixture = await createFixtureServer();
});

test.afterAll(async () => {
  await fixture.close();
});

const queueRoot = (page: Page) => page.locator('#chatgpt-queue-extension-root');

async function openFixture(context: BrowserContext, path: string, tab = 'default'): Promise<Page> {
  const page = await context.newPage();
  const separator = path.includes('?') ? '&' : '?';
  await page.goto(`${fixture.origin}${path}${separator}tab=${encodeURIComponent(tab)}`);
  await expect(queueRoot(page)).toBeAttached();
  await expect(queueRoot(page).locator('textarea[data-role="new-message"]')).toBeVisible();
  return page;
}

async function addMessage(page: Page, content: string): Promise<void> {
  const root = queueRoot(page);
  await root.locator('textarea[data-role="new-message"]').fill(content);
  await root.locator('button[data-action="add"]').click();
  await expect(root.locator('li.item').filter({ hasText: content })).toBeVisible();
}

async function startQueue(page: Page): Promise<void> {
  await queueRoot(page).locator('button[data-action="start"]').click();
}

async function sentEvents(page: Page, conversationId: string): Promise<Array<{ content: string; tab: string }>> {
  return page.evaluate((id) => JSON.parse(localStorage.getItem(`fixture-sends:${id}`) ?? '[]'), conversationId);
}

async function storedQueue(worker: Worker, key: string): Promise<any | null> {
  return worker.evaluate(async ({ storageKey, queueKey }) => {
    const data = await chrome.storage.local.get(storageKey);
    const state = data[storageKey] as { queues?: Record<string, unknown> } | undefined;
    return state?.queues?.[queueKey] ?? null;
  }, { storageKey: STORAGE_KEY, queueKey: key });
}

async function storedState(worker: Worker): Promise<any> {
  return worker.evaluate(async (storageKey) => {
    const data = await chrome.storage.local.get(storageKey);
    return data[storageKey] ?? null;
  }, STORAGE_KEY);
}

async function forceStaleOwner(worker: Worker, key: string): Promise<void> {
  await worker.evaluate(async ({ storageKey, queueKey }) => {
    const data = await chrome.storage.local.get(storageKey);
    const state = data[storageKey] as any;
    const queue = state?.queues?.[queueKey];
    if (!queue) throw new Error(`missing queue ${queueKey}`);
    queue.owner = { tabId: 999999, leaseId: 'stale-owner', heartbeatAt: 0, expiresAt: 0 };
    await chrome.storage.local.set({ [storageKey]: state });
  }, { storageKey: STORAGE_KEY, queueKey: key });
}

async function stopExtensionServiceWorker(context: BrowserContext, worker: Worker): Promise<void> {
  const browser = context.browser();
  if (!browser) throw new Error('chromium-browser-handle-unavailable');
  const cdp = await browser.newBrowserCDPSession();
  try {
    const targets = await cdp.send('Target.getTargets') as { targetInfos: Array<{ targetId: string; type: string; url: string }> };
    const target = targets.targetInfos.find((candidate) => candidate.type === 'service_worker' && candidate.url === worker.url());
    if (!target) throw new Error('extension-service-worker-target-unavailable');
    await cdp.send('Target.closeTarget', { targetId: target.targetId });
  } finally {
    await cdp.detach();
  }
}

test('loads the unpacked MV3 extension and injects the queue UI', async ({ extensionContext, extensionWorker }) => {
  expect(extensionWorker.url()).toMatch(/^chrome-extension:\/\/.+\/background\.js$/);
  const page = await openFixture(extensionContext, '/c/load');
  await addMessage(page, 'queued from e2e');
  await expect(queueRoot(page)).toContainText('queued from e2e');
  const queue = await storedQueue(extensionWorker, 'conv:load');
  expect(queue.items).toHaveLength(1);
  expect(queue.items[0].state).toBe('queued');
});

test('sends through the authenticated composer when send appears only after input', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/authenticated?authenticated=1');
  await expect(page.locator('button[aria-label="Send message"]')).toHaveCount(0);
  await addMessage(page, 'authenticated follow-up');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'authenticated')).length).toBe(1);
  expect((await sentEvents(page, 'authenticated'))[0]?.content).toBe('authenticated follow-up');
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:authenticated'))?.runtime?.phase).toBe('generating');

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:authenticated'))?.status).toBe('completed');
  await expect(page.locator('button[aria-label="Send message"]')).toHaveCount(0);
});

test('waits through a transient unrecognized DOM between queued messages', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/transient-gap?authenticated=1&transient-gap=1');
  await addMessage(page, 'transient-first');
  await addMessage(page, 'transient-second');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'transient-gap')).length).toBe(1);
  await page.locator('#fixture-complete').click();

  await expect.poll(async () => (await sentEvents(page, 'transient-gap')).length).toBe(2);
  expect((await sentEvents(page, 'transient-gap')).map((event) => event.content)).toEqual(['transient-first', 'transient-second']);
  expect((await storedQueue(extensionWorker, 'conv:transient-gap')).status).toBe('running');

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:transient-gap'))?.status).toBe('completed');
});

test('recovers automatically when a long transient ChatGPT DOM gap caused dom-unrecognized', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/recover-dom-gap?authenticated=1&transient-gap-ms=2500');
  await addMessage(page, 'gap-first');
  await addMessage(page, 'gap-second');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'recover-dom-gap')).length).toBe(1);
  await page.locator('#fixture-complete').click();

  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:recover-dom-gap'))?.blockedReason).toBe('dom-unrecognized');
  await expect.poll(async () => (await sentEvents(page, 'recover-dom-gap')).length, { timeout: 8_000 }).toBe(2);
  const recovered = await storedQueue(extensionWorker, 'conv:recover-dom-gap');
  expect(recovered.status).toBe('running');
  expect(recovered.blockedReason).toBeUndefined();
  expect(recovered.items[0]?.state).toBe('completed');
  expect(recovered.items[1]?.state).toBe('running');
});

test('preserves add-input focus and draft after completion while ChatGPT DOM mutates', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/post-completion-focus');
  await addMessage(page, 'initial message');
  await startQueue(page);
  await expect.poll(async () => (await sentEvents(page, 'post-completion-focus')).length).toBe(1);
  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:post-completion-focus'))?.status).toBe('completed');

  const input = queueRoot(page).locator('textarea[data-role="new-message"]');
  await input.fill('added after completion');
  await input.focus();
  await page.evaluate(() => {
    const marker = document.createElement('span');
    marker.textContent = 'background ChatGPT mutation';
    document.body.append(marker);
  });
  await page.waitForTimeout(150);

  await expect(input).toHaveValue('added after completion');
  expect(await page.evaluate(() => {
    const host = document.querySelector('#chatgpt-queue-extension-root') as HTMLElement | null;
    return (host?.shadowRoot?.activeElement as HTMLElement | null)?.dataset.role ?? null;
  })).toBe('new-message');

  await queueRoot(page).locator('button[data-action="add"]').click();
  await expect(queueRoot(page).locator('li.item').filter({ hasText: 'added after completion' })).toBeVisible();
  expect((await storedQueue(extensionWorker, 'conv:post-completion-focus')).status).toBe('idle');
});

test('keeps start edit reorder delete and hide/show controls stable during ChatGPT DOM mutations', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/control-stability');
  await addMessage(page, 'alpha');
  await addMessage(page, 'beta');
  await addMessage(page, 'gamma');

  const initial = await storedQueue(extensionWorker, 'conv:control-stability');
  const alphaId = initial.items[0].id;
  const gammaId = initial.items[2].id;
  const root = queueRoot(page);

  await page.evaluate(() => {
    const host = document.querySelector('#chatgpt-queue-extension-root') as HTMLElement | null;
    const start = host?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="start"]');
    if (start) start.dataset.stabilityToken = 'keep';
    document.body.append(document.createElement('span'));
  });
  await page.waitForTimeout(120);
  await expect(root.locator('[data-action="start"]')).toHaveAttribute('data-stability-token', 'keep');

  await root.locator(`[data-action="down"][data-id="${alphaId}"]`).click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:control-stability')).items.filter((item: any) => item.state === 'queued').map((item: any) => item.content).join('|')).toBe('beta|alpha|gamma');

  const alphaInput = root.locator(`textarea[data-item-id="${alphaId}"]`);
  await alphaInput.fill('alpha edited');
  await page.evaluate(() => document.body.append(document.createElement('i')));
  await page.waitForTimeout(80);
  await root.locator(`[data-action="save"][data-id="${alphaId}"]`).click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:control-stability')).items.find((item: any) => item.id === alphaId)?.content).toBe('alpha edited');

  await root.locator(`[data-action="up"][data-id="${alphaId}"]`).click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:control-stability')).items.filter((item: any) => item.state === 'queued').map((item: any) => item.content).join('|')).toBe('alpha edited|beta|gamma');

  await page.evaluate(() => document.body.append(document.createElement('b')));
  await root.locator(`[data-action="delete"][data-id="${gammaId}"]`).click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:control-stability')).items.some((item: any) => item.id === gammaId)).toBe(false);

  await root.locator('[data-action="hide"]').click();
  await expect(root.locator('.dock')).toHaveClass(/collapsed/);
  await root.locator('[data-action="show"]').click();
  await expect(root.locator('.dock')).not.toHaveClass(/collapsed/);

  await page.evaluate(() => document.body.append(document.createElement('em')));
  await page.waitForTimeout(80);
  await root.locator('[data-action="start"]').click();
  await expect.poll(async () => (await sentEvents(page, 'control-stability')).length).toBe(1);
  expect((await sentEvents(page, 'control-stability'))[0]?.content).toBe('alpha edited');
});

test('sends one item at a time and ignores duplicate completion mutations', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/sequence', 'owner');
  await addMessage(page, 'first follow-up');
  await addMessage(page, 'second follow-up');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'sequence')).length).toBe(1);
  expect((await sentEvents(page, 'sequence'))[0]?.content).toBe('first follow-up');
  await page.waitForTimeout(1_100);
  expect(await sentEvents(page, 'sequence')).toHaveLength(1);

  await page.locator('#fixture-complete').click();
  await page.locator('#fixture-duplicate').click();
  await page.locator('#fixture-duplicate').click();
  await expect.poll(async () => (await sentEvents(page, 'sequence')).length).toBe(2);
  expect((await sentEvents(page, 'sequence')).map((event) => event.content)).toEqual(['first follow-up', 'second follow-up']);

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:sequence'))?.status).toBe('completed');
  const queue = await storedQueue(extensionWorker, 'conv:sequence');
  expect(queue.items.map((item: any) => item.state)).toEqual(['completed', 'completed']);
});

test('pause lets the active response finish but does not dispatch the next item until resume', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/pause');
  await addMessage(page, 'pause-first');
  await addMessage(page, 'pause-second');
  await startQueue(page);
  await expect.poll(async () => (await sentEvents(page, 'pause')).length).toBe(1);
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:pause'))?.runtime?.phase).toBe('generating');

  await queueRoot(page).locator('button[data-action="pause"]').click();
  await expect(queueRoot(page)).toContainText('Paused');

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:pause'))?.items?.[0]?.state).toBe('completed');
  const paused = await storedQueue(extensionWorker, 'conv:pause');
  expect(paused.status).toBe('paused');
  expect(paused.items.map((item: any) => item.state)).toEqual(['completed', 'queued']);
  expect(await sentEvents(page, 'pause')).toHaveLength(1);

  await queueRoot(page).locator('button[data-action="resume"]').click();
  await expect.poll(async () => (await sentEvents(page, 'pause')).length).toBe(2);
});

for (const scenario of [
  { name: 'blocking error', control: '#fixture-error', reason: 'network-error' },
  { name: 'confirmation UI', control: '#fixture-confirmation', reason: 'confirmation-required' },
]) {
  test(`blocks fail-closed on ${scenario.name}`, async ({ extensionContext, extensionWorker }) => {
    const id = scenario.reason.replace(/[^a-z]+/g, '-');
    const page = await openFixture(extensionContext, `/c/${id}`);
    await addMessage(page, `message-${id}`);
    await page.locator(scenario.control).click();
    await startQueue(page);

    await expect(queueRoot(page)).toContainText(`Blocked: ${scenario.reason}`);
    expect(await sentEvents(page, id)).toHaveLength(0);
    expect((await storedQueue(extensionWorker, `conv:${id}`)).status).toBe('blocked');
  });
}

test('blocks a stable ambiguous send instead of retrying it', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/uncertain');
  await page.locator('#fixture-uncertain').click();
  await addMessage(page, 'uncertain message');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'uncertain')).length).toBe(1);
  await expect(queueRoot(page)).toContainText('Blocked: send-not-confirmed');
  const queue = await storedQueue(extensionWorker, 'conv:uncertain');
  expect(queue.status).toBe('blocked');
  expect(queue.items[0].state).toBe('sending');
});

test('refresh recovers an unresolved sending item as uncertain-send without resending', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/refresh');
  await page.locator('#fixture-uncertain').click();
  await addMessage(page, 'refresh-sensitive');
  await startQueue(page);
  await expect.poll(async () => (await sentEvents(page, 'refresh')).length).toBe(1);

  await page.reload();
  await expect(queueRoot(page)).toBeAttached();
  await expect(queueRoot(page)).toContainText('Blocked: uncertain-send');
  expect(await sentEvents(page, 'refresh')).toHaveLength(1);
  expect((await storedQueue(extensionWorker, 'conv:refresh')).blockedReason).toBe('uncertain-send');
});

test('recovers a persisted legacy dom-unrecognized block when the ChatGPT DOM is healthy again', async ({ extensionContext, extensionWorker }) => {
  await extensionWorker.evaluate(async ({ storageKey, queueKey }) => {
    const now = Date.now();
    await chrome.storage.local.set({
      [storageKey]: {
        version: 1,
        queues: {
          [queueKey]: {
            version: 1,
            id: 'seed-dom-block',
            conversationKey: queueKey,
            status: 'blocked',
            blockedReason: 'dom-unrecognized',
            items: [{
              id: 'seed-item',
              content: 'Siradaki adimlar ile devam et.',
              state: 'running',
              dispatchToken: 'seed-dispatch',
              createdAt: now - 5_000,
              updatedAt: now - 4_000,
              startedAt: now - 4_000,
            }],
            runtime: {
              phase: 'blocked',
              activeItemId: 'seed-item',
              baselineAssistantCount: 0,
              generationObserved: true,
            },
            createdAt: now - 5_000,
            updatedAt: now - 4_000,
          },
        },
      },
    });
  }, { storageKey: STORAGE_KEY, queueKey: 'conv:legacy-dom-block' });

  const page = await openFixture(extensionContext, '/c/legacy-dom-block?seed-completed=1');
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:legacy-dom-block'))?.status).toBe('completed');
  const recovered = await storedQueue(extensionWorker, 'conv:legacy-dom-block');
  expect(recovered.blockedReason).toBeUndefined();
  expect(recovered.items[0]?.state).toBe('completed');
  await expect(queueRoot(page)).toContainText('Completed');
  await expect(queueRoot(page)).not.toContainText('dom-unrecognized');
});

test('reconciles a persisted paused running item when the page already shows its completed response', async ({ extensionContext, extensionWorker }) => {
  await extensionWorker.evaluate(async ({ storageKey, queueKey }) => {
    const now = Date.now();
    await chrome.storage.local.set({
      [storageKey]: {
        version: 1,
        queues: {
          [queueKey]: {
            version: 1,
            id: 'seed-paused-running',
            conversationKey: queueKey,
            status: 'paused',
            items: [{
              id: 'seed-item',
              content: 'Siradaki adimlar ile devam et.',
              state: 'running',
              dispatchToken: 'seed-dispatch',
              createdAt: now - 5_000,
              updatedAt: now - 4_000,
              startedAt: now - 4_000,
            }],
            runtime: {
              phase: 'generating',
              activeItemId: 'seed-item',
              baselineAssistantCount: 0,
              generationObserved: true,
            },
            createdAt: now - 5_000,
            updatedAt: now - 4_000,
          },
        },
      },
    });
  }, { storageKey: STORAGE_KEY, queueKey: 'conv:paused-recovery' });

  const page = await openFixture(extensionContext, '/c/paused-recovery?seed-completed=1');
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:paused-recovery'))?.status).toBe('completed');
  const recovered = await storedQueue(extensionWorker, 'conv:paused-recovery');
  expect(recovered.items[0]?.state).toBe('completed');
  await expect(queueRoot(page)).toContainText('Completed');
  await expect(queueRoot(page)).not.toContainText('Running');
});

test('reconciles a legacy generating item without copy action and continues the queue', async ({ extensionContext, extensionWorker }) => {
  await extensionWorker.evaluate(async ({ storageKey, queueKey }) => {
    const now = Date.now();
    await chrome.storage.local.set({
      [storageKey]: {
        version: 1,
        queues: {
          [queueKey]: {
            version: 1,
            id: 'seed-legacy-generating',
            conversationKey: queueKey,
            status: 'running',
            items: [
              {
                id: 'seed-running',
                content: 'already sent',
                state: 'running',
                dispatchToken: 'seed-dispatch',
                createdAt: now - 70_000,
                updatedAt: now - 60_000,
                startedAt: now - 60_000,
              },
              {
                id: 'seed-next',
                content: 'legacy-next-message',
                state: 'queued',
                createdAt: now - 50_000,
                updatedAt: now - 50_000,
              },
            ],
            runtime: {
              phase: 'generating',
              activeItemId: 'seed-running',
              baselineAssistantCount: 1,
              generationObserved: true,
            },
            createdAt: now - 70_000,
            updatedAt: now - 60_000,
          },
        },
      },
    });
  }, { storageKey: STORAGE_KEY, queueKey: 'conv:legacy-generating' });

  const page = await openFixture(extensionContext, '/c/legacy-generating?seed-completed-no-copy=1');
  await expect.poll(async () => (await sentEvents(page, 'legacy-generating')).length, { timeout: 10_000 }).toBe(1);
  expect((await sentEvents(page, 'legacy-generating')).map((event) => event.content)).toEqual(['legacy-next-message']);
  const afterRecovery = await storedQueue(extensionWorker, 'conv:legacy-generating');
  expect(afterRecovery.items[0]?.state).toBe('completed');
  expect(afterRecovery.items[1]?.state).toBe('running');

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:legacy-generating'))?.status).toBe('completed');
});

test('continues when the stop control is missed but the completed assistant turn is visible', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/missed-stop?omit-stop=1');
  await addMessage(page, 'background-first');
  await addMessage(page, 'background-second');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'missed-stop')).length).toBe(1);
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:missed-stop'))?.runtime?.phase).toBe('generating');
  expect((await storedQueue(extensionWorker, 'conv:missed-stop')).runtime.generationObserved).toBe(false);

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await sentEvents(page, 'missed-stop')).length).toBe(2);
  expect((await sentEvents(page, 'missed-stop')).map((event) => event.content)).toEqual(['background-first', 'background-second']);
  const afterFirst = await storedQueue(extensionWorker, 'conv:missed-stop');
  expect(afterFirst.status).toBe('running');
  expect(afterFirst.blockedReason).toBeUndefined();
  expect(afterFirst.items[0]?.state).toBe('completed');

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:missed-stop'))?.status).toBe('completed');
});

test('advances when long-chat virtualization replaces the latest assistant turn without increasing DOM count', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/virtualized-long?seed-completed=1&virtualize-assistant=1');
  await addMessage(page, 'virtualized-first');
  await addMessage(page, 'virtualized-second');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'virtualized-long')).length).toBe(1);
  const duringFirst = await storedQueue(extensionWorker, 'conv:virtualized-long');
  expect(duringFirst.runtime.baselineAssistantCount).toBe(1);
  expect(duringFirst.runtime.baselineAssistantTurnKey).toBeTruthy();
  expect(await page.locator('[data-message-author-role="assistant"]').count()).toBe(1);

  await page.locator('#fixture-complete').click();
  expect(await page.locator('[data-message-author-role="assistant"]').count()).toBe(1);
  await expect.poll(async () => (await sentEvents(page, 'virtualized-long')).length).toBe(2);
  expect((await sentEvents(page, 'virtualized-long')).map((event) => event.content)).toEqual(['virtualized-first', 'virtualized-second']);

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:virtualized-long'))?.status).toBe('completed');
});

test('does not reserve the next item while generation control is delayed', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/delayed-generation?authenticated=1&delayed-stop-ms=1400');
  await addMessage(page, 'delayed-first');
  await addMessage(page, 'delayed-second');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'delayed-generation')).length).toBe(1);
  await page.waitForTimeout(1_150);
  const queue = await storedQueue(extensionWorker, 'conv:delayed-generation');
  expect(queue.items).toHaveLength(2);
  expect(queue.items[1]?.state).toBe('queued');
  expect(await sentEvents(page, 'delayed-generation')).toHaveLength(1);

  await expect(page.locator('button[aria-label="Stop generating"]')).toHaveCount(1);
  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await sentEvents(page, 'delayed-generation')).length).toBe(2);
  expect((await sentEvents(page, 'delayed-generation')).map((event) => event.content)).toEqual(['delayed-first', 'delayed-second']);
});

test('preserves queued items across provisional WEB conversation id promotion', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/new?authenticated=1&route-on-send=WEB:provisional-123&route-chain-final=final-456');
  await addMessage(page, 'web-first');
  await addMessage(page, 'web-second');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'temporary')).length).toBe(1);
  await expect(page).toHaveURL(/\/c\/final-456/);
  await expect.poll(async () => Boolean(await storedQueue(extensionWorker, 'conv:final-456'))).toBe(true);
  const finalQueue = await storedQueue(extensionWorker, 'conv:final-456');
  expect(finalQueue.items).toHaveLength(2);
  expect(finalQueue.items[1]?.content).toBe('web-second');
  expect(finalQueue.items[1]?.state).toBe('queued');
  expect(await storedQueue(extensionWorker, 'conv:WEB:provisional-123')).toBeNull();

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await sentEvents(page, 'temporary')).length).toBe(2);
  expect((await sentEvents(page, 'temporary')).map((event) => event.content)).toEqual(['web-first', 'web-second']);
});

test('keeps an in-flight new-chat send running when the URL migrates to a conversation', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/new?authenticated=1&route-on-send=live-route');
  await addMessage(page, 'route-first');
  await addMessage(page, 'route-second');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'temporary')).length).toBe(1);
  await expect.poll(async () => Boolean(await storedQueue(extensionWorker, 'conv:live-route'))).toBe(true);
  const migrated = await storedQueue(extensionWorker, 'conv:live-route');
  expect(migrated.status).toBe('running');
  expect(migrated.blockedReason).toBeUndefined();
  expect(migrated.items).toHaveLength(2);
  expect(migrated.items.map((item: any) => item.state)).toEqual(['running', 'queued']);
  await page.waitForTimeout(1_500);
  const whileGenerating = await storedQueue(extensionWorker, 'conv:live-route');
  expect(whileGenerating.items).toHaveLength(2);
  expect(whileGenerating.items[1]?.state).toBe('queued');
  expect(whileGenerating.status).toBe('running');

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await sentEvents(page, 'temporary')).length).toBe(2);
  expect((await sentEvents(page, 'temporary')).map((event) => event.content)).toEqual(['route-first', 'route-second']);
});

test('migrates a temporary new-chat queue to the real conversation key', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/new');
  await addMessage(page, 'survive identity migration');

  const before = await storedState(extensionWorker);
  const temporaryKeys = Object.keys(before.queues).filter((key) => key.startsWith('temp:'));
  expect(temporaryKeys).toHaveLength(1);

  await page.evaluate(() => {
    history.pushState({}, '', '/c/migrated-conversation');
    document.body.append(document.createElement('span'));
  });

  await expect.poll(async () => Boolean((await storedQueue(extensionWorker, 'conv:migrated-conversation')))).toBe(true);
  const after = await storedState(extensionWorker);
  expect(after.queues[temporaryKeys[0]!]).toBeUndefined();
  await expect(queueRoot(page)).toContainText('survive identity migration');
});

test('keeps different conversations independent', async ({ extensionContext, extensionWorker }) => {
  const pageA = await openFixture(extensionContext, '/c/conversation-a', 'A');
  const pageB = await openFixture(extensionContext, '/c/conversation-b', 'B');
  await addMessage(pageA, 'from A');
  await addMessage(pageB, 'from B');
  await startQueue(pageA);
  await startQueue(pageB);

  await expect.poll(async () => (await sentEvents(pageA, 'conversation-a')).length).toBe(1);
  await expect.poll(async () => (await sentEvents(pageB, 'conversation-b')).length).toBe(1);
  expect((await sentEvents(pageA, 'conversation-a'))[0]?.tab).toBe('A');
  expect((await sentEvents(pageB, 'conversation-b'))[0]?.tab).toBe('B');
  expect((await storedQueue(extensionWorker, 'conv:conversation-a')).conversationKey).toBe('conv:conversation-a');
  expect((await storedQueue(extensionWorker, 'conv:conversation-b')).conversationKey).toBe('conv:conversation-b');
});

test('allows only one owner tab to drive the same conversation', async ({ extensionContext }) => {
  const owner = await openFixture(extensionContext, '/c/shared-owner', 'owner');
  const contender = await openFixture(extensionContext, '/c/shared-owner', 'contender');
  await addMessage(owner, 'owner-only');
  await expect(queueRoot(contender)).toContainText('owner-only');
  await startQueue(owner);
  await expect.poll(async () => (await sentEvents(owner, 'shared-owner')).length).toBe(1);

  await queueRoot(contender).locator('button[data-action="pause"]').click();
  await expect(queueRoot(contender)).toContainText('Owned by another tab');
  const events = await sentEvents(contender, 'shared-owner');
  expect(events).toHaveLength(1);
  expect(events[0]?.tab).toBe('owner');
});

test('takes over a stale persisted owner lease', async ({ extensionContext, extensionWorker }) => {
  const first = await openFixture(extensionContext, '/c/stale-owner', 'first');
  await addMessage(first, 'stale takeover');
  await forceStaleOwner(extensionWorker, 'conv:stale-owner');

  const second = await openFixture(extensionContext, '/c/stale-owner', 'second');
  await queueRoot(second).locator('button[data-action="start"]').click();
  await expect.poll(async () => (await sentEvents(second, 'stale-owner')).length).toBe(1);
  expect((await sentEvents(second, 'stale-owner'))[0]?.tab).toBe('second');
});

test('recovers an unresolved send after the MV3 service worker is stopped and restarted', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/worker-restart');
  await page.locator('#fixture-uncertain').click();
  await addMessage(page, 'worker restart');
  await startQueue(page);
  await expect.poll(async () => (await sentEvents(page, 'worker-restart')).length).toBe(1);

  await stopExtensionServiceWorker(extensionContext, extensionWorker);
  await page.reload();
  await expect(queueRoot(page)).toBeAttached();
  await expect(queueRoot(page)).toContainText('Blocked: uncertain-send');
  expect(await sentEvents(page, 'worker-restart')).toHaveLength(1);
});

test('keeps draining a queue while the page never becomes quiescent', async ({ extensionContext, extensionWorker }) => {
  test.setTimeout(60_000);
  const page = await openFixture(extensionContext, '/c/noisy-completion?noisy=1', 'noisy');
  await addMessage(page, 'noisy-first');
  await addMessage(page, 'noisy-second');
  await startQueue(page);
  await expect.poll(async () => (await sentEvents(page, 'noisy-completion')).length).toBe(1);

  // The response finishes, but unrelated page mutations keep clearing the quiet window.
  await page.locator('#fixture-complete').click();

  await expect.poll(async () => (await sentEvents(page, 'noisy-completion')).length, { timeout: 20_000 }).toBe(2);
  expect((await sentEvents(page, 'noisy-completion')).map((event) => event.content)).toEqual(['noisy-first', 'noisy-second']);
  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:noisy-completion'))?.status, { timeout: 20_000 }).toBe('completed');
  expect((await storedQueue(extensionWorker, 'conv:noisy-completion')).items.map((item: any) => item.state)).toEqual(['completed', 'completed']);
});
