import { createServer, type Server } from 'node:http';

// An OpenAI-compatible chat completions server on 127.0.0.1, like Ollama or LM Studio
//. It answers every request with `reply` as one streamed message and records the
// Authorization header of each request, so tests can see which key (if any) was sent.

export interface CompatibleEndpoint {
  /** e.g. http://127.0.0.1:PORT/v1 */
  baseUrl: string;
  /** The Authorization header of each request, in order; null when none was sent. */
  authorizations: (string | null)[];
  /** Model ids asked for, in order. */
  models: string[];
  setReply(reply: (body: unknown) => string | { toolCall: { name: string; args: unknown } }): void;
  close(): Promise<void>;
}

export async function startCompatibleEndpoint(): Promise<CompatibleEndpoint> {
  const authorizations: (string | null)[] = [];
  const models: string[] = [];
  let reply: Parameters<CompatibleEndpoint['setReply']>[0] = () => 'OK';
  let calls = 0;
  const server: Server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => {
      raw += chunk;
    });
    request.on('end', () => {
      if (request.method !== 'POST' || !request.url?.endsWith('/chat/completions')) {
        response.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw || '{}') as { model?: string };
      authorizations.push(request.headers.authorization ?? null);
      models.push(String(body.model));
      const answer = reply(body);
      const id = `chatcmpl-${++calls}`;
      const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
        `data: ${JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finish }],
          ...(usage ? { usage } : {}),
        })}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (typeof answer === 'string') {
        response.write(chunk({ role: 'assistant', content: answer }, null));
        response.write(
          chunk({}, 'stop', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
        );
      } else {
        response.write(
          chunk(
            {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: `call_${calls}`,
                  type: 'function',
                  function: {
                    name: answer.toolCall.name,
                    arguments: JSON.stringify(answer.toolCall.args),
                  },
                },
              ],
            },
            null,
          ),
        );
        response.write(
          chunk({}, 'tool_calls', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 }),
        );
      }
      response.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    authorizations,
    models,
    setReply(next) {
      reply = next;
    },
    close: () => new Promise<void>((done) => server.close(() => done())),
  };
}
