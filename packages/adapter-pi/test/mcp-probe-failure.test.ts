import { expect, it } from 'vitest';
import { probeFailureMessage, safeProbeFailure } from '../src/mcp-probe-failure.ts';

it('keeps only safe transport categories across the worker boundary', () => {
  expect(
    safeProbeFailure(
      new Error('fetch failed', {
        cause: Object.assign(new Error('connect 127.0.0.1 secret'), { code: 'ECONNREFUSED' }),
      }),
    ),
  ).toEqual({ kind: 'connection' });
  expect(safeProbeFailure(new Error('HTTP 401: secret token body'))).toEqual({
    kind: 'http',
    status: 401,
  });
  expect(
    safeProbeFailure(Object.assign(new Error('secret endpoint'), { code: 'ENOTFOUND' })),
  ).toEqual({ kind: 'dns' });
  expect(safeProbeFailure(new Error('my secret is abc'))).toEqual({ kind: 'unknown' });
  expect(probeFailureMessage({ kind: 'http', status: 503 })).toBe('MCP server returned HTTP 503');
  expect(probeFailureMessage({ kind: 'http', status: 999, secret: 'leak' })).toBe(
    'MCP probe failed',
  );
});
