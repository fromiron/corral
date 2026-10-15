// Worker thread that owns the ONNX session, so a ~0.1 s CPU-bound judgment never blocks the
// Coordinator's event loop (C-072). Derived from mixdog `judge-worker.mjs` (Apache-2.0; see
// ../NOTICE.md). Changes for Corral: tokenizing happens in the caller; this worker only runs
// the model on token ids and returns raw logits.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';

interface Ort {
  InferenceSession: {
    create(path: string, options: Record<string, unknown>): Promise<Session>;
  };
  Tensor: new (type: string, data: BigInt64Array, dims: number[]) => unknown;
}
interface Session {
  run(feeds: Record<string, unknown>): Promise<Record<string, { data: ArrayLike<number> }>>;
}

const require = createRequire(import.meta.url);
const ort = require('onnxruntime-node') as Ort;
const dir = (workerData as { dir: string }).dir;

const feeds = (ids: number[]) => ({
  input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
  attention_mask: new ort.Tensor('int64', new BigInt64Array(ids.length).fill(1n), [1, ids.length]),
});

const loaded = ort.InferenceSession.create(join(dir, 'model.onnx'), {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
  // One judgment runs at a time; 4 threads shorten the long-input tail.
  intraOpNumThreads: 4,
});

loaded.then(
  () => parentPort?.postMessage({ type: 'ready' }),
  (error: unknown) => parentPort?.postMessage({ type: 'load-error', message: String(error) }),
);

parentPort?.on('message', async (message: { id: number; ids: number[] }) => {
  try {
    const session = await loaded;
    const out = await session.run(feeds(message.ids));
    const logits = out.logits;
    if (!logits) throw new Error('the model has no logits output');
    parentPort?.postMessage({ type: 'result', id: message.id, logits: Array.from(logits.data) });
  } catch (error) {
    parentPort?.postMessage({ type: 'error', id: message.id, message: String(error) });
  }
});
