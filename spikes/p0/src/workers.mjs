// C-052 worker spike (ADR-017): 12 resident workers as child processes vs worker threads.
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';

const N = 12;
const child = new URL('./worker-child.mjs', import.meta.url);
const rssOf = (pid) => Number(readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1]) * 4096;
const mb = (bytes) => Math.round(bytes / 1024 / 1024);
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1];

async function processes() {
  const ready = [];
  const procs = await Promise.all(
    Array.from({ length: N }, () => {
      const t0 = performance.now();
      const proc = fork(child);
      return new Promise((resolve) => proc.once('message', (m) => { ready.push(performance.now() - t0); resolve({ proc, ...m }); }));
    }),
  );
  const totalRss = procs.reduce((sum, p) => sum + rssOf(p.proc.pid), 0);
  const exits = await Promise.all(procs.map(({ proc }) => new Promise((resolve) => { proc.once('exit', (code) => resolve(code)); proc.send('exit'); })));
  return { totalRssMB: mb(totalRss), perWorkerRssMB: mb(totalRss / N), readyP95Ms: Math.round(p95(ready)), cleanExits: exits.every((c) => c === 0) };
}

async function threads() {
  const base = rssOf(process.pid);
  const ready = [];
  const workers = await Promise.all(
    Array.from({ length: N }, () => {
      const t0 = performance.now();
      const worker = new Worker(child);
      return new Promise((resolve) => worker.once('message', () => { ready.push(performance.now() - t0); resolve(worker); }));
    }),
  );
  const totalRss = rssOf(process.pid) - base;
  const exits = await Promise.all(workers.map((w) => new Promise((resolve) => { w.once('exit', resolve); w.postMessage('exit'); })));
  return { addedRssMB: mb(totalRss), perWorkerRssMB: mb(totalRss / N), readyP95Ms: Math.round(p95(ready)), cleanExits: exits.every((c) => c === 0) };
}

const result = { workers: N, node: process.version, childProcesses: await processes(), workerThreads: await threads() };
console.log(JSON.stringify(result, null, 2));
