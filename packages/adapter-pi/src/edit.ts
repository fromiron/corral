import { fileURLToPath } from 'node:url';
import {
  type DecisionCancellation,
  EditTextRequest,
  EditTextResult,
  type Scheduler,
} from '@corral/contracts';
import { type Channel, sdkProcessChannel } from './channel.ts';

const ENTRY = fileURLToPath(new URL('./edit-worker-main.ts', import.meta.url));
const timers: Scheduler = {
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
};

/** The trusted transformer reports Pi validation errors without paths to the local machine. */
export class PiEditError extends Error {}

/** Pi transforms bytes in a disposable worker; this API never reads or writes a worktree. */
export async function editText(
  raw: EditTextRequest,
  options: { spawn?: () => Channel; cancellation?: DecisionCancellation; timers?: Scheduler } = {},
): Promise<EditTextResult> {
  const request = EditTextRequest.parse(raw);
  if (Buffer.byteLength(JSON.stringify(request)) > 4 * 1024 * 1024)
    throw new Error('edit input exceeds the size limit');
  if (options.cancellation?.aborted) throw new Error('edit cancelled');
  const channel = options.spawn?.() ?? sdkProcessChannel(ENTRY);
  return new Promise((resolve, reject) => {
    let started = false;
    let response: EditTextResult | undefined;
    let error: string | undefined;
    let refusal = false;
    let cancelTimer = () => {};
    let unsubscribe = () => {};
    const stop = (reason: string) => {
      error = reason;
      channel.kill();
    };
    channel.onFrame((raw) => {
      const frame = raw as { type?: string; result?: unknown; message?: unknown };
      if (frame.type === 'ready' && !started) {
        started = true;
        channel.send(request);
      } else if (frame.type === 'edited' && started && !response && !error) {
        const parsed = EditTextResult.safeParse(frame.result);
        if (parsed.success) response = parsed.data;
        else stop('invalid edit worker response');
      } else if (
        frame.type === 'error' &&
        typeof frame.message === 'string' &&
        frame.message.length <= 2000 &&
        !response
      ) {
        error = frame.message;
        refusal = true;
      } else stop('invalid edit worker response');
    });
    channel.onExit((code) => {
      cancelTimer();
      unsubscribe();
      if (error || code !== 0 || !response || options.cancellation?.aborted)
        reject(refusal ? new PiEditError(error) : new Error(error ?? 'edit worker failed'));
      else resolve(response);
    });
    cancelTimer = (options.timers ?? timers).after(10000, () => stop('edit worker timed out'));
    unsubscribe = options.cancellation?.onCancel(() => stop('edit cancelled')) ?? (() => {});
  });
}
