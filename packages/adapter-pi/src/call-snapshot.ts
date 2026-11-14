import {
  type CallSnapshotInput,
  canonicalJson,
  SNAPSHOT_SOURCE_BYTES,
  type SnapshotText,
} from '@corral/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { ToolResultMessage } from '@earendil-works/pi-ai';
import { isCorralState } from './request-record.ts';
import {
  ADVICE_DIRECTIVE_PREFIX,
  DIRECTIVE_PREFIX,
  SDK_DIRECTIVE_PREFIX,
  withoutAssignmentMetadata,
} from './worker-tools.ts';

// The routing view of one request (features/effort-routing.md#판정-입력), read once from the
// context the worker settled: the latest messages and tool batch only, never the whole history.

const QUESTIONS_PREFIX = 'Pending questions from delegated children';

/** Ordinary text only. Hidden thinking and image data never leave the worker. */
const textOf = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part) =>
            part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
          )
          .join('\n')
      : '';
const imagesOf = (content: unknown): number =>
  Array.isArray(content) ? content.filter((part) => part?.type === 'image').length : 0;

const graphemes = (text: string) =>
  Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text),
    (s) => s.segment,
  );

/** Cuts a text to the contract limit: its first 60% and last 40%, with the omission marked. */
export function snapshotText(text: string): SnapshotText {
  const bytes = Buffer.byteLength(text);
  if (bytes <= SNAPSHOT_SOURCE_BYTES) return { text };
  const marker = `\n[… ${bytes} bytes before the cut …]\n`;
  const room = SNAPSHOT_SOURCE_BYTES - Buffer.byteLength(marker);
  const headRoom = Math.floor(room * 0.6);
  // A window of `room` UTF-16 units always holds more than `room` bytes of text.
  let head = '';
  let used = 0;
  for (const piece of graphemes(text.slice(0, room))) {
    const size = Buffer.byteLength(piece);
    if (used + size > headRoom) break;
    head += piece;
    used += size;
  }
  const tailPieces: string[] = [];
  let tailUsed = 0;
  const window = graphemes(text.slice(-room));
  for (let i = window.length - 1; i > 0; i--) {
    const size = Buffer.byteLength(window[i]!);
    if (tailUsed + size > room - used) break;
    tailPieces.push(window[i]!);
    tailUsed += size;
  }
  return { text: head + marker + tailPieces.reverse().join(''), originalBytes: bytes };
}

const isRequest = (message: AgentMessage) => {
  if (message.role !== 'user' || isCorralState(message)) return false;
  const text = textOf(message.content);
  // Directives, a person's or an advice, go to the judgment as their own source, from either
  // worker's message form; neither is the request.
  return ![DIRECTIVE_PREFIX, SDK_DIRECTIVE_PREFIX, ADVICE_DIRECTIVE_PREFIX, QUESTIONS_PREFIX].some(
    (prefix) => text.startsWith(prefix),
  );
};

/** Question IDs in the Corral state the context already carries. */
function presentQuestionIds(stateText: string | undefined): string[] {
  if (!stateText) return [];
  try {
    const questions = JSON.parse(stateText).questions as { questionId?: unknown }[] | undefined;
    return (questions ?? []).flatMap((q) =>
      typeof q.questionId === 'string' ? [q.questionId] : [],
    );
  } catch {
    return [];
  }
}

export function callSnapshotInput(
  context: { messages: readonly AgentMessage[] },
  stateText?: string,
): CallSnapshotInput {
  const messages = context.messages.filter(
    (message) =>
      ['user', 'assistant', 'toolResult'].includes(message.role) && !isCorralState(message),
  );
  const requestIndex = messages.findLastIndex(isRequest);
  const request = messages[requestIndex];
  const assistantIndex = messages.findLastIndex((message) => message.role === 'assistant');
  const step = assistantIndex > requestIndex ? messages[assistantIndex] : undefined;
  const calls =
    step?.role === 'assistant' ? step.content.filter((part) => part.type === 'toolCall') : [];
  const after = messages.slice(assistantIndex + 1);
  // The three latest replies before the step, read backwards so long runs are not rescanned.
  const replies: string[] = [];
  for (let i = (step ? assistantIndex : messages.length) - 1; i >= 0 && replies.length < 3; i--) {
    const message = messages[i]!;
    const text = message.role === 'assistant' ? textOf(message.content) : '';
    if (text.trim()) replies.unshift(text);
  }
  const requestText =
    request?.role === 'user' ? withoutAssignmentMetadata(textOf(request.content)) : '';
  const stepText = step?.role === 'assistant' ? textOf(step.content) : '';
  return {
    request: requestText.trim() ? snapshotText(requestText) : null,
    requestImages: request?.role === 'user' ? imagesOf(request.content) : 0,
    previousAssistant: stepText.trim() ? snapshotText(stepText) : null,
    toolCalls: calls.slice(0, 64).map((call) => {
      const results = after.filter(
        (message): message is ToolResultMessage =>
          message.role === 'toolResult' && message.toolCallId === call.id,
      );
      const latest = results.at(-1);
      return {
        toolCallId: call.id.slice(0, 256),
        name: call.name.slice(0, 128),
        args: snapshotText(canonicalJson(call.arguments ?? {})),
        result: latest ? snapshotText(textOf(latest.content)) : null,
        status: !latest ? 'pending' : latest.isError === true ? 'failed' : 'completed',
      };
    }),
    earlierReplies: replies.map(snapshotText),
    presentQuestionIds: presentQuestionIds(stateText),
  };
}
