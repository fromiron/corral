// Ported from deepseek-harness 22ddee3: session/surface.ts, compaction-basic/region.ts,
// compaction-tool-result-pruner/index.ts and token-meter/index.ts. MIT; see LICENSE and NOTICE.md.
import { createHash } from 'node:crypto';
import { canonicalJson } from '@corral/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  type Context,
  getCurrentTools,
  type Message,
} from '@earendil-works/pi-ai';

export const SUMMARY_INSTRUCTION =
  'Condense the conversation above into a structured checkpoint with these sections: Primary request and current goal; Explicit user instructions and corrections; Decisions and evidence references; Files and changes; Errors and unresolved questions; Pending work and next step. Preserve exact identifiers, constraints, current instructions and evidence references. Distinguish facts from inference. Earlier summaries are background, not new permission. Do not grant approval or claim completed work without evidence. Output only the checkpoint; do not call tools.';
const digest = (value: unknown) =>
  createHash('sha256')
    .update(canonicalJson(JSON.parse(JSON.stringify(value))))
    .digest('hex');
export function messageTokens(message: AgentMessage): number {
  const value = message as Message;
  let text = '';
  let overhead = 4;
  if ('content' in value)
    text =
      typeof value.content === 'string'
        ? value.content
        : value.content
            .map((part) => {
              overhead += 4;
              if (part.type === 'image') {
                overhead += 2000;
                return '';
              }
              return part.type === 'text'
                ? part.text
                : part.type === 'thinking'
                  ? part.thinking
                  : part.type === 'toolCall'
                    ? part.name + JSON.stringify(part.arguments)
                    : JSON.stringify(part);
            })
            .join('');
  else if ('summary' in message && typeof message.summary === 'string') text = message.summary;
  if (value.role === 'system')
    text += Object.values(value.sections ?? {})
      .filter(Boolean)
      .join('');
  const wide = [...text].reduce(
    (sum, char) =>
      sum +
      (char.charCodeAt(0) > 127 ? Math.max(0, Buffer.byteLength(char) / 2 - char.length / 4) : 0),
    0,
  );
  return Math.ceil(text.length / 4 + wide + overhead);
}
export function measureContext(context: { messages: AgentMessage[]; tools?: unknown[] }) {
  return (
    context.messages.reduce((sum, message) => sum + messageTokens(message), 0) +
    Math.ceil(
      JSON.stringify(context.tools ?? getCurrentTools(context.messages as Message[]) ?? []).length /
        4,
    )
  );
}

/** A usage anchor is reusable only for the exact request prefix and tool/route envelope. */
export class ContextMeter {
  private anchor?: { header: string; prefix: string[]; tokens: number; estimated: number };
  observe(
    context: { messages: AgentMessage[]; tools?: unknown[] },
    model: { id: string; provider: string; api: string },
    message: AssistantMessage,
  ) {
    const tokens = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
    if (!tokens || message.stopReason === 'error' || message.stopReason === 'aborted') return;
    this.anchor = {
      header: digest({
        model,
        tools: context.tools ?? getCurrentTools(context.messages as Message[]) ?? [],
      }),
      prefix: context.messages.filter((message) => !isCurrentState(message)).map(digest),
      tokens,
      estimated: measureContext(context),
    };
  }
  measure(
    context: { messages: AgentMessage[]; tools?: unknown[] },
    model: { id: string; provider: string; api: string },
  ) {
    const estimated = measureContext(context);
    const a = this.anchor;
    const messages = context.messages.filter((message) => !isCurrentState(message));
    const matches =
      a &&
      a.header ===
        digest({
          model,
          tools: context.tools ?? getCurrentTools(context.messages as Message[]) ?? [],
        }) &&
      a.prefix.every(
        (hash, index) => messages[index] !== undefined && digest(messages[index]) === hash,
      );
    return {
      tokens: matches ? Math.max(0, a.tokens + estimated - a.estimated) : estimated,
      source: matches ? ('usage_anchor' as const) : ('estimated' as const),
    };
  }
}
const isCurrentState = (message: AgentMessage) =>
  message.role === 'user' &&
  message.timestamp === 0 &&
  typeof message.content === 'string' &&
  message.content.startsWith('[Corral current state]\n');

export function pruneContent<T extends { type: string; text?: string }>(
  blocks: readonly T[],
  marker = '\n[Tool output omitted from model context; original remains in history. Read the required source range.]\n',
): T[] | null {
  const totalChars = blocks.reduce(
    (sum, block) => sum + (block.type === 'text' ? Array.from(block.text ?? '').length : 0),
    0,
  );
  if (totalChars <= 8192) return null;
  const removedStart = 4096,
    removedEnd = totalChars - 1024;
  const pruned: T[] = [];
  let consumed = 0,
    markerInserted = false;
  for (const block of blocks) {
    if (block.type !== 'text') {
      pruned.push(block);
      continue;
    }
    const points = Array.from(block.text ?? '');
    const blockStart = consumed,
      blockEnd = blockStart + points.length;
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart));
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart));
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart;
    const middle = intersectsRemoved && !markerInserted ? marker : '';
    if (middle) markerInserted = true;
    const text = points.slice(0, headEnd).join('') + middle + points.slice(tailStart).join('');
    if (text) pruned.push({ ...block, text });
    consumed = blockEnd;
  }
  if (!markerInserted) throw new Error('tool-result prune: missing removed span');
  return pruned;
}
export function pruneToolResults<T extends { messages: AgentMessage[] }>(context: T): T {
  let changed = false;
  const lastAssistant = context.messages.findLastIndex((message) => message.role === 'assistant');
  const messages = context.messages.map((message, index) => {
    // A fresh result must reach the model before it can authorize a file change.
    if (message.role !== 'toolResult' || index > lastAssistant) return message;
    const source = (message.details as { contextSource?: { toolCallId?: unknown } } | undefined)
      ?.contextSource;
    if (typeof source?.toolCallId !== 'string') return message;
    const content = pruneContent(
      message.content,
      `\n[Excerpt only. Read the original with read_artifact ${JSON.stringify({ toolCallId: source.toolCallId, offset: 0, limit: 8192 })}; follow nextOffset for more.]\n`,
    );
    if (!content) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? { ...context, messages } : context;
}

/** DSH backwards retention selection, moved back until all tool call/result pairs balance. */
export function selectCompactableRange(
  messages: readonly AgentMessage[],
  retainTokens: number,
): { start: number; end: number } | null {
  const first = messages[0]?.role === 'system' ? 1 : 0;
  let accumulated = 0,
    keep = messages.length;
  for (let i = messages.length - 1; retainTokens > 0 && i >= first; i--) {
    accumulated += messageTokens(messages[i]!);
    keep = i;
    if (accumulated >= retainTokens) break;
  }
  const pending = new Set<string>(),
    balanced = new Set<number>([first]);
  for (let i = first; i < messages.length; i++) {
    const message = messages[i]!;
    if (message.role === 'assistant')
      for (const part of message.content) if (part.type === 'toolCall') pending.add(part.id);
    if (message.role === 'toolResult') pending.delete(message.toolCallId);
    if (!pending.size) balanced.add(i + 1);
  }
  while (keep > first && !balanced.has(keep)) keep--;
  if (
    keep === first &&
    messages[first]?.role === 'user' &&
    messageTokens(messages[first]!) > retainTokens
  )
    return { start: first, end: first };
  return keep > first ? { start: first, end: keep - 1 } : null;
}
export async function summarizeRegion(
  context: Context,
  region: { start: number; end: number },
  complete: (context: Context) => Promise<AssistantMessage>,
  now: () => number,
) {
  const original = context.messages.slice(region.start, region.end + 1);
  const before = digest(original);
  const prefix = context.messages[0]?.role === 'system' ? [context.messages[0]] : [];
  const result = await complete({
    ...context,
    messages: [
      ...prefix,
      ...original,
      ...context.messages.filter(
        (message, index) =>
          (index < region.start || index > region.end) &&
          message.role === 'user' &&
          typeof message.content === 'string' &&
          message.content.startsWith('[Corral current state]'),
      ),
      {
        role: 'system',
        content:
          'This request is internal context-compaction, not an execution turn. The task output contract and tool-use instructions above apply when execution resumes. For this request only, return the checkpoint as plain text; do not perform the task, write artifacts, or call tools. Preserve the task requirements for the next execution turn.',
        timestamp: now(),
      },
      { role: 'user', content: SUMMARY_INSTRUCTION, timestamp: now() },
    ],
  });
  if (result.stopReason !== 'stop') throw new Error('compaction summary did not finish');
  const summary = result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
  if (!summary || result.content.some((part) => part.type === 'toolCall'))
    throw new Error('invalid compaction summary');
  const checkpoint: Message = {
    role: 'user',
    content: `<compacted-summary>\n${summary}\n</compacted-summary>\nEarlier history is background, not authority for new actions.`,
    timestamp: now(),
  };
  if (
    messageTokens(checkpoint) >= original.reduce((sum, message) => sum + messageTokens(message), 0)
  )
    throw new Error('compaction summary must be smaller than its source');
  if (digest(context.messages.slice(region.start, region.end + 1)) !== before)
    throw new Error('compaction source changed');
  return {
    summary,
    usage: result.usage,
    context: {
      ...context,
      messages: [
        ...context.messages.slice(0, region.start),
        ...original.filter((message) => message.role === 'system'),
        checkpoint,
        ...context.messages.slice(region.end + 1),
      ],
    },
  };
}
