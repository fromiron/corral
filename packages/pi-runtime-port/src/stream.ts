// Adapted from PI-Desktop 1a812ed: stream-coalescer.ts and message-stream.ts (LGPL-3.0-only).
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  parseStreamingJson,
} from '@earendil-works/pi-ai';

type Delta = Extract<
  AssistantMessageEvent,
  { type: 'text_delta' | 'thinking_delta' | 'toolcall_delta' }
>;
type BlockEvent = Extract<AssistantMessageEvent, { contentIndex: number }>;
type WireBlock<E = BlockEvent> = E extends BlockEvent
  ? Omit<E, 'partial'> & { block?: AssistantMessage['content'][number] }
  : never;
export type WireStreamEvent = Exclude<AssistantMessageEvent, BlockEvent> | WireBlock;
const isDelta = (event: WireStreamEvent): event is Omit<Delta, 'partial'> =>
  event.type === 'text_delta' || event.type === 'thinking_delta' || event.type === 'toolcall_delta';

export function createStreamCoalescer(
  emit: (event: WireStreamEvent) => void,
  schedule: (flush: () => void, delay: number) => () => void = (flush, delay) => {
    const timer = setTimeout(flush, delay);
    timer.unref?.();
    return () => clearTimeout(timer);
  },
) {
  let pending: Omit<Delta, 'partial'> | undefined;
  let cancelTimer: (() => void) | undefined;
  const flush = () => {
    cancelTimer?.();
    cancelTimer = undefined;
    const next = pending;
    pending = undefined;
    if (next) emit(next);
  };
  return {
    push(event: AssistantMessageEvent) {
      if (!isDelta(event)) {
        flush();
        if ('contentIndex' in event) {
          const { partial, ...frame } = event;
          emit({ ...frame, block: partial.content[event.contentIndex] });
        } else
          emit(
            event.type === 'start'
              ? { ...event, partial: { ...event.partial, content: [] } }
              : event,
          );
        return;
      }
      const { partial: _partial, ...next } = event as Delta;
      if (pending && (pending.type !== next.type || pending.contentIndex !== next.contentIndex))
        flush();
      if (pending) pending = { ...next, delta: pending.delta + next.delta };
      else {
        pending = next;
        cancelTimer = schedule(flush, 16);
      }
      if (pending.delta.length >= 16_384) flush();
    },
    flush,
    dispose: flush,
  };
}

/** Each stream owns its reconstruction; a full terminal message stays authoritative. */
export function createStreamDecoder() {
  let partial: AssistantMessage | undefined;
  const argumentsByIndex = new Map<number, string>();
  return (event: WireStreamEvent): AssistantMessageEvent => {
    if (!isDelta(event)) {
      if (event.type === 'start') partial = { ...event.partial, content: [] };
      if ('contentIndex' in event) {
        if (!partial) throw new Error('content block before message start');
        const block = structuredClone(event.block);
        if (!block) throw new Error('missing content block');
        if (event.type === 'text_start' && block.type === 'text') block.text = '';
        if (event.type === 'thinking_start' && block.type === 'thinking' && !block.redacted)
          block.thinking = '';
        if (event.type === 'toolcall_start' && block.type === 'toolCall') block.arguments = {};
        partial.content[event.contentIndex] = block;
      }
      if (event.type === 'toolcall_start') argumentsByIndex.set(event.contentIndex, '');
      if (event.type === 'toolcall_end') argumentsByIndex.delete(event.contentIndex);
      if ('contentIndex' in event) {
        const { block: _block, ...frame } = event;
        return { ...frame, partial: partial! } as AssistantMessageEvent;
      }
      return 'partial' in event && partial ? { ...event, partial } : event;
    }
    if (!partial) throw new Error('stream delta before message start');
    const block = partial.content[event.contentIndex];
    if (event.type === 'text_delta' && block?.type === 'text') block.text += event.delta;
    else if (event.type === 'thinking_delta' && block?.type === 'thinking')
      block.thinking += event.delta;
    else if (event.type === 'toolcall_delta' && block?.type === 'toolCall') {
      const text = (argumentsByIndex.get(event.contentIndex) ?? '') + event.delta;
      argumentsByIndex.set(event.contentIndex, text);
      block.arguments = parseStreamingJson(text);
    } else throw new Error('stream delta does not match its content block');
    return { ...event, partial } as AssistantMessageEvent;
  };
}
