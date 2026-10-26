import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { join } from 'node:path';
import { flamegraph } from '../../../../tools/release/profile.ts';
import { expect, test } from './harness.ts';

const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? Infinity;
const latencyFailures = (receiptMs: number[], domainMs: number[]) => [
  ...(p95(receiptMs) > 200 ? ['receipt p95 exceeds 200ms'] : []),
  ...(p95(domainMs) > 300 ? ['committed event to UI p95 exceeds 300ms'] : []),
];

test('production fixed load stays within latency and DOM budgets', async ({
  page,
  browser,
  performanceServer,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await performanceServer.open();
  await expect(page.getByTestId('timeline-count')).toContainText('10,0');
  expect(await page.getByTestId('timeline-row').count()).toBeLessThan(60);
  await expect(page.locator('[data-execution-id]')).toHaveCount(101);
  expect(performanceServer.persisted()).toEqual({ events: 10_000, commands: 1, executions: 101 });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.start');
  await page.evaluate(() => {
    const canvas = document.querySelector('[data-testid="performance-canvas"]');
    if (!canvas) throw new Error('missing canvas');
    const mutations: MutationRecord[] = [];
    new MutationObserver((records) => mutations.push(...records)).observe(canvas, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    Object.assign(window, { performanceCanvasMutations: mutations });
  });
  const stopFrames = performanceServer.startFrames();
  await page.getByRole('button', { name: 'Run fixed benchmark' }).click();
  await expect
    .poll(async () => Number(await page.getByTestId('performance-seq').textContent()))
    .toBeGreaterThan(10_005);
  const steadyCanvasMutations = await page.evaluate(
    () =>
      (window as unknown as { performanceCanvasMutations: unknown[] }).performanceCanvasMutations
        .length,
  );
  expect(steadyCanvasMutations).toBe(0);
  const node = page.locator('.react-flow__node').first();
  const before = await node.getAttribute('style');
  const box = await node.boundingBox();
  if (!box) throw new Error('missing draggable node');
  await page.mouse.move(box.x + 50, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 60, { steps: 30 });
  await page.mouse.up();
  await expect(node).not.toHaveAttribute('style', before ?? '');
  await expect(page.getByTestId('performance-result')).not.toHaveText('ready', { timeout: 30_000 });
  const result = JSON.parse(await page.getByTestId('performance-result').innerText()) as {
    transport: string;
    nodes: number;
    historicalExecutions: number;
    initialEvents: number;
    frames: number;
    durationMs: number;
    receiptMs: number[];
    visible: { eventId: string; at: number }[];
    error?: string;
  };
  stopFrames();
  expect(result.error).toBeUndefined();
  const domainMs = result.visible.map(({ eventId, at }) => {
    const committed = performanceServer.committed.get(eventId);
    if (committed === undefined) throw new Error(`Missing post-commit timestamp: ${eventId}`);
    return at - committed;
  });
  const profile = await cdp.send('Profiler.stop');
  const flamegraphPath = info.outputPath('cpu-flamegraph.svg');
  writeFileSync(flamegraphPath, flamegraph(profile.profile));
  await info.attach('cpu-flamegraph.svg', { path: flamegraphPath, contentType: 'image/svg+xml' });
  const profilePath = info.outputPath('cpu-profile.cpuprofile');
  writeFileSync(profilePath, JSON.stringify(profile.profile));
  await info.attach('cpu-profile.cpuprofile', {
    path: profilePath,
    contentType: 'application/json',
  });
  expect(result.error).toBeUndefined();
  expect(result.transport).toBe('http-sse-sqlite');
  expect(result.receiptMs).toHaveLength(100);
  expect(domainMs).toHaveLength(100);
  expect(domainMs.every((elapsed) => elapsed >= 0)).toBe(true);
  await expect(page.getByTestId('live-text')).toHaveText(/^x+$/);
  const streamTextLength = (await page.getByTestId('live-text').innerText()).length;
  expect(streamTextLength).toBeGreaterThanOrEqual(result.frames);
  expect(performanceServer.persisted()).toEqual({ events: 10_100, commands: 101, executions: 101 });
  expect(result.nodes).toBe(20);
  expect(result.historicalExecutions).toBe(100);
  expect(result.initialEvents).toBe(10_000);
  const receiptP95 = p95(result.receiptMs);
  const domainP95 = p95(domainMs);
  const framesPerSecond = (result.frames / result.durationMs) * 1000;
  const canvasMutations = await page.evaluate(
    () =>
      (window as unknown as { performanceCanvasMutations: unknown[] }).performanceCanvasMutations
        .length,
  );
  const assets = join(import.meta.dirname, '../..', 'dist-performance/assets');
  const hash = createHash('sha256');
  for (const file of readdirSync(assets).sort())
    hash.update(file).update(readFileSync(join(assets, file)));
  const measurementsPath = info.outputPath('measurements.json');
  writeFileSync(
    measurementsPath,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        buildSha256: hash.digest('hex'),
        browser: browser.version(),
        viewport: { width: 1280, height: 800 },
        cpu: cpus()[0]?.model,
        logicalCpus: cpus().length,
        memoryBytes: totalmem(),
        node: process.version,
        profileEnabled: true,
        receiptP95,
        domainP95,
        framesPerSecond,
        canvasMutations,
        steadyCanvasMutations,
        draggedDuringLoad: true,
        timelineRows: await page.getByTestId('timeline-row').count(),
        ...result,
        domainMs,
        committedAt: Object.fromEntries(performanceServer.committed),
        streamTextLength,
        clock:
          'Date.now on the same host; post-commit subscriber to browser layout + animation frame',
        sqlite: 'WAL synchronous=FULL; isolated temporary workspace',
      },
      null,
      2,
    ),
  );
  await info.attach('measurements.json', {
    path: measurementsPath,
    contentType: 'application/json',
  });
  expect(latencyFailures(result.receiptMs, domainMs)).toEqual([]);
  expect(framesPerSecond).toBeGreaterThan(49);
  expect(canvasMutations).toBeGreaterThan(0);
  expect(await page.getByTestId('timeline-row').count()).toBeLessThan(60);
  expect(errors).toEqual([]);
});

test('rejects a 500ms server commit stall and post-commit SSE delay', async ({
  page,
  performanceServer,
}, info) => {
  await performanceServer.open(5);
  await expect(page.getByTestId('performance-seq')).toHaveText('10000');
  performanceServer.injectDelay(500);
  const stopFrames = performanceServer.startFrames();
  await page.getByRole('button', { name: 'Run fixed benchmark' }).click();
  await expect(page.getByTestId('performance-result')).not.toHaveText('ready', { timeout: 15_000 });
  stopFrames();
  const result = JSON.parse(await page.getByTestId('performance-result').innerText()) as {
    receiptMs: number[];
    visible: { eventId: string; at: number }[];
    error?: string;
  };
  expect(result.error).toBeUndefined();
  expect(result.receiptMs).toHaveLength(5);
  const domainMs = result.visible.map(
    ({ eventId, at }) => at - (performanceServer.committed.get(eventId) ?? Infinity),
  );
  const evidence = info.outputPath('delay-detection.json');
  writeFileSync(
    evidence,
    JSON.stringify(
      {
        injectedServerDelayMs: 500,
        receiptMs: result.receiptMs,
        domainMs,
        failures: latencyFailures(result.receiptMs, domainMs),
      },
      null,
      2,
    ),
  );
  await info.attach('delay-detection.json', { path: evidence, contentType: 'application/json' });
  expect(domainMs).toHaveLength(5);
  expect(latencyFailures(result.receiptMs, domainMs)).toEqual([
    'receipt p95 exceeds 200ms',
    'committed event to UI p95 exceeds 300ms',
  ]);
  expect(performanceServer.persisted()).toEqual({ events: 10_005, commands: 6, executions: 101 });
});
