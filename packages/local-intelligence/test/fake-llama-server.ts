// A stand-in llama-server for the d1 tests, run as a real child process (node strips the types).
// It speaks the endpoints Corral uses, requires the key from LLAMA_API_KEY, counts tokens as one
// per four UTF-8 bytes, and misbehaves as FAKE_D1 (or a later POST /__fake) says.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { renderChoice } from '../src/d1/render.ts';

type Mode = 'ok' | 'hang' | 'stall' | 'error500' | 'crash';
interface Behavior {
  startupDelayMs?: number;
  ignoreKey?: boolean;
  ignoreTerm?: boolean;
  decisions?: boolean;
  size?: number;
  params?: number;
  tokenize?: Mode;
  tokenizeDelayMs?: number;
  systemone?: Mode;
  systemoneDelayMs?: number;
  usageDelta?: number;
  choice?: string;
}

let behavior: Behavior = JSON.parse(process.env.FAKE_D1 ?? '{}');
const key = process.env.LLAMA_API_KEY ?? '';
const started = Date.now();
const stats = {
  tokenize: 0,
  tokenizeClosedEarly: 0,
  systemone: 0,
  systemoneDone: 0,
  argv: process.argv.slice(2),
  envKeys: Object.keys(process.env)
    .filter((k) => k !== 'FAKE_D1' && !k.startsWith('NODE_') && k !== '__CF_USER_TEXT_ENCODING')
    .sort(),
};
const arg = (name: string) => process.argv[process.argv.indexOf(name) + 1];
const count = (text: string) => Math.ceil(Buffer.byteLength(text, 'utf8') / 4);

if (behavior.ignoreTerm) process.on('SIGTERM', () => {});

const read = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => resolve(body));
  });
const json = (res: ServerResponse, status: number, value: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};
const later = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

async function misbehave(mode: Mode | undefined, res: ServerResponse): Promise<boolean> {
  if (mode === 'hang') return true;
  if (mode === 'crash') process.exit(3);
  if (mode === 'error500') {
    json(res, 500, { error: `echo ${key}` });
    return true;
  }
  if (mode === 'stall') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"tokens":[1,');
    return true;
  }
  return false;
}

createServer(async (req, res) => {
  const url = req.url ?? '';
  if (url === '/__fake') {
    if (req.method === 'POST') behavior = { ...behavior, ...JSON.parse(await read(req)) };
    else await read(req);
    json(res, 200, stats);
    return;
  }
  if (url === '/health') {
    json(res, Date.now() - started < (behavior.startupDelayMs ?? 0) ? 503 : 200, { status: 'ok' });
    return;
  }
  if (!behavior.ignoreKey && req.headers.authorization !== `Bearer ${key}`) {
    await read(req);
    json(res, 401, { error: 'Invalid API Key' });
    return;
  }
  if (url === '/v1/models') {
    json(res, 200, {
      data: [
        {
          id: arg('--model'),
          architecture: { output_modalities: behavior.decisions === false ? [] : ['decisions'] },
          meta: { size: behavior.size ?? 1000, n_params: behavior.params ?? 2000 },
        },
      ],
    });
    return;
  }
  if (url === '/tokenize') {
    const body = JSON.parse(await read(req)) as { content: string };
    stats.tokenize++;
    let finished = false;
    res.on('close', () => {
      if (!finished) stats.tokenizeClosedEarly++;
    });
    await later(behavior.tokenizeDelayMs);
    if (await misbehave(behavior.tokenize, res)) return;
    finished = true;
    json(res, 200, { tokens: Array.from({ length: count(body.content) }, (_, i) => i) });
    return;
  }
  if (url === '/v1/systemone') {
    const body = JSON.parse(await read(req)) as {
      state: string;
      questions: {
        effort: { type: 'choice'; instructions: string; criteria: Record<string, string> };
      };
    };
    stats.systemone++;
    await later(behavior.systemoneDelayMs);
    if (await misbehave(behavior.systemone, res)) return;
    const keys = Object.keys(body.questions.effort.criteria);
    const choice = behavior.choice ?? keys[1] ?? keys[0]!;
    const rest = keys.filter((k) => k !== choice);
    stats.systemoneDone++;
    json(res, 200, {
      model: arg('--model'),
      answers: {
        effort: {
          type: 'choice',
          choice,
          probabilities: Object.fromEntries([
            [choice, 0.7],
            ...rest.map((k) => [k, 0.3 / rest.length]),
          ]),
          confidence: 0.7,
        },
      },
      usage: {
        input_tokens:
          count(renderChoice(body.state, body.questions.effort)) + (behavior.usageDelta ?? 0),
        output_tokens: 0,
      },
    });
    return;
  }
  json(res, 404, { error: 'not found' });
}).listen(Number(arg('--port')), '127.0.0.1');
