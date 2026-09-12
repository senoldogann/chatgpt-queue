export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export function encodeNativeMessage(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (body.byteLength > MAX_NATIVE_MESSAGE_BYTES) throw new Error('native-message-too-large');
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32LE(body.byteLength, 0);
  return Buffer.concat([header, body]);
}

export class NativeFrameDecoder {
  private buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): unknown[] {
    this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
    const messages: unknown[] = [];
    while (this.buffer.byteLength >= 4) {
      const length = this.buffer.readUInt32LE(0);
      if (length > MAX_NATIVE_MESSAGE_BYTES) throw new Error('native-message-too-large');
      if (this.buffer.byteLength < 4 + length) break;
      const body = this.buffer.subarray(4, 4 + length);
      this.buffer = this.buffer.subarray(4 + length);
      try {
        messages.push(JSON.parse(body.toString('utf8')) as unknown);
      } catch {
        throw new Error('native-message-invalid-json');
      }
    }
    return messages;
  }
}
