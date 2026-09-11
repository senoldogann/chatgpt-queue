import { pathToFileURL } from 'node:url';
import { createDryRunPlan, formatDryRunPlan, formatRunInspection } from '../flowrun/inspect';
import type { WorkflowRun } from '../flowrun/events';
import { validateWorkflowDocument } from '../flowrun/schema';
import { nodeCliIO } from './io';

export interface CliIO {
  readText(path: string): Promise<string>;
  out(message: string): void;
  err(message: string): void;
}

const usage = (): string => [
  'Usage:',
  '  flowrun validate <workflow.json>',
  '  flowrun dry-run <workflow.json> --input key=value [--input key=value ...]',
  '  flowrun inspect <run.json>',
].join('\n');

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const parseJson = (text: string): { ok: true; value: unknown } | { ok: false; message: string } => {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
};

const readJson = async (
  path: string,
  io: CliIO,
): Promise<{ ok: true; value: unknown } | { ok: false; exitCode: number }> => {
  let text: string;
  try {
    text = await io.readText(path);
  } catch (error) {
    io.err(`Unable to read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return { ok: false, exitCode: 1 };
  }

  const parsed = parseJson(text);
  if (!parsed.ok) {
    io.err(`Invalid JSON in ${path}: ${parsed.message}`);
    return { ok: false, exitCode: 1 };
  }
  return parsed;
};

const formatValidationErrors = (errors: Array<{ code: string; path: string; message: string }>): string =>
  errors.map((error) => `${error.code} ${error.path}: ${error.message}`).join('\n');

const parseInputArgs = (args: string[]): { ok: true; inputs: Record<string, string> } | { ok: false; message: string } => {
  const inputs: Record<string, string> = {};
  let index = 0;
  while (index < args.length) {
    if (args[index] !== '--input') {
      return { ok: false, message: `Unexpected argument: ${args[index]}` };
    }
    const pair = args[index + 1];
    if (!pair) return { ok: false, message: '--input requires key=value' };
    const equals = pair.indexOf('=');
    if (equals <= 0) return { ok: false, message: '--input requires key=value' };
    const key = pair.slice(0, equals);
    const value = pair.slice(equals + 1);
    inputs[key] = value;
    index += 2;
  }
  return { ok: true, inputs };
};

const workflowRunStatuses = new Set(['pending', 'running', 'blocked', 'completed', 'failed']);
const stepStatuses = new Set(['pending', 'ready', 'dispatching', 'waiting', 'completed', 'blocked', 'failed']);
const eventKinds = new Set([
  'run.created',
  'run.started',
  'step.ready',
  'step.dispatch_reserved',
  'step.dispatch_confirmed',
  'step.output_captured',
  'step.assertion_passed',
  'step.assertion_failed',
  'step.completed',
  'run.blocked',
  'run.failed',
  'run.completed',
]);

const parseRunDocument = (value: unknown): WorkflowRun | null => {
  if (!isRecord(value)) return null;
  if (
    typeof value.id !== 'string'
    || typeof value.workflowName !== 'string'
    || value.workflowVersion !== 1
    || typeof value.status !== 'string'
    || !workflowRunStatuses.has(value.status)
    || !isRecord(value.inputs)
    || !Array.isArray(value.steps)
    || !Array.isArray(value.events)
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
  ) return null;

  const steps = value.steps;
  if (!steps.every((step) => isRecord(step) && typeof step.id === 'string' && typeof step.status === 'string' && stepStatuses.has(step.status))) {
    return null;
  }

  const events = value.events;
  if (!events.every((event) => isRecord(event)
    && typeof event.id === 'string'
    && typeof event.runId === 'string'
    && typeof event.at === 'number'
    && typeof event.kind === 'string'
    && eventKinds.has(event.kind)
    && isRecord(event.data))) {
    return null;
  }

  if (!Object.values(value.inputs).every((input) => typeof input === 'string')) return null;
  return value as unknown as WorkflowRun;
};

export async function runCli(args: string[], io: CliIO): Promise<number> {
  const [command, path, ...rest] = args;

  if (!command || !path || !['validate', 'dry-run', 'inspect'].includes(command)) {
    io.err(usage());
    return 2;
  }

  if (command === 'validate') {
    if (rest.length > 0) {
      io.err(usage());
      return 2;
    }
    const loaded = await readJson(path, io);
    if (!loaded.ok) return loaded.exitCode;
    const validated = validateWorkflowDocument(loaded.value);
    if (!validated.ok) {
      io.err(formatValidationErrors(validated.errors));
      return 1;
    }
    io.out(`Valid workflow: ${validated.value.name} (${validated.value.steps.length} steps)`);
    return 0;
  }

  if (command === 'dry-run') {
    const inputArgs = parseInputArgs(rest);
    if (!inputArgs.ok) {
      io.err(`${inputArgs.message}\n${usage()}`);
      return 2;
    }
    const loaded = await readJson(path, io);
    if (!loaded.ok) return loaded.exitCode;
    const validated = validateWorkflowDocument(loaded.value);
    if (!validated.ok) {
      io.err(formatValidationErrors(validated.errors));
      return 1;
    }
    const plan = createDryRunPlan(validated.value, inputArgs.inputs);
    if (!plan.ok) {
      io.err(formatValidationErrors(plan.errors));
      return 1;
    }
    io.out(formatDryRunPlan(plan.value));
    return 0;
  }

  if (rest.length > 0) {
    io.err(usage());
    return 2;
  }
  const loaded = await readJson(path, io);
  if (!loaded.ok) return loaded.exitCode;
  const run = parseRunDocument(loaded.value);
  if (!run) {
    io.err(`Invalid FlowRun run document: ${path}`);
    return 1;
  }
  io.out(formatRunInspection(run));
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2), nodeCliIO);
}
