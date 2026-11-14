import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { D1Engine } from '../src/d1/engine.ts';
import { d1Installed, installD1 } from '../src/d1/install.ts';
import { type D1Manifest, LINUX_X64_CPU, manifestProblem } from '../src/d1/manifest.ts';
import { installState } from '../src/install.ts';
import {
  goodVersion,
  installFake,
  LIB_BYTES,
  MODEL_BYTES,
  releaseArchive,
  removeTempRoots,
  SERVER_BYTES,
  servingFetch,
  sha,
  tarGz,
  tempRoot,
  testManifest,
  until,
} from './d1-helpers.ts';

// features/effort-routing.md#local-엔진-설치

afterEach(removeTempRoots);

const withArchive = (archive: Buffer, manifest = testManifest()): D1Manifest => ({
  ...manifest,
  runtime: { ...manifest.runtime, size: archive.length, sha256: sha(archive) },
});
const filesOf = (manifest: D1Manifest, archive: Buffer) => ({
  [manifest.model.url]: MODEL_BYTES,
  [manifest.runtime.url]: archive,
});

describe('installing the Local engine', () => {
  it('takes only the pinned files from the archive, checks them, and stamps last', async () => {
    const root = tempRoot();
    const archive = releaseArchive();
    const manifest = withArchive(archive);
    const { fetchFn, asked } = servingFetch(filesOf(manifest, archive));
    const phases: string[] = [];
    const dir = await installD1(root, {
      manifest,
      fetchFn,
      probe: goodVersion,
      onProgress: (p) => {
        if (phases.at(-1) !== p.phase) phases.push(p.phase);
        expect(p.total).toBe(MODEL_BYTES.length + archive.length);
      },
    });
    expect(asked).toEqual([manifest.model.url, manifest.runtime.url]);
    expect(phases).toEqual(['downloading', 'verifying']);
    expect(readFileSync(join(dir, 'llama-server'))).toEqual(SERVER_BYTES);
    expect(readFileSync(join(dir, 'libggml.so'))).toEqual(LIB_BYTES);
    expect(statSync(join(dir, 'llama-server')).mode & 0o100).toBeTruthy();
    // Nothing unpinned, no link, no partial file.
    expect(readdirSync(dir).sort()).toEqual(
      ['d1-2B-Q4_K_M.gguf', 'install.json', 'libggml.so', 'llama-server'].sort(),
    );
    expect(d1Installed(root, manifest)).toBe(true);
  });

  it('reads a completion stamp without a device list as not installed', () => {
    const root = tempRoot();
    const manifest = testManifest();
    const dir = installFake(root, manifest);
    expect(d1Installed(root, manifest)).toBe(true);
    writeFileSync(join(dir, 'install.json'), JSON.stringify({ id: manifest.id }));
    expect(d1Installed(root, manifest)).toBe(false);
  });

  it('refuses an archive with a path outside its folder, an absolute path, or a pinned link', async () => {
    const cases = [
      releaseArchive([{ name: 'llama-b12189/../../evil', data: Buffer.from('x') }]),
      releaseArchive([{ name: '/etc/evil', data: Buffer.from('x') }]),
      tarGz([
        { name: 'llama-b12189/llama-server', type: '2', linkname: '/bin/sh' },
        { name: 'llama-b12189/libggml.so', data: LIB_BYTES },
      ]),
    ];
    for (const archive of cases) {
      const root = tempRoot();
      const manifest = withArchive(archive);
      const { fetchFn } = servingFetch(filesOf(manifest, archive));
      await expect(installD1(root, { manifest, fetchFn, probe: goodVersion })).rejects.toThrow(
        /unsafe path|not a regular file/,
      );
      expect(d1Installed(root, manifest)).toBe(false);
      expect(existsSync(join(root, 'evil'))).toBe(false);
      expect(readdirSync(join(root, manifest.id)).filter((n) => n.endsWith('.part'))).toEqual([]);
    }
  });

  it('reads a member stored under a GNU long name', async () => {
    const long = `llama-b12189/${'d'.repeat(120)}/llama-server`;
    const archive = tarGz([
      { name: long, data: SERVER_BYTES },
      { name: 'llama-b12189/libggml.so', data: LIB_BYTES },
    ]);
    const base = testManifest();
    const manifest = withArchive(archive, {
      ...base,
      runtime: {
        ...base.runtime,
        files: {
          ...base.runtime.files,
          'llama-server': { ...base.runtime.files['llama-server']!, member: long },
        },
      },
    });
    const { fetchFn } = servingFetch(filesOf(manifest, archive));
    const dir = await installD1(tempRoot(), { manifest, fetchFn, probe: goodVersion });
    expect(readFileSync(join(dir, 'llama-server'))).toEqual(SERVER_BYTES);
  });

  it('activates nothing when a size or hash differs', async () => {
    const archive = releaseArchive();
    const manifest = withArchive(archive);
    const tampered = {
      ...filesOf(manifest, archive),
      [manifest.model.url]: Buffer.from('tampered weights !!!!'),
    };
    const root = tempRoot();
    await expect(
      installD1(root, { manifest, fetchFn: servingFetch(tampered).fetchFn, probe: goodVersion }),
    ).rejects.toThrow(/model/);
    expect(d1Installed(root, manifest)).toBe(false);
    expect(readdirSync(join(root, manifest.id))).toEqual([]);

    const wrongMember = {
      ...manifest,
      runtime: {
        ...manifest.runtime,
        files: {
          ...manifest.runtime.files,
          'libggml.so': { ...manifest.runtime.files['libggml.so']!, sha256: '1'.repeat(64) },
        },
      },
    };
    const again = tempRoot();
    await expect(
      installD1(again, {
        manifest: wrongMember,
        fetchFn: servingFetch(filesOf(manifest, archive)).fetchFn,
        probe: goodVersion,
      }),
    ).rejects.toThrow(/libggml\.so: sha256 mismatch/);
    expect(d1Installed(again, wrongMember)).toBe(false);
  });

  it('refuses a server that is not the pinned build', async () => {
    const archive = releaseArchive();
    const manifest = withArchive(archive);
    const root = tempRoot();
    await expect(
      installD1(root, {
        manifest,
        fetchFn: servingFetch(filesOf(manifest, archive)).fetchFn,
        probe: async () => 'version: 1 (build 12190, commit 80d2c0c2c)',
      }),
    ).rejects.toThrow(/not llama\.cpp b12189/);
    expect(d1Installed(root, manifest)).toBe(false);
  });

  it('checks the free space before downloading anything', async () => {
    const archive = releaseArchive();
    const manifest = withArchive(archive);
    const { fetchFn, asked } = servingFetch(filesOf(manifest, archive));
    await expect(
      installD1(tempRoot(), { manifest, fetchFn, probe: goodVersion, freeBytes: async () => 10 }),
    ).rejects.toThrow('not enough disk space for the Local model');
    expect(asked).toEqual([]);
  });

  it('refuses an incomplete manifest before downloading', async () => {
    // The shipped manifest stays refused until its archive files are recorded.
    const incomplete = { ...testManifest(), runtime: { ...testManifest().runtime, files: {} } };
    expect(manifestProblem(incomplete)).toMatch(/incomplete/);
    const { fetchFn, asked } = servingFetch({});
    await expect(installD1(tempRoot(), { manifest: incomplete, fetchFn })).rejects.toThrow(
      /incomplete/,
    );
    expect(asked).toEqual([]);
    const complete = withArchive(releaseArchive());
    expect(manifestProblem(complete)).toBeNull();
    const { device: _device, ...noDevice } = complete.runtime;
    expect(manifestProblem({ ...complete, runtime: noDevice as D1Manifest['runtime'] })).toMatch(
      /incomplete/,
    );
    const { requirement: _requirement, ...noRequirement } = complete.runtime;
    expect(
      manifestProblem({ ...complete, runtime: noRequirement as D1Manifest['runtime'] }),
    ).toMatch(/incomplete/);
    expect(
      manifestProblem({
        ...complete,
        renderer: { ...LINUX_X64_CPU.renderer, sha256: '2'.repeat(64) },
      }),
    ).toMatch(/another renderer/);
  });

  it('a cancel stops the download and leaves no partial file', async () => {
    const archive = releaseArchive();
    const manifest = withArchive(archive);
    const root = tempRoot();
    const engine = new D1Engine({
      root,
      manifest,
      fetchFn: servingFetch(filesOf(manifest, archive), { hold: manifest.model.url }).fetchFn,
      probe: goodVersion,
    });
    expect(engine.install()).toMatchObject({
      install: 'downloading',
      downloadBytes: MODEL_BYTES.length + archive.length,
    });
    await until(() => (engine.status().progress?.received ?? 0) > 0);
    const after = await engine.cancelInstall();
    expect(after).toMatchObject({ install: 'absent', error: null, progress: null });
    expect(readdirSync(join(root, manifest.id))).toEqual([]);
  });

  it('reports a filesystem failure by its code, never the folder', async () => {
    const archive = releaseArchive();
    const manifest = withArchive(archive);
    const root = tempRoot();
    chmodSync(root, 0o500);
    try {
      const engine = new D1Engine({
        root,
        manifest,
        fetchFn: servingFetch(filesOf(manifest, archive)).fetchFn,
        probe: goodVersion,
      });
      engine.install();
      await until(() => engine.status().install !== 'downloading');
      const status = engine.status();
      expect(status.install).toBe('install-error');
      expect(status.error).toMatch(/^cannot write the Local model files \(E[A-Z]+\)$/);
      expect(JSON.stringify(status)).not.toContain(root);
    } finally {
      chmodSync(root, 0o700);
    }
  });

  it('installs apart from the meeting bundle', async () => {
    const root = tempRoot();
    const archive = releaseArchive();
    const manifest = withArchive(archive);
    await installD1(join(root, 'd1'), {
      manifest,
      fetchFn: servingFetch(filesOf(manifest, archive)).fetchFn,
      probe: goodVersion,
    });
    // The meeting bundle's folder reads the same as before.
    expect(installState(root, 'linux-x64')).toBe('missing');
  });
});
