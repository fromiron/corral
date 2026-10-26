import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// S8: the SDK session works with the worker's stripped environment (no
// HOME), loading a TypeScript extension through jiti. CORRAL_SPIKE_NODE can name another Node
// binary, e.g. the desktop's bundled 24.19, for a manual run.

const node = process.env.CORRAL_SPIKE_NODE ?? process.execPath;

describe('S8: worker environment', () => {
  it.skipIf(!existsSync(node))('runs without HOME and loads a TS extension', () => {
    const out = execFileSync(node, [join(import.meta.dirname, 'worker-env.run.ts')], {
      cwd: join(import.meta.dirname, '../..'),
      env: { NODE_ENV: 'production', PATH: process.env.PATH ?? '' },
      encoding: 'utf8',
      timeout: 60_000,
    });
    const result = JSON.parse(out.trim().split('\n').at(-1) as string);
    expect(result).toMatchObject({
      home: null,
      errors: [],
      permits: 1,
      loaded: true,
      answer: 'Hello.',
    });
  });
});
