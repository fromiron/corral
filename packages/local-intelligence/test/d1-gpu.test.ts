import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { D1Engine } from '../src/d1/engine.ts';
import { d1Installed, installD1 } from '../src/d1/install.ts';
import { type D1Manifest, LINUX_X64_CPU, manifestProblem } from '../src/d1/manifest.ts';
import { D1Runtime, gpuDeviceNames, serverArgs } from '../src/d1/runtime.ts';
import {
  fakeLauncher,
  goodVersion,
  MODEL_BYTES,
  releaseArchive,
  removeTempRoots,
  servingFetch,
  sha,
  tempRoot,
  testManifest,
} from './d1-helpers.ts';

// features/effort-routing.md — Linux x64 Vulkan and CUDA 12.8 runtimes.

const VULKAN_URL =
  'https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-ubuntu-vulkan-x64.tar.gz';
const CUDA_URL =
  'https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-ubuntu-cuda-12.8-x64.tar.gz';

afterEach(removeTempRoots);

function withVulkan(archive: Buffer, manifest = testManifest()): D1Manifest {
  const runtime = {
    ...manifest.runtime,
    device: 'vulkan' as const,
    url: 'https://runtime.test/vulkan.tar.gz',
    size: archive.length,
    sha256: sha(archive),
    requirement: 'libvulkan.so.1',
  };
  return { ...manifest, runtimes: { vulkan: runtime } };
}

describe('pinned GPU runtimes', () => {
  it('pins the official Linux x64 Vulkan and CUDA 12.8 archives and no CUDA 13 build', () => {
    expect(manifestProblem(LINUX_X64_CPU)).toBeNull();
    expect(LINUX_X64_CPU.runtimes?.vulkan).toMatchObject({
      url: VULKAN_URL,
      size: 35_871_731,
      sha256: 'f59bca3239bde0bd2280fde0b538f2abd9e80abc8ccce6c740bb17e630cd6269',
      license: 'MIT',
      build: 'b12189',
      commit: '80d2c0c2c56e4a1bbf74be98f64b99927bf230bc',
    });
    expect(LINUX_X64_CPU.runtimes?.vulkan?.requirement).toMatch(/libvulkan\.so\.1/);
    expect(LINUX_X64_CPU.runtimes?.cuda).toMatchObject({
      url: CUDA_URL,
      size: 188_173_082,
      sha256: '664f720005135f621960b8f1550979a1bdd73b8ba887e2a47a314b0154fcaa0a',
      license: 'MIT',
    });
    expect(LINUX_X64_CPU.runtimes?.cuda?.requirement).toMatch(/libcudart\.so\.12/);
    expect(LINUX_X64_CPU.runtimes?.cuda?.url).not.toContain('cuda-13');
    expect(Object.keys(LINUX_X64_CPU.runtimes ?? {})).not.toContain('rocm');
  });

  it('keeps the CPU offload flags and uses this build’s GPU flags', () => {
    const cpu = serverArgs('/model.gguf', 9, 4);
    expect(cpu[cpu.indexOf('--n-gpu-layers') + 1]).toBe('0');
    expect(cpu[cpu.indexOf('--device') + 1]).toBe('none');
    expect(cpu).toContain('--no-op-offload');

    const vulkan = serverArgs('/model.gguf', 9, 4, { kind: 'vulkan', devices: ['Vulkan0'] });
    expect(vulkan[vulkan.indexOf('--n-gpu-layers') + 1]).toBe('all');
    expect(vulkan[vulkan.indexOf('--device') + 1]).toBe('Vulkan0');
    expect(vulkan[vulkan.indexOf('--fit') + 1]).toBe('off');
    expect(vulkan).toContain('--op-offload');
    expect(vulkan).not.toContain('--no-op-offload');
    expect(vulkan).not.toContain('none');
    expect(vulkan[vulkan.indexOf('--model') + 1]).toBe('/model.gguf');
  });

  it('reads only the device names this build prints', () => {
    const listed = [
      'Available devices:',
      '  Vulkan0: NVIDIA GeForce RTX 3070 (8192 MiB, 3735 MiB free)',
      '',
    ].join('\n');
    expect(gpuDeviceNames('vulkan', listed)).toEqual(['Vulkan0']);
    expect(gpuDeviceNames('cuda', 'Available devices:\n  (none)\n')).toEqual([]);
    expect(
      gpuDeviceNames(
        'cuda',
        'Available devices:\n  CUDA0: NVIDIA GeForce RTX 3070 (8192 MiB, 100 MiB free)\n  Vulkan0: other\n',
      ),
    ).toEqual(['CUDA0']);
  });
});

describe('installing one device runtime', () => {
  it('downloads only the Vulkan archive once the model is already installed', async () => {
    const cpuArchive = releaseArchive();
    const vulkanArchive = releaseArchive();
    const cpu = testManifest();
    const manifest = withVulkan(vulkanArchive, {
      ...cpu,
      runtime: { ...cpu.runtime, size: cpuArchive.length, sha256: sha(cpuArchive) },
    });
    const root = tempRoot();
    const cpuFetch = servingFetch({
      [manifest.model.url]: MODEL_BYTES,
      [manifest.runtime.url]: cpuArchive,
      [manifest.runtimes!.vulkan!.url]: vulkanArchive,
    });
    await installD1(root, { manifest, fetchFn: cpuFetch.fetchFn, probe: goodVersion });
    expect(d1Installed(root, manifest, 'cpu')).toBe(true);
    cpuFetch.asked.length = 0;
    const progress: { received: number; total: number }[] = [];
    await installD1(root, {
      manifest,
      device: 'vulkan',
      fetchFn: cpuFetch.fetchFn,
      probe: goodVersion,
      onProgress: (update) => progress.push({ received: update.received, total: update.total }),
    });
    expect(cpuFetch.asked).toEqual([manifest.runtimes!.vulkan!.url]);
    expect(progress.some((update) => update.total === vulkanArchive.length)).toBe(true);
    expect(progress.every((update) => update.total === vulkanArchive.length)).toBe(true);
    expect(d1Installed(root, manifest, 'vulkan')).toBe(true);
    expect(d1Installed(root, manifest, 'cpu')).toBe(true);
    expect(readFileSync(join(root, manifest.id, 'vulkan', 'llama-server'))).toBeTruthy();
    expect(d1Installed(root, manifest, 'cuda')).toBe(false);
  });
});

describe('a GPU start that finds no device', () => {
  it('does not launch llama-server and leaves the runtime in error', async () => {
    const archive = releaseArchive();
    const manifest = withVulkan(archive, {
      ...testManifest(),
      runtime: { ...testManifest().runtime, size: archive.length, sha256: sha(archive) },
    });
    const root = tempRoot();
    const { fetchFn } = servingFetch({
      [manifest.model.url]: MODEL_BYTES,
      [manifest.runtimes!.vulkan!.url]: archive,
    });
    await installD1(root, { manifest, device: 'vulkan', fetchFn, probe: goodVersion });
    const launches: string[][] = [];
    const runtime = new D1Runtime({
      dir: join(root, manifest.id),
      manifest,
      launch: (command) => {
        launches.push(command.args);
        return {
          alive: false,
          exited: Promise.resolve(),
          signal() {},
        };
      },
      listDevices: async () => 'Available devices:\n  (none)\n',
    });
    await runtime.prepare(2, 'vulkan');
    expect(runtime.state).toBe('error');
    expect(runtime.error).toMatch(/Vulkan runtime found no device/);
    expect(launches).toEqual([]);
  });

  it('records the listed device and does not fall back to the CPU runtime', async () => {
    const archive = releaseArchive();
    const manifest = withVulkan(archive, {
      ...testManifest(),
      runtime: { ...testManifest().runtime, size: archive.length, sha256: sha(archive) },
    });
    const root = tempRoot();
    const { fetchFn } = servingFetch({
      [manifest.model.url]: MODEL_BYTES,
      [manifest.runtime.url]: archive,
      [manifest.runtimes!.vulkan!.url]: archive,
    });
    await installD1(root, {
      manifest,
      fetchFn,
      probe: goodVersion,
    });
    await installD1(root, { manifest, device: 'vulkan', fetchFn, probe: goodVersion });
    const launches: string[][] = [];
    const engine = new D1Engine({
      root,
      manifest,
      launch: (command) => {
        launches.push(command.args);
        return { alive: true, exited: new Promise(() => {}), signal() {} };
      },
      listDevices: async () => 'Available devices:\n  (none)\n',
      limits: { startupMs: 200, pollMs: 20 },
    });
    engine.prepare(2, 'vulkan');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(engine.status()).toMatchObject({
      runtime: 'error',
      device: { requested: 'vulkan', active: null },
    });
    expect(engine.status().error).toMatch(/Vulkan/);
    expect(launches).toEqual([]);
    const admission = engine
      .backend({ kind: 'local', device: { kind: 'vulkan', threads: 2 }, callerTimeoutMs: 5000 })
      .admit();
    expect(admission).toEqual({ ok: false, reason: 'unavailable' });
    expect(launches).toEqual([]);
    await engine.close();
  });

  it('reports the device name the build listed once that runtime is ready', async () => {
    const manifest = withVulkan(releaseArchive());
    const root = tempRoot();
    mkdirSync(join(root, manifest.id, 'vulkan'), { recursive: true });
    const fake = fakeLauncher();
    const runtime = new D1Runtime({
      dir: join(root, manifest.id),
      manifest,
      launch: fake.launch,
      limits: { startupMs: 5000, pollMs: 20 },
      listDevices: async () =>
        'Available devices:\n  Vulkan0: NVIDIA GeForce RTX 3070 (8192 MiB, 3735 MiB free)\n',
    });
    await runtime.prepare(3, 'vulkan');
    expect(runtime.state).toBe('ready');
    expect(runtime.ready(3, 'vulkan')?.actualDevice).toBe('Vulkan0');
    expect(fake.commands[0]?.args).toEqual(
      expect.arrayContaining([
        '--n-gpu-layers',
        'all',
        '--device',
        'Vulkan0',
        '--fit',
        'off',
        '--op-offload',
      ]),
    );
    expect(fake.commands[0]?.args).not.toContain('--no-op-offload');
    await runtime.stop();
  });
});
