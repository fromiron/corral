// Idle Pi worker: load the agent stack, report memory, wait for shutdown.
const started = performance.now();
await import('@earendil-works/pi-agent-core');
await import('@earendil-works/pi-ai');
const report = { loadMs: performance.now() - started, rss: process.memoryUsage().rss };
if (process.send) {
  process.send(report);
  process.on('message', (m) => m === 'exit' && process.exit(0));
} else {
  const { parentPort } = await import('node:worker_threads');
  parentPort.postMessage(report);
  parentPort.on('message', (m) => m === 'exit' && process.exit(0));
}
