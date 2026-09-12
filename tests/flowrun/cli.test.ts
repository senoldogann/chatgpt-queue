import { describe, expect, it } from 'vitest';
import { runCli, type CliIO } from '../../src/cli/flowrun';

const workflowJson = JSON.stringify({
  version: 1,
  name: 'cli-test',
  inputs: { topic: { type: 'string', required: true } },
  steps: [
    { id: 'first', type: 'chat', provider: 'chatgpt', prompt: 'Analyze {{ inputs.topic }}' },
    { id: 'second', type: 'chat', provider: 'chatgpt', prompt: 'Continue {{ steps.first.output }}' },
  ],
});

const runJson = JSON.stringify({
  id: 'run-1',
  workflowName: 'cli-test',
  workflowVersion: 1,
  status: 'completed',
  inputs: { topic: 'queues' },
  steps: [{ id: 'first', status: 'completed', output: 'done' }],
  events: [{ id: 'e1', runId: 'run-1', at: 1, kind: 'run.completed', data: {} }],
  createdAt: 1,
  updatedAt: 2,
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

describe('FlowRun CLI', () => {
  it('validates a workflow file', async () => {
    const { io, stdout, stderr } = makeIo({ 'workflow.json': workflowJson });
    const exitCode = await runCli(['validate', 'workflow.json'], io);
    expect(exitCode).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join('\n')).toContain('Valid workflow: cli-test');
    expect(stdout.join('\n')).toContain('2 steps');
  });

  it('dry-runs with explicit key=value inputs', async () => {
    const { io, stdout } = makeIo({ 'workflow.json': workflowJson });
    const exitCode = await runCli(['dry-run', 'workflow.json', '--input', 'topic=queues'], io);
    expect(exitCode).toBe(0);
    const text = stdout.join('\n');
    expect(text).toContain('Analyze queues');
    expect(text).toContain('Continue <output:first>');
  });

  it('rejects dry-run when a required input is missing', async () => {
    const { io, stderr } = makeIo({ 'workflow.json': workflowJson });
    const exitCode = await runCli(['dry-run', 'workflow.json'], io);
    expect(exitCode).toBe(1);
    expect(stderr.join('\n')).toContain('input.missing_required');
  });

  it('inspects a serialized run', async () => {
    const { io, stdout } = makeIo({ 'run.json': runJson });
    const exitCode = await runCli(['inspect', 'run.json'], io);
    expect(exitCode).toBe(0);
    expect(stdout.join('\n')).toContain('Status: completed');
    expect(stdout.join('\n')).toContain('first: completed');
  });

  it('returns non-zero for malformed JSON, missing files, and unknown commands', async () => {
    const malformed = makeIo({ 'bad.json': '{ nope' });
    expect(await runCli(['validate', 'bad.json'], malformed.io)).toBe(1);
    expect(malformed.stderr.join('\n')).toContain('Invalid JSON');

    const missing = makeIo();
    expect(await runCli(['validate', 'missing.json'], missing.io)).toBe(1);
    expect(missing.stderr.join('\n')).toContain('Unable to read');

    const unknown = makeIo();
    expect(await runCli(['explode'], unknown.io)).toBe(2);
    expect(unknown.stderr.join('\n')).toContain('Usage:');
  });

  it('rejects malformed --input arguments', async () => {
    const { io, stderr } = makeIo({ 'workflow.json': workflowJson });
    const exitCode = await runCli(['dry-run', 'workflow.json', '--input', 'not-a-pair'], io);
    expect(exitCode).toBe(2);
    expect(stderr.join('\n')).toContain('key=value');
  });
});
