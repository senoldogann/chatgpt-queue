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

const handoffBrief = [
  'STATE: the queue runtime stores durable state in chrome.storage.local and the CLI bridge is connected.',
  'DECISIONS: queue advancement is observation-driven and elapsed time is never used to guess completion.',
  'OPEN QUESTIONS: whether the current ChatGPT web build exposes any compaction control at all.',
  'NEXT STEPS: ship the context meter, then validate the handoff path in a real browser session.',
  'CONSTRAINTS: fail closed on any unrecognized DOM and never resend an ambiguous send.',
].join('\n');

test('reports the live adapter interface health and a local context estimate in the panel', async ({ extensionContext }) => {
  const page = await openFixture(extensionContext, '/c/interface-health');
  const root = queueRoot(page);

  await expect(root.locator('[data-role="adapter-health"]')).toHaveText('interface ok');
  await expect(root.locator('[data-role="context-detail"]')).toContainText('(est.');
  await expect(root.locator('[data-action="prepare-handoff"]')).toBeEnabled();

  const detail = root.locator('[data-role="adapter-detail"]');
  await expect(detail).toBeHidden();
  await root.locator('[data-action="toggle-adapter-detail"]').click();
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('composer=TEXTAREA#prompt-textarea');
  await expect(detail).toContainText('send-testid=true');
});

test('compacts a near-limit conversation into a fresh chat and carries the queued follow-ups', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, `/c/handoff-source?auto-complete-ms=50&response=${encodeURIComponent(handoffBrief)}`);
  const root = queueRoot(page);

  await root.locator('[data-role="new-message"]').fill('carry me one');
  await root.locator('[data-action="add"]').click();
  await root.locator('[data-role="new-message"]').fill('carry me two');
  await root.locator('[data-action="add"]').click();
  await expect(root.locator('textarea[data-item-id]')).toHaveCount(2);

  await root.locator('[data-action="prepare-handoff"]').click();
  await expect(root).toContainText('Preparing handoff brief');

  // The brief prompt is dispatched first, ahead of the carried follow-ups.
  await expect.poll(async () => (await sentEvents(page, 'handoff-source')).length).toBe(1);
  expect((await sentEvents(page, 'handoff-source'))[0]?.content).toContain('Produce a handoff brief');

  await expect(root).toContainText('Handoff ready');
  await expect(root).toContainText('2 items carried');
  // The source queue pauses, so the carried follow-ups are not spent on a conversation at its limit.
  await expect.poll(async () => (await storedQueue(extensionWorker, 'conv:handoff-source'))?.status).toBe('paused');
  await page.waitForTimeout(600);
  expect(await sentEvents(page, 'handoff-source')).toHaveLength(1);

  const newPagePromise = extensionContext.waitForEvent('page');
  await root.locator('[data-action="open-handoff"]').click();
  const newPage = await newPagePromise;
  await expect(queueRoot(newPage)).toBeAttached();
  await expect(queueRoot(newPage)).toContainText('Handoff imported');

  const tempKey = await extensionWorker.evaluate(async () => {
    const data = await chrome.storage.local.get('chatgptQueueState');
    const queues = (data.chatgptQueueState as { queues?: Record<string, unknown> } | undefined)?.queues ?? {};
    return Object.keys(queues).find((key) => key.startsWith('temp:')) ?? null;
  });
  expect(tempKey).toBeTruthy();

  const imported = await storedQueue(extensionWorker, tempKey!);
  const contents = (imported.items as Array<{ content: string }>).map((item) => item.content);
  expect(contents).toHaveLength(3);
  expect(contents[0]).toContain('Handoff brief from the previous conversation');
  expect(contents[0]).toContain('NEXT STEPS:');
  expect(contents.slice(1)).toEqual(['carry me one', 'carry me two']);
  // Nothing is sent into the fresh conversation without an explicit start.
  expect(await sentEvents(newPage, 'temporary')).toHaveLength(0);
});

test('loads a built-in professional workflow preset without requiring a file', async ({ extensionContext }) => {
  const page = await openFixture(extensionContext, '/c/preset-load');
  const root = queueRoot(page);

  await root.locator('[data-role="workflow-preset"]').selectOption('implementation-plan');
  await root.locator('[data-action="load-workflow-preset"]').click();

  await expect(root).toContainText('implementation-plan');
  await expect(root).toContainText('4 steps');
  await expect(root.locator('[data-workflow-input="requirements"]')).toBeAttached();
  await expect(root.locator('[data-workflow-input="context"]')).toBeAttached();
});

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


test('reconciles an interrupted bridge run after reload and never resends its active prompt', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/bridge-reload');
  const root = queueRoot(page);
  await expect.poll(() => root.getAttribute('data-flowrun-bridge-target')).not.toBeNull();
  const targetId = await root.getAttribute('data-flowrun-bridge-target');
  expect(targetId).toBeTruthy();

  const jobId = '123e4567-e89b-42d3-a456-426614174098';
  await extensionWorker.evaluate(async ({ jobId, targetId }) => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const ownerTabId = tabs.find((tab) => tab.id !== undefined)?.id;
    if (ownerTabId === undefined) throw new Error('fixture-tab-not-found');
    await chrome.storage.local.set({
      flowrunBridgeJobs: {
        version: 1,
        jobs: {
          [jobId]: {
            version: 1, jobId, kind: 'run', targetId, conversationKey: 'conv:bridge-reload', ownerTabId,
            status: 'accepted', createdAt: Date.now(), updatedAt: Date.now(),
          },
        },
        order: [jobId],
      },
    });
    await chrome.tabs.sendMessage(ownerTabId, {
      type: 'bridgeRun', jobId, targetId, workflow: {
        version: 1,
        name: 'bridge-reload',
        inputs: {},
        steps: [{ id: 'first', type: 'chat', provider: 'chatgpt', prompt: 'bridge reload prompt' }],
      }, inputs: {},
    });
  }, { jobId, targetId: targetId! });

  await expect.poll(async () => (await sentEvents(page, 'bridge-reload')).length).toBe(1);
  await expect.poll(async () => {
    const data = await extensionWorker.evaluate(async (jobId) => {
      const stored = await chrome.storage.local.get('flowrunBridgeJobs');
      return (stored.flowrunBridgeJobs as any)?.jobs?.[jobId] ?? null;
    }, jobId);
    return data?.status;
  }).toBe('running');

  await page.reload();
  await expect(queueRoot(page)).toBeAttached();
  await expect.poll(async () => {
    const data = await extensionWorker.evaluate(async (jobId) => {
      const stored = await chrome.storage.local.get('flowrunBridgeJobs');
      return (stored.flowrunBridgeJobs as any)?.jobs?.[jobId] ?? null;
    }, jobId);
    return data?.status;
  }).toBe('blocked');
  const record = await extensionWorker.evaluate(async (jobId) => {
    const stored = await chrome.storage.local.get('flowrunBridgeJobs');
    return (stored.flowrunBridgeJobs as any)?.jobs?.[jobId] ?? null;
  }, jobId);
  expect(record).toMatchObject({ status: 'blocked', workflowRunId: expect.any(String), error: 'browser-session-interrupted' });
  await page.waitForTimeout(800);
  expect(await sentEvents(page, 'bridge-reload')).toHaveLength(1);
});

test('accepts an unattended workflow through the real background bridge path', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/bridge-acceptance?response=accepted%20one&response=accepted%20two');
  const root = queueRoot(page);
  await expect.poll(() => root.getAttribute('data-flowrun-bridge-target')).not.toBeNull();
  const targetId = await root.getAttribute('data-flowrun-bridge-target');
  expect(targetId).toBeTruthy();

  const jobId = '123e4567-e89b-42d3-a456-426614174097';
  await extensionWorker.evaluate(async ({ jobId, targetId, workflow }) => {
    const bridge = (globalThis as typeof globalThis & { __flowrunE2eNativeMessage?: (message: unknown) => Promise<void> }).__flowrunE2eNativeMessage;
    if (!bridge) throw new Error('bridge-e2e-hook-missing');
    const now = Date.now();
    await bridge({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    await bridge({
      version: 1, jobId, secret: 'a'.repeat(64), kind: 'run', createdAt: now, expiresAt: now + 60_000,
      payload: { workflow, inputs: { topic: 'acceptance' }, targetId },
    });
  }, { jobId, targetId: targetId!, workflow: chainedWorkflow });

  await expect.poll(async () => (await sentEvents(page, 'bridge-acceptance')).length).toBe(1);
  expect((await sentEvents(page, 'bridge-acceptance'))[0]?.content).toBe('Analyze acceptance');
  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await sentEvents(page, 'bridge-acceptance')).length).toBe(2);
  await page.locator('#fixture-complete').click();
  await expect.poll(async () => {
    const data = await extensionWorker.evaluate(async (id) => {
      const stored = await chrome.storage.local.get('flowrunBridgeJobs');
      return (stored.flowrunBridgeJobs as any)?.jobs?.[id] ?? null;
    }, jobId);
    return data?.status;
  }).toBe('completed');
  expect(await sentEvents(page, 'bridge-acceptance')).toHaveLength(2);
});

test('runs an accepted bridge workflow after the CLI side detaches and ignores duplicate delivery', async ({ extensionContext, extensionWorker }) => {
  const page = await openFixture(extensionContext, '/c/bridge-detach?response=bridge%20review&response=bridge%20tests');
  const root = queueRoot(page);
  await expect.poll(() => root.getAttribute('data-flowrun-bridge-target')).not.toBeNull();
  const targetId = await root.getAttribute('data-flowrun-bridge-target');
  expect(targetId).toBeTruthy();

  const jobId = '123e4567-e89b-42d3-a456-426614174099';
  await extensionWorker.evaluate(async ({ jobId, targetId }) => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const ownerTabId = tabs.find((tab) => tab.id !== undefined)?.id;
    if (ownerTabId === undefined) throw new Error('fixture-tab-not-found');
    await chrome.storage.local.set({
      flowrunBridgeJobs: {
        version: 1,
        jobs: {
          [jobId]: {
            version: 1, jobId, kind: 'run', targetId, conversationKey: 'conv:bridge-detach', ownerTabId,
            status: 'accepted', createdAt: Date.now(), updatedAt: Date.now(),
          },
        },
        order: [jobId],
      },
    });
  }, { jobId, targetId: targetId! });

  const sendBridgeRun = () => extensionWorker.evaluate(async ({ jobId, targetId, workflow }) => {
    const tabs = await chrome.tabs.query({ url: 'http://127.0.0.1/*' });
    const tabId = tabs.find((tab) => tab.id !== undefined)?.id;
    if (tabId === undefined) throw new Error('fixture-tab-not-found');
    return chrome.tabs.sendMessage(tabId, { type: 'bridgeRun', jobId, targetId, workflow, inputs: { topic: 'unattended' } });
  }, { jobId, targetId: targetId!, workflow: chainedWorkflow });

  expect(await sendBridgeRun()).toMatchObject({ ok: true });
  await expect.poll(async () => (await sentEvents(page, 'bridge-detach')).length).toBe(1);
  expect((await sentEvents(page, 'bridge-detach'))[0]?.content).toBe('Analyze unattended');

  // Simulate the CLI being gone: no further bridge/CLI interaction occurs.
  await page.locator('#fixture-complete').click();
  await expect.poll(async () => (await sentEvents(page, 'bridge-detach')).length).toBe(2);
  expect((await sentEvents(page, 'bridge-detach'))[1]?.content).toBe('Write tests using: bridge review');
  await page.locator('#fixture-complete').click();

  await expect.poll(async () => (await latestFlowRun(extensionWorker))?.status).toBe('completed');
  const bridgeRecord = await extensionWorker.evaluate(async (jobId) => {
    const data = await chrome.storage.local.get('flowrunBridgeJobs');
    return (data.flowrunBridgeJobs as any)?.jobs?.[jobId] ?? null;
  }, jobId);
  expect(bridgeRecord).toMatchObject({ status: 'completed', workflowRunId: expect.any(String) });

  expect(await sendBridgeRun()).toMatchObject({ ok: true });
  await page.waitForTimeout(600);
  expect(await sentEvents(page, 'bridge-detach')).toHaveLength(2);
});
