// Runs the real helper and model. Opt-in only: CORRAL_LOCAL_AI_LIVE=1 and CORRAL_LOCAL_AI_DIR
// set to a folder where `corral local-ai install` (or installBundle) has installed this release.
// Build the helper first: pnpm --filter @corral/local-intelligence build:helper
import { availableParallelism } from 'node:os';
import type { DecisionCancellation } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { bundledManifest } from '../src/bundle.ts';
import { LocalEmbeddingEngine } from '../src/engine/engine.ts';
import { builtHelperPath, type HelperLauncher, spawnHelper } from '../src/engine/helper.ts';
import { cpuThreads, runtimeTarget } from '../src/platform.ts';

const live = process.env.CORRAL_LOCAL_AI_LIVE === '1' && !!process.env.CORRAL_LOCAL_AI_DIR;

describe.skipIf(!live)('local embedding engine with the real model', () => {
  function engine() {
    let launches = 0;
    const launch: HelperLauncher = (command) => {
      launches++;
      return spawnHelper(command);
    };
    const bundle = bundledManifest();
    const instance = new LocalEmbeddingEngine({
      root: process.env.CORRAL_LOCAL_AI_DIR!,
      bundle,
      target: runtimeTarget(bundle, process.platform, process.arch),
      helperPath: builtHelperPath(),
      launch,
      threads: cpuThreads(process.arch, availableParallelism()),
    });
    return { instance, launches: () => launches };
  }

  const cosine = (a: Float32Array, b: Float32Array) =>
    a.reduce((sum, value, i) => sum + value * b[i]!, 0);

  it('loads once and embeds Korean, Japanese, English and code requests', async () => {
    const { instance, launches } = engine();
    try {
      expect(instance.status().state).toBe('idle');
      await instance.warmUp();
      const texts = [
        'request: 로그인 후 세션이 가끔 풀리는 원인을 찾아서 고쳐 줘.',
        'request: ログイン後にセッションが時々切れる原因を調べて直してください。',
        'request: Find out why the session sometimes drops after login and fix it.',
        'request: fix `TypeError: Cannot read properties of undefined` in src/list.tsx:42',
        'request: thanks!',
      ];
      const vectors: Float32Array[][] = [];
      for (const text of texts)
        vectors.push(
          await instance.embed({
            texts: [text],
            task: 'classification',
            overflow: 'truncate',
            priority: 'effort',
          }),
        );
      expect(launches()).toBe(1);
      for (const [vector] of vectors) {
        expect(vector).toHaveLength(768);
        expect(Math.hypot(...vector!)).toBeCloseTo(1, 3);
      }
      const [ko, ja, en, , thanks] = vectors.map(([vector]) => vector!);
      // The same request in three languages lands closer together than an unrelated one.
      expect(cosine(ko!, en!)).toBeGreaterThan(cosine(ko!, thanks!));
      expect(cosine(ja!, en!)).toBeGreaterThan(cosine(ja!, thanks!));
      const long = await instance.embed({
        texts: ['long meeting answer '.repeat(400)],
        task: 'clustering',
        overflow: 'chunk_average',
        priority: 'meeting',
      });
      expect(long[0]).toHaveLength(768);
      expect(instance.status()).toMatchObject({ state: 'ready', actualDevice: 'cpu' });
    } finally {
      await instance.close();
    }
  }, 60_000);

  it('drops a cancelled caller and stops the helper on close', async () => {
    const { instance } = engine();
    await instance.warmUp();
    let cancel = () => {};
    const signal: DecisionCancellation = {
      aborted: false,
      onCancel(fn) {
        cancel = fn;
        return () => {};
      },
    };
    const slow = instance.embed(
      {
        texts: ['x '.repeat(3000)],
        task: 'clustering',
        overflow: 'chunk_average',
        priority: 'meeting',
      },
      signal,
    );
    cancel();
    await expect(slow).rejects.toThrow(/cancelled/);
    const next = await instance.embed({
      texts: ['request: run the tests'],
      task: 'classification',
      overflow: 'truncate',
      priority: 'effort',
    });
    expect(next[0]).toHaveLength(768);
    const started = performance.now();
    await instance.close();
    expect(performance.now() - started).toBeLessThan(5_000);
    await expect(
      instance.embed({
        texts: ['x'],
        task: 'classification',
        overflow: 'truncate',
        priority: 'effort',
      }),
    ).rejects.toThrow(/closed/);
  }, 60_000);
});
