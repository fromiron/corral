// Candidate A: the Rust LiteRT-LM helper driven from Node over stdin/stdout. Spike only.
// Usage: node bench/helper-bench.ts <helper> <lib> <model> <cpu|gpu> <threads|0> <max_input|0> <out.json>
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [helper, lib, model, backend, threads, maxInput, out, cacheDir] = process.argv.slice(2);
if (!helper || !lib || !model || !backend || !threads || !maxInput || !out) throw new Error('usage: see header');
const PREFIX = 'task: classification | query: ';
const REPS = 20;
const fixtures = JSON.parse(readFileSync(new URL('../fixtures/texts.json', import.meta.url), 'utf8')) as {
  id: string;
  size: string;
  text: string;
}[];

const spawnedAt = performance.now();
const child = spawn(helper, [lib, model, backend, threads, maxInput, ...(cacheDir ? [cacheDir] : [])], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {},
});
let stderr = '';
child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
const lines = createInterface({ input: child.stdout });
const waiting = new Map<number, (value: { computeMs: number; embeddings?: number[][]; error?: string }) => void>();
let ready: (value: { loadMs: number }) => void;
const readyPromise = new Promise<{ loadMs: number }>((resolve) => (ready = resolve));
lines.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.ready) return ready(message);
  waiting.get(message.id)?.(message);
  waiting.delete(message.id);
});
child.on('exit', (code) => {
  if (waiting.size) console.error(`helper exited ${code}: ${stderr.slice(-2000)}`);
});

let nextId = 1;
function request(texts: string[]) {
  const id = nextId++;
  return new Promise<{ computeMs: number; embeddings?: number[][]; error?: string }>((resolve) => {
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ id, texts, dim: 768 })}\n`);
  });
}

function rssMiB() {
  const status = readFileSync(`/proc/${child.pid}/status`, 'utf8');
  const kb = (key: string) => Number(/(\d+) kB/.exec(status.split('\n').find((l) => l.startsWith(key)) ?? '')?.[1] ?? 0);
  return { rss: kb('VmRSS') / 1024, peak: kb('VmHWM') / 1024 };
}

const { loadMs } = await readyPromise;
const readyMs = performance.now() - spawnedAt;
let t = performance.now();
const first = await request([PREFIX + fixtures[0]!.text.trim()]);
if (first.error) throw new Error(first.error);
const firstMs = performance.now() - t;

const results = [];
for (const entry of fixtures) {
  const text = PREFIX + entry.text.trim();
  const embedding = (await request([text])).embeddings![0]!;
  const wall: number[] = [];
  const compute: number[] = [];
  for (let i = 0; i < REPS; i++) {
    t = performance.now();
    const response = await request([text]);
    wall.push(performance.now() - t);
    compute.push(response.computeMs);
  }
  wall.sort((a, b) => a - b);
  compute.sort((a, b) => a - b);
  const p50 = wall[Math.floor(REPS / 2)]!;
  const p95 = wall[Math.ceil(REPS * 0.95) - 1]!;
  const overhead = p50 - compute[Math.floor(REPS / 2)]!;
  results.push({ id: entry.id, p50, p95, overhead, embedding });
  console.log(`${entry.id.padEnd(14)} p50 ${p50.toFixed(1).padStart(7)} ms  p95 ${p95.toFixed(1).padStart(7)} ms  ipc ${overhead.toFixed(2)} ms`);
}

const shorts = fixtures.filter((entry) => entry.size === 'short').map((entry) => PREFIX + entry.text.trim());
t = performance.now();
const batch = await request(shorts);
const batch16Ms = performance.now() - t;
if (batch.error) throw new Error(batch.error);

// Two requests in flight: the helper serves them one after the other.
t = performance.now();
await Promise.all([request([shorts[0]!]), request([shorts[1]!])]);
const twoInFlightMs = performance.now() - t;

const memory = rssMiB();
t = performance.now();
child.stdin.end();
await new Promise((resolve) => child.once('exit', resolve));
const shutdownMs = performance.now() - t;

writeFileSync(
  out,
  JSON.stringify({ runtime: `rust-helper/litert-lm-0.19.0`, backend, threads, maxInput, loadMs, readyMs, firstMs, batch16Ms, twoInFlightMs, shutdownMs, memory, results }),
);
console.log(
  `helper load ${loadMs.toFixed(0)} ms, ready ${readyMs.toFixed(0)} ms, first ${firstMs.toFixed(0)} ms, batch16 ${batch16Ms.toFixed(0)} ms, two in flight ${twoInFlightMs.toFixed(0)} ms, shutdown ${shutdownMs.toFixed(0)} ms, rss ${memory.rss.toFixed(0)} MiB (peak ${memory.peak.toFixed(0)})`,
);
