import type { IncomingMessage } from 'node:http';

export type RejectedBodyDrain = 'drained' | 'byte_limit' | 'timeout' | 'aborted';

/** Discards rejected bytes only; it never parses them or changes the accepted body limit. */
export function drainRejectedBody(
  request: IncomingMessage,
  options: { bodyLimit: number; requestTimeoutMs: number; elapsedMs: number },
): Promise<RejectedBodyDrain> {
  if (request.readableEnded) return Promise.resolve('drained');
  if (request.destroyed) return Promise.resolve('aborted');
  const remainingMs = options.requestTimeoutMs - options.elapsedMs;
  if (remainingMs <= 0) {
    request.pause();
    return Promise.resolve('timeout');
  }
  // This is a discard allowance after parser rejection, not a larger accepted body.
  const maximumBytes = 2 * options.bodyLimit;
  return new Promise((resolve) => {
    let bytes = 0;
    let settled = false;
    const finish = (result: RejectedBodyDrain) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('aborted', onAbort);
      request.removeListener('error', onAbort);
      request.removeListener('close', onClose);
      if (result !== 'drained') request.pause();
      resolve(result);
    };
    const onData = (chunk: Buffer | string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maximumBytes) finish('byte_limit');
    };
    const onEnd = () => finish('drained');
    const onAbort = () => finish('aborted');
    const onClose = () => finish(request.readableEnded ? 'drained' : 'aborted');
    const timer = setTimeout(() => finish('timeout'), Math.ceil(remainingMs));
    timer.unref();
    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAbort);
    request.once('error', onAbort);
    request.once('close', onClose);
    request.resume();
  });
}
