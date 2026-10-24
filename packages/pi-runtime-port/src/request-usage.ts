// Adapted from PI-Desktop 1a812ed, request-usage.ts (LGPL-3.0-only).
import type { AssistantMessage, AssistantMessageEventStream } from '@earendil-works/pi-ai';

/** A physical stream reports once even when both the iterator and result() are consumed. */
export function accountModelStream(
  stream: AssistantMessageEventStream,
  onUsage: (message: AssistantMessage) => void | Promise<void>,
): AssistantMessageEventStream {
  let reported = false;
  const account = async (message: AssistantMessage) => {
    if (!reported) {
      reported = true;
      await onUsage(message);
    }
    return message;
  };
  return new Proxy(stream, {
    get(target, property, receiver) {
      if (property === 'result') return async () => account(await target.result());
      if (property === Symbol.asyncIterator)
        return async function* () {
          for await (const event of target) {
            if (event.type === 'done') await account(event.message);
            if (event.type === 'error') await account(event.error);
            yield event;
          }
        };
      return Reflect.get(target, property, receiver);
    },
  });
}
