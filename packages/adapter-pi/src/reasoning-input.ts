import type { ReasoningInput } from '@corral/contracts';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { Context } from '@earendil-works/pi-ai';

/** Read only ordinary text. Hidden thinking and image data never enter the classifier. */
const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part) =>
            part?.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
          )
          .join('\n')
      : '';
const head = (value: string, n: number) => Array.from(value).slice(0, n).join('');
const tail = (value: string, n: number) => Array.from(value).slice(-n).join('');
const resultWindow = (value: string) =>
  Array.from(value).length <= 3000 ? value : `${head(value, 2000)}\n…\n${tail(value, 1000)}`;

export function requestReasoningInput(
  context: { messages: AgentMessage[] },
  purpose: string,
  assignment: string,
  directiveIds: string[],
): ReasoningInput {
  const messages = context.messages.filter((message): message is Context['messages'][number] =>
    ['system', 'user', 'assistant', 'toolResult'].includes(message.role),
  );
  const userIndex = messages.findLastIndex((message) => message.role === 'user');
  const users = messages.filter((message) => message.role === 'user');
  const assistantIndex = messages.findLastIndex((message) => message.role === 'assistant');
  const assistant = messages[assistantIndex];
  const toolCalls =
    assistant?.role === 'assistant'
      ? assistant.content.filter((part) => part.type === 'toolCall')
      : [];
  const calls = toolCalls.slice(0, 3).map((call) => ({
    name: call.name.slice(0, 128),
    args: head(JSON.stringify(call.arguments), 160),
    result: resultWindow(
      messages
        .slice(assistantIndex + 1)
        .filter((message) => message.role === 'toolResult' && message.toolCallId === call.id)
        .map((message) => text(message.content))
        .join('\n'),
    ),
  }));
  const step = assistantIndex > userIndex && calls.length > 0;
  const previous = messages.slice(0, userIndex).findLast((message) => message.role === 'assistant');
  return {
    kind: purpose === 'compaction' ? 'compaction' : step ? 'step' : 'turn',
    request: head([assignment, text(users.at(-1)?.content)].filter(Boolean).join('\n'), 12000),
    prevRequest: head(text(users.at(-2)?.content), 600),
    prev: tail(text(previous?.content), 1000),
    step: Math.min(10000, messages.filter((message) => message.role === 'assistant').length),
    plan: step ? tail(text(assistant?.content), 300) : '',
    calls: step ? calls : [],
    directiveIds,
  };
}
