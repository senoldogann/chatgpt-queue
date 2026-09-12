import { describe, expect, it, vi } from 'vitest';
import { runCli, type CliDependencies, type CliIO } from '../../src/cli/flowrun';
import type { BridgeJobResult, BridgeTarget } from '../../src/bridge/protocol';

const workflowJson = JSON.stringify({
  version: 1,
  name: 'cli-live',
  inputs: { topic: { type: 'string', required: true } },
  steps: [{ id: 'one', type: 'chat', provider: 'chatgpt', prompt: 'Analyze {{ inputs.topic }}' }],
});

const makeIo = (files: Record<string, string> = {}) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIO = {
    readText: async (path) => {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
      return files[path]!;
    },
    out: (message) => stdout.push(message),
    err: (message) => stderr.push(message),
  };
  return { io, stdout, stderr };
};

const target = (id: string, busy = false): BridgeTarget => ({
  targetId: id,
  provider: 'chatgpt',
  conversationKey: `conv:${id}`,
  busy,
});

const makeDeps = (targets: BridgeTarget[]): CliDependencies & { follow: ReturnType<typeof vi.fn>; submit: ReturnType<typeof vi.fn> } => {
  const follow = vi.fn(async (jobId: string) => ({ version: 1, jobId, kind: 'run', status: 'completed' } satisfies BridgeJobResult));
  const submit = vi.fn(async () => ({
    jobId: '123e4567-e89b-42d3-a456-426614174000',
    result: { version: 1, jobId: '123e4567-e89b-42d3-a456-426614174000', kind: 'run', status: 'accepted' } satisfies BridgeJobResult,
  }));
  return {
    bridge: {
      listTargets: async () => targets,
      submitRun: submit,
      follow,
      status: async (jobId) => ({ version: 1, jobId, kind: 'run', status: 'running' }),
    },
    installBridge: vi.fn(async () => ({ launcherPath: '/tmp/launcher' })),
    doctorBridge: vi.fn(async () => ({ ok: true, checks: [{ name: 'manifest', ok: true }] })),
    follow,
    submit,
  };
};

describe('FlowRun CLI bridge commands', () => {
  it('lists active targets', async () => {
    const { io, stdout } = makeIo();
    const exitCode = await runCli(['targets'], io, makeDeps([target('target:1'), target('target:2', true)]));
    expect(exitCode).toBe(0);
    expect(stdout.join('\n')).toContain('target:1');
    expect(stdout.join('\n')).toContain('available');
    expect(stdout.join('\n')).toContain('busy');
  });

  it('auto-selects the single available target and detaches after acceptance', async () => {
    const { io, stdout } = makeIo({ 'workflow.json': workflowJson });
    const deps = makeDeps([target('target:1')]);
    const exitCode = await runCli(['run', 'workflow.json', '--input', 'topic=queues', '--detach'], io, deps);

    expect(exitCode).toBe(0);
    expect(deps.submit).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'target:1', inputs: { topic: 'queues' } }));
    expect(deps.follow).not.toHaveBeenCalled();
    expect(stdout.join('\n')).toContain('Accepted: 123e4567-e89b-42d3-a456-426614174000');
    expect(stdout.join('\n')).toContain('detached');
  });

  it('requires --target when multiple targets are available', async () => {
    const { io, stderr } = makeIo({ 'workflow.json': workflowJson });
    const deps = makeDeps([target('target:1'), target('target:2')]);
    expect(await runCli(['run', 'workflow.json', '--input', 'topic=queues'], io, deps)).toBe(2);
    expect(stderr.join('\n')).toContain('Multiple ChatGPT targets');
    expect(deps.submit).not.toHaveBeenCalled();
  });

  it('rejects missing or busy selected targets', async () => {
    const missing = makeIo({ 'workflow.json': workflowJson });
    expect(await runCli(['run', 'workflow.json', '--input', 'topic=queues', '--target', 'target:nope'], missing.io, makeDeps([target('target:1')]))).toBe(1);
    expect(missing.stderr.join('\n')).toContain('Target not available');

    const busy = makeIo({ 'workflow.json': workflowJson });
    expect(await runCli(['run', 'workflow.json', '--input', 'topic=queues', '--target', 'target:1'], busy.io, makeDeps([target('target:1', true)]))).toBe(1);
    expect(busy.stderr.join('\n')).toContain('busy');
  });

  it('follows to terminal state when not detached', async () => {
    const { io, stdout } = makeIo({ 'workflow.json': workflowJson });
    const deps = makeDeps([target('target:1')]);
    expect(await runCli(['run', 'workflow.json', '--input', 'topic=queues'], io, deps)).toBe(0);
    expect(deps.follow).toHaveBeenCalledTimes(1);
    expect(stdout.join('\n')).toContain('Run completed');
  });

  it('shows status without mutating the job', async () => {
    const { io, stdout } = makeIo();
    expect(await runCli(['status', '123e4567-e89b-42d3-a456-426614174000'], io, makeDeps([]))).toBe(0);
    expect(stdout.join('\n')).toContain('running');
  });

  it('supports bridge install and doctor commands', async () => {
    const install = makeIo();
    const installDeps = makeDeps([]);
    expect(await runCli(['bridge', 'install', '--extension-id', 'abcdefghijklmnopabcdefghijklmnop'], install.io, installDeps)).toBe(0);
    expect(installDeps.installBridge).toHaveBeenCalledWith('abcdefghijklmnopabcdefghijklmnop');

    const doctor = makeIo();
    const doctorDeps = makeDeps([]);
    expect(await runCli(['bridge', 'doctor'], doctor.io, doctorDeps)).toBe(0);
    expect(doctor.stdout.join('\n')).toContain('manifest: ok');
  });
});
