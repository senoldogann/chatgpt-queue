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

test('pause preserves the active observation phase and resume continues safely', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/pause');
  await addMessage(page, 'pause-first');
  await addMessage(page, 'pause-second');
  await startQueue(page);
  await expect.poll(async () => (await sentEvents(page, 'pause')).length).toBe(1);
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:pause'))?.runtime?.phase).toBe('generating');

  await queueRoot(page).locator('button[data-action="pause"]').click();
  await expect(queueRoot(page)).toContainText('Paused');
  expect((await storedQueue(extensionWorker, 'conv:pause')).runtime.phase).toBe('generating');

  await page.locator('#fixture-complete').click();
  await page.waitForTimeout(1_100);
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

test('keeps an in-flight new-chat send running when the URL migrates to a conversation', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/new?authenticated=1&route-on-send=live-route');
  await addMessage(page, 'route-first');
  await addMessage(page, 'route-second');
  await startQueue(page);

  await expect.poll(async () => (await sentEvents(page, 'temporary')).length).toBe(1);
  await expect.poll(async () => Boolean(await storedQueue(extensionWorker, 'conv:live-route'))).toBe(true);
  expect((await storedQueue(extensionWorker, 'conv:live-route')).status).toBe('running');
  expect((await storedQueue(extensionWorker, 'conv:live-route')).blockedReason).toBeUndefined();

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
