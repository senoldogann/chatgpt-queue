import { describe, expect, it, vi } from 'vitest';
import { NativeBridgeService, type NativePortLike } from '../../src/bridge/native-service';
import { BridgeJobRepository, type BridgeStorageArea } from '../../src/bridge/job-repository';
import { TargetRegistry } from '../../src/bridge/target-registry';

class MemoryStorage implements BridgeStorageArea {
  data: Record<string, unknown> = {};
  async get(key: string) { return { [key]: this.data[key] }; }
  async set(values: Record<string, unknown>) { Object.assign(this.data, structuredClone(values)); }
}

class FakePort implements NativePortLike {
  sent: unknown[] = [];
  messageListeners: Array<(message: unknown) => void> = [];
  disconnectListeners: Array<() => void> = [];
  postMessage(message: unknown) { this.sent.push(structuredClone(message)); }
  disconnect() {}
  onMessage = { addListener: (listener: (message: unknown) => void) => this.messageListeners.push(listener) };
  onDisconnect = { addListener: (listener: () => void) => this.disconnectListeners.push(listener) };
  emit(message: unknown) { for (const listener of this.messageListeners) listener(message); }
  emitDisconnect() { for (const listener of this.disconnectListeners) listener(); }
}

const workflow = {
  version: 1,
  name: 'bridge-live',
  inputs: {},
  steps: [{ id: 'one', type: 'chat', provider: 'chatgpt', prompt: 'Continue' }],
};

const runRequest = {
  version: 1,
  jobId: '123e4567-e89b-42d3-a456-426614174000',
  secret: 'a'.repeat(64),
  kind: 'run',
  createdAt: 1_000,
  expiresAt: 601_000,
  payload: { workflow, inputs: {}, targetId: 'target:opaque' },
};

describe('NativeBridgeService', () => {
  it('does not connect without optional permission', async () => {
    const connect = vi.fn();
    const service = new NativeBridgeService({
      hasPermission: async () => false,
      requestPermission: async () => false,
      connectNative: connect,
      repository: new BridgeJobRepository(new MemoryStorage()),
      registry: new TargetRegistry(),
      routeToTab: vi.fn(),
      now: () => 2_000,
    });

    expect(await service.ensureConnected()).toBe(false);
    expect(service.state()).toBe('disabled');
    expect(connect).not.toHaveBeenCalled();
  });

  it('requests optional nativeMessaging permission only when explicitly enabled', async () => {
    const port = new FakePort();
    let granted = false;
    const requestPermission = vi.fn(async () => { granted = true; return true; });
    const connectNative = vi.fn(() => port);
    const service = new NativeBridgeService({
      hasPermission: async () => granted,
      requestPermission,
      connectNative,
      repository: new BridgeJobRepository(new MemoryStorage()),
      registry: new TargetRegistry(),
      routeToTab: vi.fn(),
      now: () => 2_000,
    });

    expect(await service.enable()).toBe(true);
    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(connectNative).toHaveBeenCalledTimes(1);
  });

  it('does not report connected until the native host hello handshake completes', async () => {
    const port = new FakePort();
    const service = new NativeBridgeService({
      hasPermission: async () => true,
      requestPermission: async () => true,
      connectNative: () => port,
      repository: new BridgeJobRepository(new MemoryStorage()),
      registry: new TargetRegistry(),
      routeToTab: vi.fn(),
      now: () => 2_000,
    });

    expect(await service.ensureConnected()).toBe(true);
    expect(service.state()).toBe('disconnected');
    port.emit({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    expect(service.state()).toBe('connected');
  });

  it('consumes disconnect errors and schedules a reconnect', async () => {
    const first = new FakePort();
    const second = new FakePort();
    const ports = [first, second];
    const connectNative = vi.fn(() => ports.shift()!);
    const consumeLastError = vi.fn();
    const scheduled: Array<() => void> = [];
    const service = new NativeBridgeService({
      hasPermission: async () => true,
      requestPermission: async () => true,
      connectNative,
      repository: new BridgeJobRepository(new MemoryStorage()),
      registry: new TargetRegistry(),
      routeToTab: vi.fn(),
      now: () => 2_000,
      consumeLastError,
      scheduleReconnect: (callback) => { scheduled.push(callback); },
    });

    await service.ensureConnected();
    first.emit({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    expect(service.state()).toBe('connected');
    first.emitDisconnect();

    expect(service.state()).toBe('disconnected');
    expect(consumeLastError).toHaveBeenCalledTimes(1);
    expect(scheduled).toHaveLength(1);
    await scheduled[0]!();
    expect(connectNative).toHaveBeenCalledTimes(2);
    expect(service.state()).toBe('disconnected');
    second.emit({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    expect(service.state()).toBe('connected');
  });

  it('connects to the exact native host and answers targets after secret handshake', async () => {
    const port = new FakePort();
    const registry = new TargetRegistry({ idFactory: () => 'opaque' });
    registry.register(5, { conversationKey: 'conv:a', queueStatus: 'completed', busy: false }, 1_000);
    const service = new NativeBridgeService({
      hasPermission: async () => true,
      requestPermission: async () => true,
      connectNative: vi.fn(() => port),
      repository: new BridgeJobRepository(new MemoryStorage()),
      registry,
      routeToTab: vi.fn(),
      now: () => 2_000,
    });
    await service.ensureConnected();
    port.emit({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    port.emit({ ...runRequest, kind: 'targets', payload: {} });
    await vi.waitFor(() => expect(port.sent.some((message: any) => message.kind === 'targets' && message.targets?.[0]?.targetId === 'target:opaque')).toBe(true));
  });

  it('persists acceptance before routing and never reroutes a duplicate job id', async () => {
    const storage = new MemoryStorage();
    const repo = new BridgeJobRepository(storage);
    const port = new FakePort();
    const registry = new TargetRegistry({ idFactory: () => 'opaque' });
    registry.register(9, { conversationKey: 'conv:a', queueStatus: 'completed', busy: false }, 1_000);
    const routeOrder: string[] = [];
    const route = vi.fn(async () => {
      expect((await repo.get(runRequest.jobId))?.status).toBe('accepted');
      routeOrder.push('route');
      return { ok: true };
    });
    const service = new NativeBridgeService({
      hasPermission: async () => true,
      requestPermission: async () => true,
      connectNative: () => port,
      repository: repo,
      registry,
      routeToTab: route,
      now: () => 2_000,
    });
    await service.ensureConnected();
    port.emit({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    port.emit(runRequest);
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));
    expect(routeOrder).toEqual(['route']);
    expect(port.sent.some((message: any) => message.jobId === runRequest.jobId && message.status === 'accepted')).toBe(true);

    port.emit(runRequest);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(route).toHaveBeenCalledTimes(1);
  });

  it('returns the persisted job on redelivery even when the target is now busy', async () => {
    const storage = new MemoryStorage();
    const repo = new BridgeJobRepository(storage);
    const port = new FakePort();
    const registry = new TargetRegistry({ idFactory: () => 'opaque' });
    registry.register(9, { conversationKey: 'conv:a', queueStatus: 'completed', busy: false }, 1_000);
    const route = vi.fn(async () => ({ ok: true }));
    const service = new NativeBridgeService({
      hasPermission: async () => true,
      requestPermission: async () => true,
      connectNative: () => port,
      repository: repo,
      registry,
      routeToTab: route,
      now: () => 2_000,
    });
    await service.ensureConnected();
    port.emit({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    port.emit(runRequest);
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));

    registry.register(9, { conversationKey: 'conv:a', queueStatus: 'running', busy: true }, 2_100);
    port.sent.length = 0;
    port.emit(runRequest);

    await vi.waitFor(() => expect(port.sent.some((message: any) =>
      message.jobId === runRequest.jobId
      && message.kind === 'run'
      && message.status === 'accepted'
      && message.error === undefined)).toBe(true));
    expect(route).toHaveBeenCalledTimes(1);
    expect(port.sent.some((message: any) => message.error === 'bridge.target-busy')).toBe(false);
  });

  it('returns an already accepted job after its request TTL has expired', async () => {
    let now = 2_000;
    const storage = new MemoryStorage();
    const repo = new BridgeJobRepository(storage);
    const port = new FakePort();
    const registry = new TargetRegistry({ idFactory: () => 'opaque' });
    registry.register(9, { conversationKey: 'conv:a', queueStatus: 'completed', busy: false }, 1_000);
    const route = vi.fn(async () => ({ ok: true }));
    const service = new NativeBridgeService({
      hasPermission: async () => true,
      requestPermission: async () => true,
      connectNative: () => port,
      repository: repo,
      registry,
      routeToTab: route,
      now: () => now,
    });
    await service.ensureConnected();
    port.emit({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    port.emit(runRequest);
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));

    now = runRequest.expiresAt + 1;
    port.sent.length = 0;
    port.emit(runRequest);

    await vi.waitFor(() => expect(port.sent.some((message: any) =>
      message.jobId === runRequest.jobId
      && message.kind === 'run'
      && message.status === 'accepted'
      && message.error === undefined)).toBe(true));
    expect(route).toHaveBeenCalledTimes(1);
    expect(port.sent.some((message: any) => message.error === 'bridge.expired')).toBe(false);
  });

  it('durably rejects a second job for the same conversation even when the target registry is still stale-idle', async () => {
    const storage = new MemoryStorage();
    const repo = new BridgeJobRepository(storage);
    const port = new FakePort();
    const registry = new TargetRegistry({ idFactory: () => 'opaque' });
    registry.register(9, { conversationKey: 'conv:a', queueStatus: 'completed', busy: false }, 1_000);
    const route = vi.fn(async () => ({ ok: true }));
    const service = new NativeBridgeService({
      hasPermission: async () => true,
      requestPermission: async () => true,
      connectNative: () => port,
      repository: repo,
      registry,
      routeToTab: route,
      now: () => 2_000,
    });
    await service.ensureConnected();
    port.emit({ type: 'bridge.hello', version: 1, secret: 'a'.repeat(64) });
    port.emit(runRequest);
    await vi.waitFor(() => expect(route).toHaveBeenCalledTimes(1));

    const secondJobId = '123e4567-e89b-42d3-a456-426614174001';
    port.sent.length = 0;
    port.emit({ ...runRequest, jobId: secondJobId });

    await vi.waitFor(() => expect(port.sent.some((message: any) => message.jobId === secondJobId && message.error === 'bridge.target-busy')).toBe(true));
    expect(route).toHaveBeenCalledTimes(1);
    expect(await repo.get(secondJobId)).toBeUndefined();
  });

  it('rejects requests before handshake or with the wrong secret', async () => {
    const port = new FakePort();
    const route = vi.fn();
    const registry = new TargetRegistry({ idFactory: () => 'opaque' });
    registry.register(9, { conversationKey: 'conv:a', queueStatus: 'completed', busy: false }, 1_000);
    const service = new NativeBridgeService({
      hasPermission: async () => true,
      requestPermission: async () => true,
      connectNative: () => port,
      repository: new BridgeJobRepository(new MemoryStorage()),
      registry,
      routeToTab: route,
      now: () => 2_000,
    });
    await service.ensureConnected();
    port.emit(runRequest);
    port.emit({ type: 'bridge.hello', version: 1, secret: 'b'.repeat(64) });
    port.emit(runRequest);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(route).not.toHaveBeenCalled();
    expect(port.sent.some((message: any) => message.error === 'bridge.invalid-secret')).toBe(true);
  });
});
