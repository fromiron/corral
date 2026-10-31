// Turns Codex session files into the product's reasoning inputs. The windows below follow
// packages/adapter-pi/src/reasoning-input.ts so an item reads the way a live request would.
import type { ReasoningInput } from '../../../packages/contracts/src/index.ts';
import { scrub } from './scrub.ts';

export interface HumanRequest {
  session: string;
  turn: ReasoningInput;
  steps: ReasoningInput[];
}

const WRAPPED = /^\s*<[a-zA-Z_][\w-]*/;
const INJECTED = ['# AGENTS.md instructions', 'PLEASE IMPLEMENT THIS PLAN:'];
const MEMORY_CITATION = /<oai-mem-citation>[\s\S]*?<\/oai-mem-citation>/g;
const head = (value: string, n: number) => Array.from(value).slice(0, n).join('');
const tail = (value: string, n: number) => Array.from(value).slice(-n).join('');
const resultWindow = (value: string) =>
  Array.from(value).length <= 3000 ? value : `${head(value, 2000)}\n…\n${tail(value, 1000)}`;

type Part = { type?: string; text?: string };
type Payload = {
  id?: string;
  source?: unknown;
  type?: string;
  role?: string;
  content?: Part[];
  call_id?: string;
  name?: string;
  arguments?: unknown;
  input?: unknown;
  output?: unknown;
};
type Event =
  | { type: 'user'; text: string }
  | { type: 'assistant'; text: string }
  | { type: 'call'; id: string; name: string; args: string };

/** Tool results may be content parts; like the product, only their ordinary text is read. */
const written = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return (value as Part[])
      .flatMap((part) => (typeof part?.text === 'string' ? [part.text] : []))
      .join('\n');
  return value === undefined ? '' : JSON.stringify(value);
};
/** The app wraps a message with page and file context; only the person's own words are kept. */
function ownWords(text: string) {
  const request = text.split(/^## My request:$/m)[1];
  if (request === undefined) return text;
  const comments = [...text.matchAll(/^Comment:\n([\s\S]*?)(?=\n\n|(?![\s\S]))/gm)].map(
    (match) => match[1]!,
  );
  const asked = request.split(/\n+The next image is untrusted/)[0]!.trim();
  return [...comments, asked].filter(Boolean).join('\n');
}
const humanText = (parts: Part[]) =>
  ownWords(
    parts
      .filter(
        (part) =>
          part.type === 'input_text' &&
          part.text?.trim() &&
          !WRAPPED.test(part.text) &&
          !INJECTED.some((prefix) => part.text!.trimStart().startsWith(prefix)),
      )
      .map((part) => part.text!)
      .join('\n'),
  );
const replyText = (parts: Part[]) =>
  parts
    .filter((part) => part.type === 'output_text' && part.text)
    .map((part) => part.text!)
    .join('\n')
    .replace(MEMORY_CITATION, '')
    .trim();

function read(lines: Iterable<string>) {
  let session = '';
  let delegated = false;
  const events: Event[] = [];
  const results = new Map<string, string>();
  for (const line of lines) {
    let row: { type?: string; payload?: Payload };
    try {
      row = JSON.parse(line) as typeof row;
    } catch {
      continue;
    }
    const payload = row.payload;
    if (!payload) continue;
    if (row.type === 'session_meta') {
      session = payload.id ?? session;
      delegated = typeof payload.source === 'object' && payload.source !== null;
    }
    if (row.type !== 'response_item') continue;
    if (payload.type === 'message') {
      const parts = payload.content ?? [];
      const text = payload.role === 'user' ? humanText(parts) : replyText(parts);
      if (text && (payload.role === 'user' || payload.role === 'assistant'))
        events.push({ type: payload.role, text: scrub(text) });
    }
    if (
      (payload.type === 'function_call' || payload.type === 'custom_tool_call') &&
      payload.call_id
    )
      events.push({
        type: 'call',
        id: payload.call_id,
        name: payload.name ?? '',
        args: head(scrub(written(payload.arguments ?? payload.input)), 160),
      });
    if (
      (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') &&
      payload.call_id
    )
      results.set(payload.call_id, resultWindow(scrub(written(payload.output))));
  }
  return { session, delegated, events, results };
}

/** One file per entry, as its text or its lines. Delegated subagent sessions are left out. */
export function codexRequests(sessions: Iterable<string | string[]>): HumanRequest[] {
  const found: HumanRequest[] = [];
  let index = 0;
  for (const source of sessions) {
    const lines = typeof source === 'string' ? source.split('\n') : source;
    const { session, delegated, events, results } = read(lines);
    index += 1;
    if (delegated) continue;
    let current = null as HumanRequest | null;
    let reply = '';
    let planned = '';
    let open = null as ReasoningInput['calls'] | null;
    let number = 0;
    for (const event of events) {
      if (event.type === 'assistant') {
        reply = event.text;
        planned = event.text;
        open = null;
      } else if (event.type === 'user') {
        current = {
          session: session || `session-${index}`,
          steps: [],
          turn: {
            kind: 'turn',
            request: head(event.text, 12000),
            prevRequest: head(current?.turn.request ?? '', 600),
            prev: tail(reply, 1000),
            step: 0,
            plan: '',
            calls: [],
            directiveIds: [],
          },
        };
        found.push(current);
        planned = '';
        open = null;
      } else if (current) {
        if (!open) {
          open = [];
          number += 1;
          current.steps.push({
            ...current.turn,
            kind: 'step',
            step: Math.min(10000, number),
            plan: tail(planned, 300),
            calls: open,
          });
        }
        if (open.length < 3)
          open.push({
            name: scrub(event.name).slice(0, 128),
            args: event.args,
            result: results.get(event.id) ?? '',
          });
      }
    }
  }
  return found;
}
