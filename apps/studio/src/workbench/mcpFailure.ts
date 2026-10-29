export function mcpFailureKind(message: string) {
  if (message === 'MCP connection refused') return 'connection';
  if (message === 'MCP server name could not be resolved') return 'dns';
  if (message === 'MCP probe timed out') return 'timeout';
  if (
    message === 'MCP probe authorization failed' ||
    /^MCP server returned HTTP (401|403)$/.test(message)
  )
    return 'authentication';
  if (message === 'MCP server returned HTTP 429') return 'rateLimit';
  if (/^MCP server returned HTTP 5\d{2}$/.test(message)) return 'server';
  if (/^MCP server returned HTTP [1-5]\d{2}$/.test(message)) return 'protocol';
  if (message === 'MCP probe failed') return 'unknown';
  return null;
}
