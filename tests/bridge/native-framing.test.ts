import { describe, expect, it } from 'vitest';
import { MAX_NATIVE_MESSAGE_BYTES, NativeFrameDecoder, encodeNativeMessage } from '../../src/bridge/native-framing';

describe('native messaging framing', () => {
  it('decodes fragmented and multiple messages', () => {
    const one = encodeNativeMessage({ a: 1 });
    const two = encodeNativeMessage({ b: 2 });
    const decoder = new NativeFrameDecoder();

    expect(decoder.push(one.subarray(0, 3))).toEqual([]);
    expect(decoder.push(Buffer.concat([one.subarray(3), two]))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('rejects oversized frames before buffering the body', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    expect(() => new NativeFrameDecoder().push(header)).toThrow('native-message-too-large');
  });

  it('rejects an oversized encoded message', () => {
    expect(() => encodeNativeMessage({ value: 'x'.repeat(MAX_NATIVE_MESSAGE_BYTES) })).toThrow('native-message-too-large');
  });
});
