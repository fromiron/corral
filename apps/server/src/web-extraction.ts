import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { InputError, MAX_INPUT_BYTES } from './safe-http.ts';

const Extracted = z.strictObject({
  title: z.string().max(200),
  text: z.string().min(1).max(MAX_INPUT_BYTES),
  publishedAt: z.iso.datetime().nullable(),
  modifiedAt: z.iso.datetime().nullable(),
});
let active = 0;

/** Untrusted parsing must not block the Coordinator's cancellation and control requests. */
export async function extractHtml(
  html: string,
  signal: AbortSignal,
): Promise<z.infer<typeof Extracted>> {
  signal.throwIfAborted();
  if (Buffer.byteLength(html) > MAX_INPUT_BYTES) throw new InputError('HTML exceeds 1 MiB');
  if (active >= 4) throw new InputError('HTML extraction capacity is full; retry later');
  active++;
  let worker: Worker | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  try {
    worker = new Worker(new URL('./web-extraction-worker.ts', import.meta.url), {
      workerData: html,
      env: {},
      execArgv: [],
      stdout: true,
      stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
    });
    return await new Promise((resolve, reject) => {
      const fail = () =>
        reject(new InputError('HTML extraction failed, exceeded its limit or was cancelled'));
      abort = fail;
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(fail, 5000);
      worker!.once('error', fail);
      worker!.once('exit', fail);
      worker!.once('message', (message: unknown) => {
        const result = Extracted.safeParse(message);
        if (result.success && !signal.aborted) resolve(result.data);
        else fail();
      });
    });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    try {
      await worker?.terminate();
    } finally {
      active--;
    }
  }
}
