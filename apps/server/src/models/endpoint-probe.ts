export interface EndpointProbeResult {
  kind:
    | 'connected'
    | 'authentication'
    | 'rateLimit'
    | 'server'
    | 'redirect'
    | 'unsupported'
    | 'connection';
  status: number | null;
}

/** Explicit metadata request only. Redirects never receive origin-bound credentials. */
export async function probeEndpoint(options: {
  baseUrl: string;
  apiKey?: string;
  fetch?: typeof fetch;
}): Promise<EndpointProbeResult> {
  try {
    const response = await (options.fetch ?? fetch)(
      `${options.baseUrl.replace(/\/$/, '')}/models`,
      {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
        headers: options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {},
      },
    );
    void response.body?.cancel().catch(() => {});
    const status = response.status;
    const kind = response.ok
      ? 'connected'
      : status === 401 || status === 403
        ? 'authentication'
        : status === 429
          ? 'rateLimit'
          : status >= 500
            ? 'server'
            : status >= 300 && status < 400
              ? 'redirect'
              : 'unsupported';
    return { kind, status };
  } catch {
    return { kind: 'connection', status: null };
  }
}
