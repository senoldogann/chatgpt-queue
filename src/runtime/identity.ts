export function conversationKeyFromUrl(url: string, temporaryKey: string): string {
  const pathname = new URL(url).pathname;
  const match = pathname.match(/(?:^|\/)c\/([^/]+)/);
  return match?.[1] ? `conv:${match[1]}` : temporaryKey;
}
