// The text the judge model sees, in the formats it was trained on (calibration.json
// `inputFormat`). Derived from mixdog `src/runtime/effort-judge/judge-input.mjs` and
// `judge-worker.mjs` (Apache-2.0; see ../NOTICE.md). Changes for Corral: TypeScript; Corral
// judges each model request of an execution as a turn whose "request" is the request excerpt
// (CR-003 §3.5) and has no previous reply, so step judgments are not used.
import type { CompactTokenizer } from './tokenizer.ts';

const FENCE = /```+[\s\S]*?(?:```+|$)/g;
const TAG_BLOCK = /<([A-Za-z][A-Za-z0-9_-]*)(?:[ \t\r\n][^>]*)?>[\s\S]*?<\/\1>/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI colour codes are stripped
const ANSI = /\u001b\[[0-9;]*m/g;
const HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{12,}(?![0-9A-Za-z])/g;
const SPACES = /[ \t]+/g;
const BLANK_LINES = /\n[ \t]*\n[\n \t]*/g;

/** Removes text that carries no difficulty signal, the same way training did. */
export function cleanJudgeText(text: string): string {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI, '')
    .replace(FENCE, ' [code] ')
    .replace(TAG_BLOCK, ' ')
    .replace(HEX, (m) => m.slice(0, 7))
    .replace(SPACES, ' ')
    .replace(BLANK_LINES, '\n')
    .trim();
}

const head = (text: string, n: number) => Array.from(text).slice(0, n).join('');
const tail = (text: string, n: number) => {
  const cps = Array.from(text);
  return cps.slice(Math.max(0, cps.length - n)).join('');
};

export type InputFormat = 'pr' | 'rp' | 'rpq' | 'rpc' | 'pack';

export const PACK_BUDGET = Object.freeze({ request: 64, prevRequest: 24, replyHead: 16 });

function judgeText(format: InputFormat, request: string, prev: string, prevRequest: string) {
  if (format === 'rpc')
    return `request: ${cleanJudgeText(head(request, 1500))}\nprevious reply: ${cleanJudgeText(tail(prev, 1000))}`;
  if (format === 'rpq')
    return `request: ${head(request, 1500)}\nprevious request: ${head(prevRequest, 300)}\nprevious reply: ${tail(prev, 1000)}`;
  const req = head(request, 1500);
  return format === 'rp'
    ? `request: ${req}\nprevious reply: ${tail(prev, 1000)}`
    : `previous reply: ${tail(prev, 300)}\nrequest: ${req}`;
}

function packIds(
  tokenizer: CompactTokenizer,
  request: string,
  prevRequest: string,
  prev: string,
  maxTokens: number,
): number[] {
  const room = maxTokens - tokenizer.prefix.length - tokenizer.suffix.length;
  const req = tokenizer
    .encode(`request: ${cleanJudgeText(head(request, 1500))}`)
    .slice(0, PACK_BUDGET.request);
  const q = prevRequest
    ? tokenizer
        .encode(`previous request: ${cleanJudgeText(head(prevRequest, 600))}`)
        .slice(0, PACK_BUDGET.prevRequest)
    : [];
  const reply = cleanJudgeText(tail(prev, 1000));
  const at = reply.indexOf('\n');
  const [first, rest] = at < 0 ? [reply, ''] : [reply.slice(0, at), reply.slice(at + 1)];
  const top = first
    ? tokenizer.encode(`previous reply: ${first}`).slice(0, PACK_BUDGET.replyHead)
    : [];
  const left = Math.max(0, room - req.length - q.length - top.length);
  const end = rest && left > 0 ? tokenizer.encode(rest) : [];
  const endIds = end.slice(Math.max(0, end.length - left));
  return [...tokenizer.prefix, ...req, ...q, ...top, ...endIds, ...tokenizer.suffix].slice(
    0,
    maxTokens,
  );
}

/** Token ids for one turn: <bos> text <eos>, within the trained token budget. */
export function inputIds(
  tokenizer: CompactTokenizer,
  format: InputFormat,
  maxTokens: number,
  {
    request,
    prev = '',
    prevRequest = '',
  }: { request: string; prev?: string; prevRequest?: string },
): number[] {
  if (format === 'pack') return packIds(tokenizer, request, prevRequest, prev, maxTokens);
  const room = maxTokens - tokenizer.prefix.length - tokenizer.suffix.length;
  const body = tokenizer.encode(judgeText(format, request, prev, prevRequest)).slice(0, room);
  return [...tokenizer.prefix, ...body, ...tokenizer.suffix];
}
