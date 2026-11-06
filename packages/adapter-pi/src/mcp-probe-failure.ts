type ProbeFailure =
  | { kind: 'connection' | 'dns' | 'timeout' | 'unknown' }
  | { kind: 'http'; status: number };

/** Only category and HTTP status cross the worker boundary; never remote bodies or URLs. */
export function safeProbeFailure(error: unknown): ProbeFailure {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const value = current as {
      code?: unknown;
      name?: unknown;
      message?: unknown;
      status?: unknown;
      cause?: unknown;
    };
    if (value.code === 'ECONNREFUSED') return { kind: 'connection' };
    if (value.code === 'ENOTFOUND' || value.code === 'EAI_AGAIN') return { kind: 'dns' };
    if (value.code === 'ETIMEDOUT' || value.name === 'TimeoutError') return { kind: 'timeout' };
    const status =
      typeof value.status === 'number'
        ? value.status
        : typeof value.message === 'string'
          ? Number(/\bHTTP(?: status)?\s+(\d{3})\b/i.exec(value.message)?.[1])
          : NaN;
    if (Number.isInteger(status) && status >= 100 && status <= 599) return { kind: 'http', status };
    current = value.cause;
  }
  return { kind: 'unknown' };
}

export function probeFailureMessage(failure: unknown): string {
  if (!failure || typeof failure !== 'object') return 'MCP probe failed';
  const { kind, status } = failure as { kind?: unknown; status?: unknown };
  if (kind === 'connection') return 'MCP connection refused';
  if (kind === 'dns') return 'MCP server name could not be resolved';
  if (kind === 'timeout') return 'MCP probe timed out';
  if (
    kind === 'http' &&
    typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
  )
    return `MCP server returned HTTP ${status}`;
  return 'MCP probe failed';
}
