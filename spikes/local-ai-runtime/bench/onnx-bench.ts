// Candidate B: EmbeddingGemma 2 text model through onnxruntime-node 1.30.0 (already bundled
// for the effort judge). Spike only. Usage:
//   node bench/onnx-bench.ts <onnx-dir> <tokenizer-dir> <model_q4|model_quantized> <out.json> [threads]
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCompactTokenizer } from '../../../packages/effort-judge/src/tokenizer.ts';

const [onnxDir, tokenizerDir, modelName, out, threadsArg] = process.argv.slice(2);
if (!onnxDir || !tokenizerDir || !modelName || !out) throw new Error('usage: see header');
const threads = threadsArg ? Number(threadsArg) : 4;
const PREFIX = 'task: classification | query: ';
const REPS = 20;

const ort = createRequire(new URL('../../../packages/effort-judge/package.json', import.meta.url))(
  'onnxruntime-node',
) as typeof import('onnxruntime-node');
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/texts.json', import.meta.url), 'utf8')) as {
  id: string;
  size: string;
  text: string;
}[];

const tokenizer = loadCompactTokenizer(tokenizerDir);
let started = performance.now();
const session = await ort.InferenceSession.create(join(onnxDir, 'onnx', `${modelName}.onnx`), {
  executionProviders: ['cpu'],
  graphOptimizationLevel: 'all',
  intraOpNumThreads: threads,
});
const loadMs = performance.now() - started;
console.log('inputs', session.inputNames, 'outputs', session.outputNames);

function ids(text: string) {
  return [...tokenizer.prefix, ...tokenizer.encode(PREFIX + text.trim()), ...tokenizer.suffix];
}

async function embed(tokens: number[]) {
  const n = tokens.length;
  const feeds: Record<string, import('onnxruntime-node').Tensor> = {
    input_ids: new ort.Tensor('int64', BigInt64Array.from(tokens, BigInt), [1, n]),
    attention_mask: new ort.Tensor('int64', new BigInt64Array(n).fill(1n), [1, n]),
    // The export is the multimodal graph; text-only calls pass zero modality tokens.
    image_features: new ort.Tensor('float32', new Float32Array(0), [0, 512]),
    video_features: new ort.Tensor('float32', new Float32Array(0), [0, 512]),
    audio_features: new ort.Tensor('float32', new Float32Array(0), [0, 512]),
  };
  const output = await session.run(feeds, ['sentence_embedding']);
  const values = Array.from(output.sentence_embedding!.data as Float32Array);
  const norm = Math.hypot(...values);
  return values.map((value) => value / norm);
}

started = performance.now();
await embed(ids(fixtures[0]!.text));
const firstMs = performance.now() - started;

const results = [];
for (const entry of fixtures) {
  const tokens = ids(entry.text);
  const embedding = await embed(tokens);
  const timings: number[] = [];
  for (let i = 0; i < REPS; i++) {
    const t = performance.now();
    await embed(tokens);
    timings.push(performance.now() - t);
  }
  timings.sort((a, b) => a - b);
  const p50 = timings[Math.floor(REPS / 2)]!;
  const p95 = timings[Math.ceil(REPS * 0.95) - 1]!;
  results.push({ id: entry.id, tokens: tokens.length, p50, p95, embedding });
  console.log(`${entry.id.padEnd(14)} ${String(tokens.length).padStart(4)} tok  p50 ${p50.toFixed(1).padStart(7)} ms  p95 ${p95.toFixed(1).padStart(7)} ms`);
}
const rss = process.memoryUsage().rss / 2 ** 20;
writeFileSync(out, JSON.stringify({ runtime: `onnxruntime-node-1.30.0/${modelName}`, threads, loadMs, firstMs, rssMiB: rss, results }));
console.log(`load ${loadMs.toFixed(0)} ms, first ${firstMs.toFixed(0)} ms, rss ${rss.toFixed(0)} MiB`);
