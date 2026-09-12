import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { doctorNativeBridge, installNativeBridge, type BridgeDoctorResult } from '../bridge/install';
import type { BridgeJobResult, BridgeTarget } from '../bridge/protocol';
import { createDryRunPlan, formatDryRunPlan, formatRunInspection } from '../flowrun/inspect';
import type { WorkflowRun } from '../flowrun/events';
import { validateWorkflowDocument, type WorkflowDefinition } from '../flowrun/schema';
import { NodeBridgeClient, type BridgeCliApi } from './bridge-client';
import { nodeCliIO } from './io';

export interface CliIO {
  readText(path: string): Promise<string>;
  out(message: string): void;
  err(message: string): void;
}

export interface CliDependencies {
  bridge?: BridgeCliApi;
  installBridge?: (extensionId: string) => Promise<{ launcherPath: string }>;
  doctorBridge?: () => Promise<BridgeDoctorResult>;
}

const usage = (): string => [
  'Usage:',
  '  flowrun validate <workflow.json>',
  '  flowrun dry-run <workflow.json> --input key=value [--input key=value ...]',
  '  flowrun inspect <run.json>',
  '  flowrun bridge install --extension-id <chrome-extension-id>',
  '  flowrun bridge doctor',
  '  flowrun targets',
  '  flowrun run <workflow.json> --input key=value [--target <target-id>] [--detach]',
  '  flowrun status <job-id>',
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
    if (args[index] !== '--input') return { ok: false, message: `Unexpected argument: ${args[index]}` };
    const pair = args[index + 1];
    if (!pair) return { ok: false, message: '--input requires key=value' };
    const equals = pair.indexOf('=');
    if (equals <= 0) return { ok: false, message: '--input requires key=value' };
    inputs[pair.slice(0, equals)] = pair.slice(equals + 1);
    index += 2;
  }
  return { ok: true, inputs };
};

interface LiveRunArgs {
  inputs: Record<string, string>;
  targetId?: string;
  detach: boolean;
}

const parseLiveRunArgs = (args: string[]): { ok: true; value: LiveRunArgs } | { ok: false; message: string } => {
  const inputs: Record<string, string> = {};
  let targetId: string | undefined;
  let detach = false;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--detach') {
      detach = true;
      index += 1;
      continue;
    }
    if (arg === '--target') {
      const value = args[index + 1];
      if (!value) return { ok: false, message: '--target requires a target id' };
      targetId = value;
      index += 2;
      continue;
    }
    if (arg === '--input') {
      const pair = args[index + 1];
      if (!pair) return { ok: false, message: '--input requires key=value' };
      const equals = pair.indexOf('=');
      if (equals <= 0) return { ok: false, message: '--input requires key=value' };
      inputs[pair.slice(0, equals)] = pair.slice(equals + 1);
      index += 2;
      continue;
    }
    return { ok: false, message: `Unexpected argument: ${arg}` };
  }
  return { ok: true, value: { inputs, ...(targetId ? { targetId } : {}), detach } };
};

const workflowRunStatuses = new Set(['pending', 'running', 'blocked', 'completed', 'failed']);
const stepStatuses = new Set(['pending', 'ready', 'dispatching', 'waiting', 'completed', 'blocked', 'failed']);
const eventKinds = new Set([
  'run.created', 'run.started', 'step.ready', 'step.dispatch_reserved', 'step.dispatch_confirmed',
  'step.output_captured', 'step.assertion_passed', 'step.assertion_failed', 'step.completed',
  'run.blocked', 'run.failed', 'run.completed',
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

  if (!value.steps.every((step) => isRecord(step) && typeof step.id === 'string' && typeof step.status === 'string' && stepStatuses.has(step.status))) return null;
  if (!value.events.every((event) => isRecord(event)
    && typeof event.id === 'string'
    && typeof event.runId === 'string'
    && typeof event.at === 'number'
    && typeof event.kind === 'string'
    && eventKinds.has(event.kind)
    && isRecord(event.data))) return null;
  if (!Object.values(value.inputs).every((input) => typeof input === 'string')) return null;
  return value as unknown as WorkflowRun;
};

const getBridge = async (deps: CliDependencies): Promise<BridgeCliApi> =>
  deps.bridge ?? NodeBridgeClient.fromHome(homedir());

const defaultInstallBridge = async (extensionId: string): Promise<{ launcherPath: string }> => {
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const hostSourcePath = resolve(cliDir, '..', 'dist-native', 'flowrun-native-host.js');
  return installNativeBridge({ extensionId, homeDir: homedir(), nodePath: process.execPath, hostSourcePath });
};

const defaultDoctorBridge = (): Promise<BridgeDoctorResult> => doctorNativeBridge({ homeDir: homedir() });

const chooseTarget = (targets: BridgeTarget[], requested: string | undefined, io: CliIO): { ok: true; target: BridgeTarget } | { ok: false; exitCode: number } => {
  if (requested) {
    const target = targets.find((candidate) => candidate.targetId === requested);
    if (!target) {
      io.err(`Target not available: ${requested}`);
      return { ok: false, exitCode: 1 };
    }
    if (target.busy) {
      io.err(`Target is busy: ${requested}`);
      return { ok: false, exitCode: 1 };
    }
    return { ok: true, target };
  }

  const available = targets.filter((target) => !target.busy);
  if (available.length === 0) {
    io.err('No available ChatGPT targets. Keep Chrome open, enable the CLI bridge, and open a ChatGPT conversation.');
    return { ok: false, exitCode: 1 };
  }
  if (available.length > 1) {
    io.err('Multiple ChatGPT targets are available. Use --target <target-id>.');
    return { ok: false, exitCode: 2 };
  }
  return { ok: true, target: available[0]! };
};

const terminalExit = (result: BridgeJobResult, io: CliIO): number => {
  if (result.kind !== 'run') return 1;
  if (result.status === 'completed') {
    io.out(`Run completed: ${result.jobId}`);
    return 0;
  }
  const error = result.error ?? result.record?.error ?? result.status;
  io.err(`Run ${result.status}: ${error}`);
  return 1;
};

export async function runCli(args: string[], io: CliIO, deps: CliDependencies = {}): Promise<number> {
  const [command, ...tail] = args;
  if (command === '--help' || command === '-h') {
    io.out(usage());
    return 0;
  }

  if (command === 'bridge') {
    const [subcommand, ...bridgeArgs] = tail;
    if (subcommand === 'install') {
      if (bridgeArgs.length !== 2 || bridgeArgs[0] !== '--extension-id' || !bridgeArgs[1]) {
        io.err(usage());
        return 2;
      }
      try {
        const installed = await (deps.installBridge ?? defaultInstallBridge)(bridgeArgs[1]);
        io.out(`CLI bridge installed: ${installed.launcherPath}`);
        return 0;
      } catch (error) {
        io.err(`Bridge install failed: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
    }
    if (subcommand === 'doctor' && bridgeArgs.length === 0) {
      const result = await (deps.doctorBridge ?? defaultDoctorBridge)();
      for (const check of result.checks) io.out(`${check.name}: ${check.ok ? 'ok' : 'failed'}${check.detail ? ` (${check.detail})` : ''}`);
      return result.ok ? 0 : 1;
    }
    io.err(usage());
    return 2;
  }

  if (command === 'targets') {
    if (tail.length > 0) { io.err(usage()); return 2; }
    try {
      const targets = await (await getBridge(deps)).listTargets();
      if (targets.length === 0) {
        io.out('No active ChatGPT targets.');
        return 0;
      }
      for (const target of targets) io.out(`${target.targetId}\t${target.provider}\t${target.busy ? 'busy' : 'available'}\t${target.conversationKey}`);
      return 0;
    } catch (error) {
      io.err(`Bridge unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (command === 'status') {
    if (tail.length !== 1) { io.err(usage()); return 2; }
    try {
      const result = await (await getBridge(deps)).status(tail[0]!);
      if (!result) {
        io.err(`No bridge status for job: ${tail[0]}`);
        return 1;
      }
      io.out(`Job ${result.jobId}: ${result.status}`);
      return result.status === 'failed' || result.status === 'blocked' ? 1 : 0;
    } catch (error) {
      io.err(`Unable to read job status: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (command === 'run') {
    const [path, ...runArgs] = tail;
    if (!path) { io.err(usage()); return 2; }
    const parsedArgs = parseLiveRunArgs(runArgs);
    if (!parsedArgs.ok) { io.err(`${parsedArgs.message}\n${usage()}`); return 2; }
    const loaded = await readJson(path, io);
    if (!loaded.ok) return loaded.exitCode;
    const validated = validateWorkflowDocument(loaded.value);
    if (!validated.ok) { io.err(formatValidationErrors(validated.errors)); return 1; }
    const dryRun = createDryRunPlan(validated.value, parsedArgs.value.inputs);
    if (!dryRun.ok) { io.err(formatValidationErrors(dryRun.errors)); return 1; }

    let bridge: BridgeCliApi;
    try { bridge = await getBridge(deps); }
    catch (error) { io.err(`Bridge unavailable: ${error instanceof Error ? error.message : String(error)}`); return 1; }

    let targets: BridgeTarget[];
    try { targets = await bridge.listTargets(); }
    catch (error) { io.err(`Unable to list targets: ${error instanceof Error ? error.message : String(error)}`); return 1; }
    const selected = chooseTarget(targets, parsedArgs.value.targetId, io);
    if (!selected.ok) return selected.exitCode;

    let submitted: Awaited<ReturnType<BridgeCliApi['submitRun']>>;
    try {
      submitted = await bridge.submitRun({ workflow: validated.value, inputs: parsedArgs.value.inputs, targetId: selected.target.targetId });
    } catch (error) {
      io.err(`Run submission failed: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    io.out(`Accepted: ${submitted.jobId}`);
    if (submitted.result.kind === 'run' && ['blocked', 'failed'].includes(submitted.result.status)) return terminalExit(submitted.result, io);
    if (submitted.result.kind === 'run' && submitted.result.status === 'completed') return terminalExit(submitted.result, io);
    if (parsedArgs.value.detach) {
      io.out('Run detached; the extension continues while Chrome remains open and the computer stays awake.');
      return 0;
    }
    const result = await bridge.follow(submitted.jobId);
    return terminalExit(result, io);
  }

  const [path, ...rest] = tail;
  if (!command || !path || !['validate', 'dry-run', 'inspect'].includes(command)) {
    io.err(usage());
    return 2;
  }

  if (command === 'validate') {
    if (rest.length > 0) { io.err(usage()); return 2; }
    const loaded = await readJson(path, io);
    if (!loaded.ok) return loaded.exitCode;
    const validated = validateWorkflowDocument(loaded.value);
    if (!validated.ok) { io.err(formatValidationErrors(validated.errors)); return 1; }
    io.out(`Valid workflow: ${validated.value.name} (${validated.value.steps.length} steps)`);
    return 0;
  }

  if (command === 'dry-run') {
    const inputArgs = parseInputArgs(rest);
    if (!inputArgs.ok) { io.err(`${inputArgs.message}\n${usage()}`); return 2; }
    const loaded = await readJson(path, io);
    if (!loaded.ok) return loaded.exitCode;
    const validated = validateWorkflowDocument(loaded.value);
    if (!validated.ok) { io.err(formatValidationErrors(validated.errors)); return 1; }
    const plan = createDryRunPlan(validated.value, inputArgs.inputs);
    if (!plan.ok) { io.err(formatValidationErrors(plan.errors)); return 1; }
    io.out(formatDryRunPlan(plan.value));
    return 0;
  }

  if (rest.length > 0) { io.err(usage()); return 2; }
  const loaded = await readJson(path, io);
  if (!loaded.ok) return loaded.exitCode;
  const run = parseRunDocument(loaded.value);
  if (!run) { io.err(`Invalid FlowRun run document: ${path}`); return 1; }
  io.out(formatRunInspection(run));
  return 0;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await runCli(process.argv.slice(2), nodeCliIO);
}
