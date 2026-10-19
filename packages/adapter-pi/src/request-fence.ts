import { canonicalJson } from '@corral/contracts';
import type { Model } from '@earendil-works/pi-ai';

/** The provider may rebuild/retry internally; the permit still authorizes only one HTTP send. */
export function providerRequestFence(
  model: Pick<Model<string>, 'api' | 'baseUrl' | 'id'>,
  fetcher = globalThis.fetch,
  signal?: AbortSignal,
) {
  if (!['openai-responses', 'openai-codex-responses', 'openai-completions'].includes(model.api))
    return undefined;
  const base = model.baseUrl.replace(/\/+$/, '');
  const destination = new URL(
    model.api === 'openai-codex-responses'
      ? base.endsWith('/codex/responses')
        ? base
        : `${base}${base.endsWith('/codex') ? '' : '/codex'}/responses`
      : `${base}/${model.api === 'openai-responses' ? 'responses' : 'chat/completions'}`,
  ).href;
  let approved: string | undefined;
  let sent = false;
  return {
    approve(payload: unknown) {
      if (approved !== undefined || sent) throw new Error('provider permit already used');
      if (
        !payload ||
        typeof payload !== 'object' ||
        (payload as { model?: unknown }).model !== model.id
      )
        throw new Error('provider payload model differs from the permit');
      // Pi's parameter objects contain undefined fields that its JSON transport omits.
      approved = canonicalJson(JSON.parse(JSON.stringify(payload)));
    },
    fetch: (async (input, init) => {
      if (signal?.aborted) throw new Error('provider request cancelled');
      if (sent || approved === undefined) throw new Error('provider request has no unused permit');
      const request = input instanceof Request ? input : undefined;
      const url = new URL(request?.url ?? String(input));
      if (
        url.href !== destination ||
        (init?.method ?? request?.method ?? 'GET').toUpperCase() !== 'POST'
      )
        throw new Error('provider destination differs from the permit');
      const body =
        typeof init?.body === 'string'
          ? init.body
          : init?.body == null && request
            ? await request.clone().text()
            : null;
      let serialized: string | undefined;
      try {
        if (body !== null) serialized = canonicalJson(JSON.parse(body));
      } catch {
        /* Refuse without including request data in the error. */
      }
      if (serialized !== approved) throw new Error('provider payload differs from the permit');
      if (signal?.aborted) throw new Error('provider request cancelled');
      if (sent) throw new Error('provider request has no unused permit');
      sent = true;
      return fetcher(input, { ...init, ...(signal ? { signal } : {}), redirect: 'error' });
    }) satisfies typeof fetch,
  };
}
