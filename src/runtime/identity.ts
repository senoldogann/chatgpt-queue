export function conversationKeyFromUrl(url: string, temporaryKey: string): string {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/(?:^|\/)c\/([^/]+)/);
  return match?.[1] ? `conv:${match[1]}` : temporaryKey;
}

export function shouldMigrateConversationKey(previousKey: string, nextKey: string): boolean {
  if (previousKey.startsWith('temp:') && nextKey.startsWith('conv:')) return true;

  const previousIsWebProvisional = previousKey.startsWith('conv:WEB:');
  const nextIsFinalConversation = nextKey.startsWith('conv:') && !nextKey.startsWith('conv:WEB:');
  return previousIsWebProvisional && nextIsFinalConversation;
}
