import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { BridgeJobRequest } from './protocol';

const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export const MAX_COMPLETED_MAILBOX_JOBS = 200;

const assertJobId = (jobId: string): void => {
  if (!JOB_ID.test(jobId)) throw new Error('bridge.invalid-job-id');
};

const parseJson = <T>(text: string): T => JSON.parse(text) as T;

export class BridgeMailbox {
  readonly inboxDir: string;
  readonly eventsDir: string;
  readonly resultsDir: string;

  constructor(readonly root: string, private readonly maxCompletedJobs = MAX_COMPLETED_MAILBOX_JOBS) {
    this.inboxDir = join(root, 'inbox');
    this.eventsDir = join(root, 'events');
    this.resultsDir = join(root, 'results');
  }

  async ensure(): Promise<void> {
    await Promise.all([
      mkdir(this.root, { recursive: true, mode: 0o700 }),
      mkdir(this.inboxDir, { recursive: true, mode: 0o700 }),
      mkdir(this.eventsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.resultsDir, { recursive: true, mode: 0o700 }),
    ]);
  }

  private async atomicWriteJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, path);
  }

  async submit(request: BridgeJobRequest): Promise<void> {
    assertJobId(request.jobId);
    await this.ensure();
    await this.atomicWriteJson(join(this.inboxDir, `${request.jobId}.json`), request);
  }

  async readRequest(jobId: string): Promise<BridgeJobRequest> {
    assertJobId(jobId);
    return parseJson<BridgeJobRequest>(await readFile(join(this.inboxDir, `${jobId}.json`), 'utf8'));
  }

  async listRequests(): Promise<BridgeJobRequest[]> {
    await this.ensure();
    const names = (await readdir(this.inboxDir)).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name)).sort();
    const values: BridgeJobRequest[] = [];
    for (const name of names) {
      const jobId = name.slice(0, -5);
      try {
        values.push(await this.readRequest(jobId));
      } catch {
        // Ignore malformed/unreadable mailbox entries; protocol validation happens in the extension.
      }
    }
    return values;
  }

  async writeEvent(jobId: string, sequence: number, value: unknown): Promise<void> {
    assertJobId(jobId);
    if (!Number.isInteger(sequence) || sequence < 0) throw new Error('bridge.invalid-event-sequence');
    await this.ensure();
    const name = `${jobId}.${String(sequence).padStart(8, '0')}.json`;
    await this.atomicWriteJson(join(this.eventsDir, name), value);
  }

  async readEvents(jobId: string): Promise<unknown[]> {
    assertJobId(jobId);
    await this.ensure();
    const prefix = `${jobId}.`;
    const names = (await readdir(this.eventsDir))
      .filter((name) => name.startsWith(prefix) && name.endsWith('.json'))
      .sort();
    const events: unknown[] = [];
    for (const name of names) events.push(parseJson(await readFile(join(this.eventsDir, name), 'utf8')));
    return events;
  }

  async writeResult(jobId: string, value: unknown): Promise<void> {
    assertJobId(jobId);
    await this.ensure();
    await this.atomicWriteJson(join(this.resultsDir, `${jobId}.json`), value);
    await rm(join(this.inboxDir, `${jobId}.json`), { force: true });
    await this.cleanupCompletedJobs();
  }

  async readResult(jobId: string): Promise<unknown | undefined> {
    assertJobId(jobId);
    try {
      return parseJson(await readFile(join(this.resultsDir, `${jobId}.json`), 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async cleanupCompletedJobs(): Promise<void> {
    if (this.maxCompletedJobs < 1) return;
    const resultNames = (await readdir(this.resultsDir)).filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name));
    if (resultNames.length <= this.maxCompletedJobs) return;

    const dated = await Promise.all(resultNames.map(async (name) => ({
      name,
      mtimeMs: (await stat(join(this.resultsDir, name))).mtimeMs,
    })));
    dated.sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
    const remove = dated.slice(0, Math.max(0, dated.length - this.maxCompletedJobs));
    const eventNames = await readdir(this.eventsDir);

    for (const entry of remove) {
      const jobId = entry.name.slice(0, -5);
      await rm(join(this.resultsDir, entry.name), { force: true });
      for (const eventName of eventNames) {
        if (eventName.startsWith(`${jobId}.`) && eventName.endsWith('.json')) {
          await rm(join(this.eventsDir, eventName), { force: true });
        }
      }
    }
  }
}
