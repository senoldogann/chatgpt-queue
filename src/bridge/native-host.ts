import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { BridgeMailbox } from './mailbox';
import { encodeNativeMessage, NativeFrameDecoder } from './native-framing';

interface HostConfig {
  version: 1;
  secret: string;
  bridgeRoot: string;
  extensionId: string;
}

const configPath = join(homedir(), '.flowrun', 'bridge', 'config.json');
const config = JSON.parse(await readFile(configPath, 'utf8')) as HostConfig;
const mailbox = new BridgeMailbox(config.bridgeRoot);
await mailbox.ensure();

const sent = new Set<string>();
const terminal = new Set(['completed', 'blocked', 'failed']);

const emit = (value: unknown): void => {
  process.stdout.write(encodeNativeMessage(value));
};

emit({ type: 'bridge.hello', version: 1, secret: config.secret });

const poll = async (): Promise<void> => {
  const requests = await mailbox.listRequests();
  for (const request of requests) {
    if (sent.has(request.jobId)) continue;
    sent.add(request.jobId);
    emit(request);
  }
};

const decoder = new NativeFrameDecoder();
process.stdin.on('data', (chunk: Buffer) => {
  try {
    for (const message of decoder.push(chunk)) {
      if (!message || typeof message !== 'object') continue;
      const record = message as Record<string, unknown>;
      const jobId = typeof record.jobId === 'string' ? record.jobId : undefined;
      if (!jobId) continue;
      void mailbox.appendEvent(jobId, message).then(async () => {
        if (record.kind === 'targets' || (typeof record.status === 'string' && terminal.has(record.status))) {
          await mailbox.writeResult(jobId, message);
        }
      }).catch(() => undefined);
    }
  } catch {
    process.exitCode = 1;
  }
});

process.stdin.resume();
await poll();
setInterval(() => { void poll().catch(() => undefined); }, 250);
