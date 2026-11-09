import { expect, it } from 'vitest';
import { ModelsApi } from '../src/index.ts';

it('reads, saves and drives the Local engine through the effort routing routes', async () => {
  const requests: { method: string; path: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/session')) return Response.json({ ok: true, csrfToken: 'csrf' });
    requests.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ settings: { mode: 'off' }, revision: 'r1' });
  };
  const models = new ModelsApi({ baseUrl: 'http://localhost', fetch: fetcher });
  await models.effortRouting();
  await models.saveEffortRouting({ mode: 'off' }, 'r1');
  await models.installLocalRouting();
  await models.cancelLocalRoutingInstall();
  await models.startLocalRouting();
  expect(requests).toEqual([
    { method: 'GET', path: '/api/v1/effort-routing', body: null },
    {
      method: 'PUT',
      path: '/api/v1/effort-routing',
      body: { settings: { mode: 'off' }, revision: 'r1' },
    },
    { method: 'POST', path: '/api/v1/effort-routing/local/install', body: null },
    { method: 'DELETE', path: '/api/v1/effort-routing/local/install', body: null },
    { method: 'POST', path: '/api/v1/effort-routing/local/start', body: null },
  ]);
});
