import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/** Local PKCE/rotation fixture; never contacts an account or issues a real credential. */
export async function oauthFixture() {
  let origin = '';
  let challenge = '';
  let redirectUri = '';
  let exchanges = 0;
  let mcpCalls = 0;
  let refreshes = 0;
  let grantScope = 'docs:read';
  let beforeTools: (() => Promise<void>) | undefined;
  let beforeRefresh: (() => Promise<void>) | undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', origin);
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    };
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return json({
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        scopes_supported: ['docs:read', 'docs:write'],
      });
    if (url.pathname === '/.well-known/oauth-authorization-server')
      return json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    if (url.pathname === '/mcp') {
      if (request.headers.authorization !== `Bearer fixture-access-${refreshes}`) {
        response.setHeader('www-authenticate', 'Bearer error="invalid_token"');
        return json({ error: 'unauthorized' }, 401);
      }
      if (request.method !== 'POST') {
        response.writeHead(405);
        return response.end();
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        response.writeHead(202);
        return response.end();
      }
      let result: unknown = {};
      if (message.method === 'initialize')
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: 'docs', version: '1' },
        };
      if (message.method === 'tools/list') {
        await beforeTools?.();
        result = {
          tools: [
            {
              name: 'echo',
              description: 'Read fixture docs',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true, openWorldHint: false },
            },
          ],
        };
      }
      if (message.method === 'tools/call') {
        mcpCalls++;
        result = { content: [{ type: 'text', text: 'Local MCP result' }] };
      }
      return json({ jsonrpc: '2.0', id: message.id, result });
    }
    if (url.pathname === '/register')
      return json({ ...JSON.parse(body), client_id: 'fixture-client' });
    if (url.pathname === '/authorize') {
      challenge = url.searchParams.get('code_challenge') ?? '';
      redirectUri = url.searchParams.get('redirect_uri') ?? '';
      const target = new URL(redirectUri);
      target.searchParams.set('code', 'fixture-code');
      target.searchParams.set('state', url.searchParams.get('state') ?? '');
      response.writeHead(302, { location: target.href });
      return response.end();
    }
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body);
      if (form.get('grant_type') === 'authorization_code') {
        const actual = createHash('sha256')
          .update(form.get('code_verifier') ?? '')
          .digest('base64url');
        if (
          actual !== challenge ||
          form.get('redirect_uri') !== redirectUri ||
          form.get('code') !== 'fixture-code'
        )
          return json({ error: 'invalid_grant' }, 400);
        exchanges++;
      } else {
        if (form.get('refresh_token') !== `fixture-refresh-${refreshes}`)
          return json({ error: 'invalid_grant' }, 400);
        await beforeRefresh?.();
        refreshes++;
      }
      return json({
        access_token: `fixture-access-${refreshes}`,
        refresh_token: `fixture-refresh-${refreshes}`,
        token_type: 'Bearer',
        expires_in: 3600,
        scope: grantScope,
      });
    }
    json({ error: 'not_found' }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture did not listen');
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    get mcpCalls() {
      return mcpCalls;
    },
    get exchanges() {
      return exchanges;
    },
    get refreshes() {
      return refreshes;
    },
    scope(value: string) {
      grantScope = value;
    },
    delayTools(fn?: () => Promise<void>) {
      beforeTools = fn;
    },
    delayRefresh(fn: () => Promise<void>) {
      beforeRefresh = fn;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
