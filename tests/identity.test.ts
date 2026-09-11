import { describe, expect, it } from 'vitest';
import { conversationKeyFromUrl, shouldMigrateConversationKey } from '../src/runtime/identity';

describe('conversation identity', () => {
  it('uses the real ChatGPT conversation id when present', () => {
    expect(conversationKeyFromUrl('https://chatgpt.com/c/abc-123', 'temp:x')).toBe('conv:abc-123');
    expect(conversationKeyFromUrl('https://chatgpt.com/g/g-test/c/real-id', 'temp:x')).toBe('conv:real-id');
  });

  it('uses a stable temporary key before a conversation id exists', () => {
    expect(conversationKeyFromUrl('https://chatgpt.com/', 'temp:stable')).toBe('temp:stable');
  });

  it('migrates only new-chat and provisional WEB identities, not arbitrary conversations', () => {
    expect(shouldMigrateConversationKey('temp:x', 'conv:WEB:abc')).toBe(true);
    expect(shouldMigrateConversationKey('conv:WEB:abc', 'conv:final-id')).toBe(true);
    expect(shouldMigrateConversationKey('conv:real-a', 'conv:real-b')).toBe(false);
    expect(shouldMigrateConversationKey('conv:WEB:abc', 'conv:WEB:def')).toBe(false);
  });
});
