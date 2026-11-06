import { expect, it } from 'vitest';
import { mcpFailureKind } from './mcpFailure.ts';

it.each([
  ['MCP connection refused', 'connection'],
  ['MCP server name could not be resolved', 'dns'],
  ['MCP probe timed out', 'timeout'],
  ['MCP server returned HTTP 401', 'authentication'],
  ['MCP server returned HTTP 429', 'rateLimit'],
  ['MCP server returned HTTP 503', 'server'],
  ['MCP server returned HTTP 404', 'protocol'],
  ['MCP probe failed', 'unknown'],
  ['MCP launch requires current fingerprint trust', null],
])('explains %s without masking unrelated trust errors', (message, expected) => {
  expect(mcpFailureKind(message)).toBe(expected);
});
