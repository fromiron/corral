// Read-only feasibility probe: keeps installed weights, varies only engine input budget.
import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import {
  builtHelperPath,
  bundledManifest,
  cpuThreads,
  LocalEmbeddingEngine,
  runtimeTarget,
  spawnHelper,
} from '../../../packages/local-intelligence/src/index.ts';

const [root, out] = process.argv.slice(2);
if (!root || !out) throw new Error('usage: probe-native.ts <installed-root> <report>');
const results = [];
for (const tokens of [256, 512, 1024, 2048]) {
  const bundle = bundledManifest();
  bundle.embedding.maxInputTokens = tokens;
  const engine = new LocalEmbeddingEngine({
    root,
    bundle,
    target: runtimeTarget(bundle, process.platform, process.arch),
    helperPath: builtHelperPath(),
    launch: spawnHelper,
    threads: cpuThreads(process.arch, availableParallelism()),
    device: 'cpu',
  });
  try {
    const input = (text: string) => ({
      texts: [text],
      task: 'classification' as const,
      overflow: 'truncate' as const,
      priority: 'effort' as const,
    });
    const warm = performance.now();
    await engine.embed(input('warm up'));
    const warmMs = performance.now() - warm;
    const values = [];
    const vectors = [];
    for (let i = 0; i < 4; i++) {
      const text = `${'We discussed the upcoming neighborhood event. '.repeat(60)}\n${i % 2 ? 'Only Aram should answer.' : 'Only Boram should answer.'}\nCase ${i}`;
      const start = performance.now();
      const [v] = await engine.embed(input(text));
      values.push(performance.now() - start);
      vectors.push(v!);
    }
    let diff = 0;
    for (let i = 0; i < vectors[0]!.length; i++)
      diff += Math.abs(vectors[0]![i]! - vectors[1]![i]!);
    results.push({
      tokens,
      ok: true,
      warmMs,
      inferenceMs: values,
      suffixVectorL1: diff,
      dims: vectors[0]!.length,
      device: engine.status().actualDevice,
    });
  } catch (e) {
    results.push({ tokens, ok: false, error: e instanceof Error ? e.message : 'probe failed' });
  } finally {
    await engine.close();
  }
  writeFileSync(out, JSON.stringify(results, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(results.at(-1)));
}
