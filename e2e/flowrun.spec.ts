import { chromium, expect, test as base, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { resolve } from 'node:path';
import { createFixtureServer, type FixtureServer } from './fixture-server';

const extensionPath = resolve(import.meta.dirname, '..', 'dist-e2e');
const QUEUE_STORAGE_KEY = 'chatgptQueueState';
const FLOWRUN_STORAGE_KEY = 'flowrunState';
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

async function openFixture(context: BrowserContext, path: string): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`${fixture.origin}${path}`);
  await expect(queueRoot(page)).toBeAttached();
  await expect(queueRoot(page).locator('[data-role="workflow-file"]')).toBeAttached();
  return page;
}

async function loadWorkflow(page: Page, workflow: unknown): Promise<void> {
  await queueRoot(page).locator('[data-role="workflow-file"]').setInputFiles({
    name: 'test.flowrun.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(workflow)),
  });
}

async function sentEvents(page: Page, conversationId: string): Promise<Array<{ content: string }>> {
  return page.evaluate((id) => JSON.parse(localStorage.getItem(`fixture-sends:${id}`) ?? '[]'), conversationId);
}

async function latestFlowRun(worker: Worker): Promise<any | null> {
  return worker.evaluate(async (storageKey) => {
    const data = await chrome.storage.local.get(storageKey);
    const state = data[storageKey] as { runs?: Record<string, unknown>; order?: string[] } | undefined;
    const id = state?.order?.at(-1);
    return id ? state?.runs?.[id] ?? null : null;
  }, FLOWRUN_STORAGE_KEY);
}

async function storedQueue(worker: Worker, key: string): Promise<any | null> {
  return worker.evaluate(async ({ storageKey, queueKey }) => {
    const data = await chrome.storage.local.get(storageKey);
    const state = data[storageKey] as { queues?: Record<string, unknown> } | undefined;
    return state?.queues?.[queueKey] ?? null;
  }, { storageKey: QUEUE_STORAGE_KEY, queueKey: key });
}

const chainedWorkflow = {
  version: 1,
  name: 'live-chain',
  inputs: { topic: { type: 'string', required: true } },
  steps: [
    { id: 'review', type: 'chat', provider: 'chatgpt', prompt: 'Analyze {{ inputs.topic }}' },
    { id: 'tests', type: 'chat', provider: 'chatgpt', prompt: 'Write tests using: {{ steps.review.output }}' },
  ],
};

test('runs a live two-step workflow and chains the captured assistant output', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/flowrun-chain?response=architecture%20result&response=tests%20done');
  await loadWorkflow(page, chainedWorkflow);
  const root = queueRoot(page);
  await expect(root).toContainText('live-chain');
  await root.locator('[data-workflow-input="topic"]').fill('queue reliability');
  await root.locator('[data-action="run-workflow"]').click();

  await expect.poll(async () => (await sentEvents(page, 'flowrun-chain')).length).toBe(1);
  expect((await sentEvents(page, 'flowrun-chain'))[0]?.content).toBe('Analyze queue reliability');

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await sentEvents(page, 'flowrun-chain')).length).toBe(2);
  expect((await sentEvents(page, 'flowrun-chain'))[1]?.content).toBe('Write tests using: architecture result');

  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await latestFlowRun(extensionWorker))?.status).toBe('completed');
  const run = await latestFlowRun(extensionWorker);
  expect(run.steps.map((step: any) => step.output)).toEqual(['architecture result', 'tests done']);
  expect(run.events.at(-1)?.kind).toBe('run.completed');
  await expect(root).toContainText('Completed');
  await expect(root).toContainText('2 / 2');
});

test('blocks a live workflow on ChatGPT message delivery timeout without retrying', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/flowrun-timeout?delivery-timeout=1');
  await loadWorkflow(page, {
    version: 1,
    name: 'timeout-flow',
    inputs: {},
    steps: [{ id: 'send', type: 'chat', provider: 'chatgpt', prompt: 'one attempt' }],
  });
  await queueRoot(page).locator('[data-action="run-workflow"]').click();

  await expect.poll(async () => (await sentEvents(page, 'flowrun-timeout')).length).toBe(1);
  await expect.poll(async () => (await latestFlowRun(extensionWorker))?.status).toBe('blocked');
  expect((await latestFlowRun(extensionWorker)).steps[0].error).toBe('message-delivery-timeout');
  expect(await sentEvents(page, 'flowrun-timeout')).toHaveLength(1);
  await expect(queueRoot(page)).toContainText('message-delivery-timeout');
});

test('blocks an interrupted browser run after reload and never resends the active prompt', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/flowrun-reload');
  await loadWorkflow(page, {
    version: 1,
    name: 'reload-flow',
    inputs: {},
    steps: [{ id: 'first', type: 'chat', provider: 'chatgpt', prompt: 'do not resend' }],
  });
  await queueRoot(page).locator('[data-action="run-workflow"]').click();

  await expect.poll(async () => (await sentEvents(page, 'flowrun-reload')).length).toBe(1);
  await expect.poll(async () => (await latestFlowRun(extensionWorker))?.status).toBe('running');
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:flowrun-reload'))?.items?.[0]?.state).toBe('running');

  await page.reload();
  await expect(queueRoot(page)).toBeAttached();
  await expect.poll(async () => (await latestFlowRun(extensionWorker))?.status).toBe('blocked');
  const run = await latestFlowRun(extensionWorker);
  expect(run.events.at(-1)).toMatchObject({ kind: 'run.blocked', data: { reason: 'browser-session-interrupted' } });
  await page.waitForTimeout(1_200);
  expect(await sentEvents(page, 'flowrun-reload')).toHaveLength(1);
  await expect(queueRoot(page)).toContainText('browser-session-interrupted');
});
