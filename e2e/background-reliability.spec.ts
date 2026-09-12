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

async function openFixture(context: BrowserContext, id: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/c/${id}?omit-stop=1&auto-complete-ms=200&tab=${id}`);
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

async function sentEvents(page: Page, id: string): Promise<Array<{ content: string }>> {
  return page.evaluate((conversationId) => JSON.parse(localStorage.getItem(`fixture-sends:${conversationId}`) ?? '[]'), id);
}

async function storedQueue(worker: Worker, key: string): Promise<any | null> {
  return worker.evaluate(async ({ storageKey, queueKey }) => {
    const data = await chrome.storage.local.get(storageKey);
    const state = data[storageKey] as { queues?: Record<string, unknown> } | undefined;
    return state?.queues?.[queueKey] ?? null;
  }, { storageKey: STORAGE_KEY, queueKey: key });
}

test('drains three background queues when generation controls are missed', async ({ extensionContext, extensionWorker }) => {
  test.setTimeout(30_000);
  const ids = ['background-a', 'background-b', 'background-c'];
  const pages: Page[] = [];

  for (const id of ids) {
    const page = await openFixture(extensionContext, id);
    pages.push(page);
    for (let index = 1; index <= 4; index += 1) {
      await addMessage(page, `${id}-${index}`);
    }
    await queueRoot(page).locator('button[data-action="start"]').click();
  }

  const foreground = await extensionContext.newPage();
  await foreground.goto('about:blank');
  await foreground.bringToFront();

  for (let index = 0; index < ids.length; index += 1) {
    const id = ids[index]!;
    const page = pages[index]!;
    await expect.poll(async () => (await sentEvents(page, id)).length, { timeout: 15_000 }).toBe(4);
    await expect.poll(async () => (await storedQueue(extensionWorker, `conv:${id}`))?.status, { timeout: 15_000 }).toBe('completed');
    expect((await sentEvents(page, id)).map((event) => event.content)).toEqual([
      `${id}-1`,
      `${id}-2`,
      `${id}-3`,
      `${id}-4`,
    ]);
  }
});
