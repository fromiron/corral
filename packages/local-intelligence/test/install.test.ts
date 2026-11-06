import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundledManifest, validBundle } from '../src/bundle.ts';
import { bundleDir, installBundle, installState } from '../src/install.ts';
import {
  EFFORT_MODEL,
  EXTRA,
  fakeFetch,
  LIBRARY,
  MODEL,
  makeZip,
  servedBodies,
  sha256,
  tempDir,
  testBundle,
  WHEEL,
} from './helpers.ts';

const target = 'linux-x64';

describe('local AI bundle install', () => {
  it('installs both models and the library extracted from the wheel, then stamps the release', async () => {
    const root = tempDir();
    const bundle = testBundle();
    const { fetchFn } = fakeFetch(servedBodies(bundle));
    const progress: string[] = [];
    expect(installState(root, target, bundle)).toBe('missing');

    const dir = await installBundle(root, {
      bundle,
      target,
      fetchFn,
      onProgress: ({ file, received, total }) => {
        if (received === total) progress.push(file);
      },
    });

    expect(dir).toBe(bundleDir(root, bundle));
    expect(readFileSync(join(dir, 'model.litertlm'))).toEqual(MODEL);
    expect(readFileSync(join(dir, 'effort.litertlm'))).toEqual(EFFORT_MODEL);
    expect(readFileSync(join(dir, 'libfake.so'))).toEqual(LIBRARY);
    expect(readFileSync(join(dir, 'extra.so'))).toEqual(EXTRA);
    expect(installState(root, target, bundle)).toBe('current');
    expect(progress).toEqual(['model.litertlm', 'effort.litertlm', 'runtime']);
    // Only installed files and the stamp remain; the wheel and partial files are gone.
    expect(readdirSync(dir).sort()).toEqual([
      'effort.litertlm',
      'extra.so',
      'install.json',
      'libfake.so',
      'model.litertlm',
    ]);
  });

  it('keeps files that already match and downloads nothing for them', async () => {
    const root = tempDir();
    const bundle = testBundle();
    await installBundle(root, { bundle, target, fetchFn: fakeFetch(servedBodies(bundle)).fetchFn });
    const again = fakeFetch(servedBodies(bundle));
    await installBundle(root, { bundle, target, fetchFn: again.fetchFn });
    expect(again.requested).toEqual([]);
  });

  it('refuses a download whose sha256 differs and leaves no stamp or partial file', async () => {
    const root = tempDir();
    const bundle = testBundle();
    const bodies = {
      ...servedBodies(bundle),
      [bundle.models.meeting.url]: Buffer.from(MODEL).fill(1, 0, 1),
    };
    await expect(
      installBundle(root, { bundle, target, fetchFn: fakeFetch(bodies).fetchFn }),
    ).rejects.toThrow(/sha256/);
    const dir = bundleDir(root, bundle);
    expect(installState(root, target, bundle)).toBe('missing');
    expect(readdirSync(dir).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('refuses an effort model whose sha256 differs, naming that file', async () => {
    const root = tempDir();
    const bundle = testBundle();
    const bodies = {
      ...servedBodies(bundle),
      [bundle.models.effort.url]: Buffer.from(EFFORT_MODEL).fill(1, 0, 1),
    };
    await expect(
      installBundle(root, { bundle, target, fetchFn: fakeFetch(bodies).fetchFn }),
    ).rejects.toThrow(/effort\.litertlm.*sha256/);
    expect(installState(root, target, bundle)).toBe('missing');
    expect(existsSync(join(bundleDir(root, bundle), 'effort.litertlm'))).toBe(false);
  });

  it('refuses a body that is longer or shorter than the pinned size', async () => {
    const bundle = testBundle();
    const longer = {
      ...servedBodies(bundle),
      [bundle.models.meeting.url]: Buffer.concat([MODEL, MODEL]),
    };
    await expect(
      installBundle(tempDir(), { bundle, target, fetchFn: fakeFetch(longer).fetchFn }),
    ).rejects.toThrow(/larger than/);
    const shorter = { ...servedBodies(bundle), [bundle.models.meeting.url]: MODEL.subarray(1) };
    await expect(
      installBundle(tempDir(), { bundle, target, fetchFn: fakeFetch(shorter).fetchFn }),
    ).rejects.toThrow(/of \d+ bytes/);
  });

  it('refuses a wheel member whose sha256 differs from the pin', async () => {
    const bundle = testBundle();
    const tampered = makeZip([
      { name: 'litert_lm/libfake.so', data: Buffer.from(LIBRARY).fill(0, 0, 1) },
      { name: 'litert_lm/extra.so', data: EXTRA },
    ]);
    const pinned = testBundle({
      runtime: {
        ...bundle.runtime,
        targets: {
          [target]: {
            ...bundle.runtime.targets[target]!,
            size: tampered.length,
            sha256: sha256(tampered),
          },
        },
      },
    });
    const bodies = {
      [pinned.models.meeting.url]: MODEL,
      [pinned.models.effort.url]: EFFORT_MODEL,
      [pinned.runtime.targets[target]!.url]: tampered,
    };
    const root = tempDir();
    await expect(
      installBundle(root, { bundle: pinned, target, fetchFn: fakeFetch(bodies).fetchFn }),
    ).rejects.toThrow(/libfake\.so.*sha256/);
    expect(installState(root, target, pinned)).toBe('missing');
    expect(existsSync(join(bundleDir(root, pinned), 'libfake.so'))).toBe(false);
  });

  it('stops on abort without a stamp or partial files', async () => {
    const root = tempDir();
    const bundle = testBundle();
    const controller = new AbortController();
    const { fetchFn } = fakeFetch(servedBodies(bundle), { chunk: 3 });
    const install = installBundle(root, {
      bundle,
      target,
      fetchFn,
      signal: controller.signal,
      onProgress: ({ received }) => {
        if (received > 30) controller.abort();
      },
    });
    await expect(install).rejects.toThrow(/abort/i);
    const dir = bundleDir(root, bundle);
    expect(installState(root, target, bundle)).toBe('missing');
    expect(readdirSync(dir).filter((name) => name.endsWith('.part'))).toEqual([]);
  });

  it('reports another installed release as stale and an unknown target as unsupported', async () => {
    const root = tempDir();
    const older = testBundle({ release: 'test-release-0' });
    await installBundle(root, {
      bundle: older,
      target,
      fetchFn: fakeFetch(servedBodies(older)).fetchFn,
    });
    expect(installState(root, target, testBundle())).toBe('stale');
    expect(installState(root, null, testBundle())).toBe('unsupported');
    await expect(
      installBundle(root, {
        bundle: testBundle(),
        target: 'darwin-x64',
        fetchFn: fakeFetch({}).fetchFn,
      }),
    ).rejects.toThrow(/darwin-x64/);
  });

  it('treats a stamp for another target as not installed', () => {
    const root = tempDir();
    const bundle = testBundle();
    const dir = bundleDir(root, bundle);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'install.json'),
      JSON.stringify({ release: bundle.release, target: 'win32-x64' }),
    );
    expect(installState(root, target, bundle)).toBe('missing');
  });

  it('rejects manifests that could escape the folder or skip a check', () => {
    const bundle = testBundle();
    const { meeting, effort } = bundle.models;
    expect(() =>
      validBundle({ ...bundle, models: { meeting: { ...meeting, file: '../model' }, effort } }),
    ).toThrow();
    expect(() =>
      validBundle({ ...bundle, models: { meeting, effort: { ...effort, url: 'http://x/model' } } }),
    ).toThrow();
    // Both models in one file, or a model without its own size limits, could skip a check.
    expect(() =>
      validBundle({ ...bundle, models: { meeting, effort: { ...effort, file: meeting.file } } }),
    ).toThrow();
    expect(() =>
      validBundle({ ...bundle, models: { meeting, effort: { ...effort, maxInputTokens: 0 } } }),
    ).toThrow();
    expect(() => validBundle({ ...bundle, models: { meeting } } as never)).toThrow();
    expect(() => validBundle({ ...bundle, release: 'a/b' })).toThrow();
    const runtime = bundle.runtime.targets[target]!;
    expect(() =>
      validBundle({
        ...bundle,
        runtime: {
          ...bundle.runtime,
          targets: { [target]: { ...runtime, library: 'missing.so' } },
        },
      }),
    ).toThrow();
    expect(() =>
      validBundle({
        ...bundle,
        runtime: {
          ...bundle.runtime,
          targets: {
            [target]: { ...runtime, files: { 'effort.litertlm': runtime.files['libfake.so']! } },
          },
        },
      }),
    ).toThrow();
  });

  it('ships a valid bundle for the supported desktop targets', () => {
    const bundle = bundledManifest();
    expect(Object.keys(bundle.runtime.targets).sort()).toEqual([
      'darwin-arm64',
      'linux-arm64',
      'linux-x64',
      'win32-x64',
    ]);
    expect(bundle.models.meeting).toMatchObject({ dims: 768, maxInputTokens: 256 });
    expect(bundle.models.effort).toMatchObject({ dims: 768, maxInputTokens: 1024 });
    expect(WHEEL.length).toBeGreaterThan(0);
  });
});
