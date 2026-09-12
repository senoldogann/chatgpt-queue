import { describe, expect, it } from 'vitest';
import { MAX_BRIDGE_REQUEST_BYTES, validateBridgeRequest } from '../../src/bridge/protocol';

const workflow = {
  version: 1,
  name: 'demo',
  inputs: { topic: { type: 'string', required: true } },
  steps: [{ id: 'one', type: 'chat', provider: 'chatgpt', prompt: 'Hello {{ inputs.topic }}' }],
};

const request = (overrides: Record<string, unknown> = {}) => ({
  version: 1,
  jobId: '123e4567-e89b-42d3-a456-426614174000',
  secret: 's'.repeat(64),
  kind: 'run',
  createdAt: 1_000,
  expiresAt: 601_000,
  payload: { workflow, inputs: { topic: 'world' } },
  ...overrides,
});

describe('bridge protocol validation', () => {
  it('accepts a valid run request', () => {
    const result = validateBridgeRequest(request(), 2_000, 's'.repeat(64));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('run');
  });

  it.each([
    ['version', { version: 2 }, 'bridge.invalid-version'],
    ['job id', { jobId: '../bad' }, 'bridge.invalid-job-id'],
    ['secret', { secret: 'wrong' }, 'bridge.invalid-secret'],
    ['expired', { expiresAt: 1_500 }, 'bridge.expired'],
  ])('rejects invalid %s', (_name, overrides, code) => {
    const result = validateBridgeRequest(request(overrides), 2_000, 's'.repeat(64));
    expect(result).toEqual({ ok: false, error: code });
  });

  it('rejects malformed workflow and inputs', () => {
    expect(validateBridgeRequest(request({ payload: { workflow: { version: 1 }, inputs: [] } }), 2_000, 's'.repeat(64)))
      .toEqual({ ok: false, error: 'bridge.invalid-run-payload' });
  });

  it('accepts a targets request with an empty payload', () => {
    const result = validateBridgeRequest(request({ kind: 'targets', payload: {} }), 2_000, 's'.repeat(64));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.kind).toBe('targets');
  });

  it('rejects requests larger than the hard cap', () => {
    const huge = request({ payload: { workflow, inputs: { topic: 'x'.repeat(MAX_BRIDGE_REQUEST_BYTES) } } });
    expect(validateBridgeRequest(huge, 2_000, 's'.repeat(64))).toEqual({ ok: false, error: 'bridge.request-too-large' });
  });
});
