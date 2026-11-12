// The Local effort routing engine Corral installs and runs (features/effort-routing.md#local-엔진-고정-artifact):
// stock LiquidAI d1-2B Q4_K_M and the official llama.cpp server build for one target, each pinned
// by size and sha256, with the files taken from the archive and the renderer identity. A manifest
// missing any value is refused; a different runtime build is a different manifest.
import { RENDERER_VERSION, rendererHash } from './render.ts';

export interface PinnedDownload {
  url: string;
  size: number;
  sha256: string;
}

/** A llama-server build the Local engine can install. */
export type D1Device = 'cpu' | 'vulkan' | 'cuda';

export interface D1RuntimePin extends PinnedDownload {
  build: string;
  commit: string;
  license: string;
  /** The installed name of the server executable; one of `files`. */
  server: string;
  /** Files taken from the archive, keyed by their installed name. */
  files: Record<string, { member: string; size: number; sha256: string }>;
  /** Absent on the CPU runtime of a manifest written before device runtimes. */
  device?: D1Device;
  /** Libraries the computer must already have. Null or absent for CPU. */
  requirement?: string | null;
}

export interface D1Manifest {
  schemaVersion: 1;
  /** The install folder and the engine identity's prefix. */
  id: string;
  name: string;
  target: string;
  model: PinnedDownload & {
    repository: string;
    revision: string;
    file: string;
    /** What the server reports for the loaded model, to tie a child to this artifact. */
    tensorBytes: number;
    params: number;
    license: string;
  };
  /** The CPU llama-server build. */
  runtime: D1RuntimePin;
  /** GPU builds for this target. A device with no entry cannot be selected. */
  runtimes?: Partial<Record<Exclude<D1Device, 'cpu'>, D1RuntimePin>>;
  renderer: { version: string; sha256: string };
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const SAFE_MEMBER = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/+-]+$/;

const size = (value: unknown) => Number.isSafeInteger(value) && (value as number) > 0;
const pinned = (file: PinnedDownload | undefined) =>
  !!file && /^https:\/\//.test(file.url ?? '') && size(file.size) && SHA256.test(file.sha256 ?? '');
const text = (value: unknown) => typeof value === 'string' && value.length > 0;

function runtimeOk(
  runtime: D1RuntimePin | undefined,
  device: D1Device,
  modelFile: string,
): boolean {
  const files = Object.entries(runtime?.files ?? {});
  return (
    pinned(runtime) &&
    text(runtime?.build) &&
    COMMIT.test(runtime?.commit ?? '') &&
    text(runtime?.license) &&
    (runtime?.device === undefined || runtime.device === device) &&
    (device === 'cpu' ||
      (typeof runtime?.requirement === 'string' && runtime.requirement.length > 0)) &&
    files.length > 0 &&
    Object.hasOwn(runtime?.files ?? {}, runtime?.server ?? '') &&
    files.every(
      ([name, file]) =>
        SAFE_NAME.test(name) &&
        name !== modelFile &&
        SAFE_MEMBER.test(file.member ?? '') &&
        size(file.size) &&
        SHA256.test(file.sha256 ?? ''),
    )
  );
}

/** The runtime for one device, or null when this manifest does not ship it. */
export function d1Runtime(manifest: D1Manifest, device: D1Device): D1RuntimePin | null {
  if (device === 'cpu') return manifest.runtime ?? null;
  return manifest.runtimes?.[device] ?? null;
}

/** Devices this manifest can install, CPU first. */
export function d1Devices(manifest: D1Manifest): D1Device[] {
  const devices: D1Device[] = [];
  if (manifest.runtime) devices.push('cpu');
  if (manifest.runtimes?.vulkan) devices.push('vulkan');
  if (manifest.runtimes?.cuda) devices.push('cuda');
  return devices;
}

/** Why a manifest cannot be installed or run, or null when it is complete. */
export function manifestProblem(manifest: D1Manifest): string | null {
  const { model, runtime, renderer } = manifest;
  const gpu = Object.entries(manifest.runtimes ?? {}) as [Exclude<D1Device, 'cpu'>, D1RuntimePin][];
  const valid =
    manifest.schemaVersion === 1 &&
    SAFE_NAME.test(manifest.id ?? '') &&
    text(manifest.name) &&
    text(manifest.target) &&
    pinned(model) &&
    text(model.repository) &&
    COMMIT.test(model.revision ?? '') &&
    SAFE_NAME.test(model.file ?? '') &&
    size(model.tensorBytes) &&
    size(model.params) &&
    text(model.license) &&
    runtimeOk(runtime, 'cpu', model?.file ?? '') &&
    gpu.every(
      ([device, entry]) =>
        (device === 'vulkan' || device === 'cuda') && runtimeOk(entry, device, model?.file ?? ''),
    ) &&
    renderer?.version === RENDERER_VERSION &&
    SHA256.test(renderer.sha256 ?? '');
  if (!valid) return 'the Local model manifest is incomplete';
  if (renderer.sha256 !== rendererHash()) return 'the Local model manifest is for another renderer';
  return null;
}

const MODEL_REVISION = '4a181094d1b6addfaa3a0956f78e7ab2aa406a0c';

/** The engine this build ships for Linux x64 CPU. */
export const LINUX_X64_CPU: D1Manifest = {
  schemaVersion: 1,
  id: 'd1-2b-q4km-llama-b12189-linux-x64-cpu',
  name: 'd1-2B Q4_K_M',
  target: 'linux-x64',
  model: {
    repository: 'LiquidAI/d1-2B-GGUF',
    revision: MODEL_REVISION,
    file: 'd1-2B-Q4_K_M.gguf',
    url: `https://huggingface.co/LiquidAI/d1-2B-GGUF/resolve/${MODEL_REVISION}/d1-2B-Q4_K_M.gguf`,
    size: 1_099_629_888,
    sha256: 'adca5789ad30ae6027e8e936749bb9f19673097492ab26fa1c5b69643ca50b4b',
    tensorBytes: 1_091_380_480,
    params: 1_728_801_600,
    license: 'LFM-Open-License-v1.0',
  },
  runtime: {
    build: 'b12189',
    commit: '80d2c0c2c56e4a1bbf74be98f64b99927bf230bc',
    url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-ubuntu-x64.tar.gz',
    size: 23_058_620,
    sha256: 'c446a7ba4df3c3b1cc880a734fbff586d6d34b9cebc09e151754813b94ded8c9',
    license: 'MIT',
    device: 'cpu',
    requirement: null,
    server: 'llama-server',
    // Taken from the official archive. Libraries are installed under the soname the loader asks
    // for (the archive links them), and every CPU backend variant is kept so the server can
    // pick the one this processor supports.
    files: {
      'llama-server': {
        member: 'llama-b12189/llama-server',
        size: 17_864,
        sha256: 'fb6aa86c4c070c364ff0c020408141222a1ec4f75427959ea8a34029869900d0',
      },
      'libllama-server-impl.so': {
        member: 'llama-b12189/libllama-server-impl.so',
        size: 8_296_232,
        sha256: '61ee293517b3779550775628e0d005ad7462a585f7791b8e33c47a085bdf915d',
      },
      'libllama-common.so.0': {
        member: 'llama-b12189/libllama-common.so.0.9.0',
        size: 6_774_568,
        sha256: '4dcc374697da18f8e02c5d97bf3f95b0cfc6b66cc0541714c43ce72f9a6d9cbc',
      },
      'libmtmd.so.0': {
        member: 'llama-b12189/libmtmd.so.0.9.0',
        size: 2_308_016,
        sha256: '50dceaf6a54559e75916e81d61075f3ff1abbbaa39f77b3428ecd9821f3bd478',
      },
      'libllama.so.0': {
        member: 'llama-b12189/libllama.so.0.9.0',
        size: 5_485_632,
        sha256: '96929401b91678a0fff0c61443a1c8ed2acae466a816c45e111c850318ac4d7b',
      },
      'libggml.so.0': {
        member: 'llama-b12189/libggml.so.0.29.0',
        size: 51_040,
        sha256: '8643a58bb37af6fb153e2ea98b48efa227855725ee51c05f4ca76b9867956463',
      },
      'libggml-base.so.0': {
        member: 'llama-b12189/libggml-base.so.0.29.0',
        size: 937_984,
        sha256: '523a24650bf64abbcf94d3be5918db429d372ddea9af6194515bf6843bcb6227',
      },
      'LICENSE-llama.cpp': {
        member: 'llama-b12189/LICENSE',
        size: 1_078,
        sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
      },
      'libggml-cpu-alderlake.so': {
        member: 'llama-b12189/libggml-cpu-alderlake.so',
        size: 1_438_176,
        sha256: '6b2e71b7db59f664f5428ee9aa4a59cbabc7b0f68aa43e1f2f071bfe56886372',
      },
      'libggml-cpu-cannonlake.so': {
        member: 'llama-b12189/libggml-cpu-cannonlake.so',
        size: 1_583_456,
        sha256: 'c4e143051063c954dd2ed293d3d42037b30373c3fb1466a93a969bbbbe9a1476',
      },
      'libggml-cpu-cascadelake.so': {
        member: 'llama-b12189/libggml-cpu-cascadelake.so',
        size: 1_599_544,
        sha256: 'eadb9ebc148386e79263bfc1225b14378ced42f0427c4ad45b8049a6e308b418',
      },
      'libggml-cpu-cooperlake.so': {
        member: 'llama-b12189/libggml-cpu-cooperlake.so',
        size: 1_599_616,
        sha256: '869b7be246074de644880f099a82f44449d1a69429638e26c13e6779196288d4',
      },
      'libggml-cpu-haswell.so': {
        member: 'llama-b12189/libggml-cpu-haswell.so',
        size: 1_438_176,
        sha256: 'd5c208430185a6d4f84d1be9757265f54c890d2ba58a867aa1c957047ac9f3b1',
      },
      'libggml-cpu-icelake.so': {
        member: 'llama-b12189/libggml-cpu-icelake.so',
        size: 1_599_544,
        sha256: '776a9e5bfef482824cf7a2fcb206fc086dca5bb46e555134f325e43dec8f326d',
      },
      'libggml-cpu-ivybridge.so': {
        member: 'llama-b12189/libggml-cpu-ivybridge.so',
        size: 1_373_792,
        sha256: '6fe4c273e5832563e411b5749be252c7226140cfa67a2eb454e30640109053a0',
      },
      'libggml-cpu-piledriver.so': {
        member: 'llama-b12189/libggml-cpu-piledriver.so',
        size: 1_369_696,
        sha256: '05f20153e4b02718ed91c8dbbc05ec810e203f7b7dde0775fa52b0363c25b858',
      },
      'libggml-cpu-sandybridge.so': {
        member: 'llama-b12189/libggml-cpu-sandybridge.so',
        size: 1_372_848,
        sha256: 'de51eb47a88eb6e77b17662722575b99e4b5ac48326b97026b57c68421c90a08',
      },
      'libggml-cpu-sapphirerapids.so': {
        member: 'llama-b12189/libggml-cpu-sapphirerapids.so',
        size: 1_865_944,
        sha256: 'c0c6769212a6a129304d1386187677baf81834f53beba85530f6f2c3ff1c3508',
      },
      'libggml-cpu-skylakex.so': {
        member: 'llama-b12189/libggml-cpu-skylakex.so',
        size: 1_583_456,
        sha256: '4a2139be8d9e084ec50220a1295c91f436cc84ed38758173e22b5dcf74d7d1de',
      },
      'libggml-cpu-sse42.so': {
        member: 'llama-b12189/libggml-cpu-sse42.so',
        size: 980_488,
        sha256: '4574298456cd2f28c68d1fdfd66b3016906c1395a694a334dffeb0a938c60474',
      },
      'libggml-cpu-x64.so': {
        member: 'llama-b12189/libggml-cpu-x64.so',
        size: 976_512,
        sha256: '6c9b84c38e4b6cbc22a8b4f7aff4ce0335c9f67caab8133d86144d59b2d96b1d',
      },
      'libggml-cpu-zen4.so': {
        member: 'llama-b12189/libggml-cpu-zen4.so',
        size: 1_599_616,
        sha256: 'e5af657a5b69f7c7b8c66c7466e166de995526b8df046237030b4971325156fa',
      },
    },
  },
  runtimes: {
    vulkan: {
      build: 'b12189',
      commit: '80d2c0c2c56e4a1bbf74be98f64b99927bf230bc',
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-ubuntu-vulkan-x64.tar.gz',
      size: 35_871_731,
      sha256: 'f59bca3239bde0bd2280fde0b538f2abd9e80abc8ccce6c740bb17e630cd6269',
      license: 'MIT',
      device: 'vulkan',
      requirement: 'libvulkan.so.1',
      server: 'llama-server',
      // The CPU libraries in this archive match the CPU build byte for byte. libggml-vulkan.so is
      // the backend this server loads, and it needs the system Vulkan loader.
      files: {
        'llama-server': {
          member: 'llama-b12189/llama-server',
          size: 17_864,
          sha256: 'fb6aa86c4c070c364ff0c020408141222a1ec4f75427959ea8a34029869900d0',
        },
        'libllama-server-impl.so': {
          member: 'llama-b12189/libllama-server-impl.so',
          size: 8_296_232,
          sha256: '61ee293517b3779550775628e0d005ad7462a585f7791b8e33c47a085bdf915d',
        },
        'libllama-common.so.0': {
          member: 'llama-b12189/libllama-common.so.0.9.0',
          size: 6_774_568,
          sha256: '4dcc374697da18f8e02c5d97bf3f95b0cfc6b66cc0541714c43ce72f9a6d9cbc',
        },
        'libmtmd.so.0': {
          member: 'llama-b12189/libmtmd.so.0.9.0',
          size: 2_308_016,
          sha256: '50dceaf6a54559e75916e81d61075f3ff1abbbaa39f77b3428ecd9821f3bd478',
        },
        'libllama.so.0': {
          member: 'llama-b12189/libllama.so.0.9.0',
          size: 5_485_632,
          sha256: '96929401b91678a0fff0c61443a1c8ed2acae466a816c45e111c850318ac4d7b',
        },
        'libggml.so.0': {
          member: 'llama-b12189/libggml.so.0.29.0',
          size: 51_040,
          sha256: '8643a58bb37af6fb153e2ea98b48efa227855725ee51c05f4ca76b9867956463',
        },
        'libggml-base.so.0': {
          member: 'llama-b12189/libggml-base.so.0.29.0',
          size: 937_984,
          sha256: '523a24650bf64abbcf94d3be5918db429d372ddea9af6194515bf6843bcb6227',
        },
        'LICENSE-llama.cpp': {
          member: 'llama-b12189/LICENSE',
          size: 1_078,
          sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
        },
        'libggml-cpu-alderlake.so': {
          member: 'llama-b12189/libggml-cpu-alderlake.so',
          size: 1_438_176,
          sha256: '6b2e71b7db59f664f5428ee9aa4a59cbabc7b0f68aa43e1f2f071bfe56886372',
        },
        'libggml-cpu-cannonlake.so': {
          member: 'llama-b12189/libggml-cpu-cannonlake.so',
          size: 1_583_456,
          sha256: 'c4e143051063c954dd2ed293d3d42037b30373c3fb1466a93a969bbbbe9a1476',
        },
        'libggml-cpu-cascadelake.so': {
          member: 'llama-b12189/libggml-cpu-cascadelake.so',
          size: 1_599_544,
          sha256: 'eadb9ebc148386e79263bfc1225b14378ced42f0427c4ad45b8049a6e308b418',
        },
        'libggml-cpu-cooperlake.so': {
          member: 'llama-b12189/libggml-cpu-cooperlake.so',
          size: 1_599_616,
          sha256: '869b7be246074de644880f099a82f44449d1a69429638e26c13e6779196288d4',
        },
        'libggml-cpu-haswell.so': {
          member: 'llama-b12189/libggml-cpu-haswell.so',
          size: 1_438_176,
          sha256: 'd5c208430185a6d4f84d1be9757265f54c890d2ba58a867aa1c957047ac9f3b1',
        },
        'libggml-cpu-icelake.so': {
          member: 'llama-b12189/libggml-cpu-icelake.so',
          size: 1_599_544,
          sha256: '776a9e5bfef482824cf7a2fcb206fc086dca5bb46e555134f325e43dec8f326d',
        },
        'libggml-cpu-ivybridge.so': {
          member: 'llama-b12189/libggml-cpu-ivybridge.so',
          size: 1_373_792,
          sha256: '6fe4c273e5832563e411b5749be252c7226140cfa67a2eb454e30640109053a0',
        },
        'libggml-cpu-piledriver.so': {
          member: 'llama-b12189/libggml-cpu-piledriver.so',
          size: 1_369_696,
          sha256: '05f20153e4b02718ed91c8dbbc05ec810e203f7b7dde0775fa52b0363c25b858',
        },
        'libggml-cpu-sandybridge.so': {
          member: 'llama-b12189/libggml-cpu-sandybridge.so',
          size: 1_372_848,
          sha256: 'de51eb47a88eb6e77b17662722575b99e4b5ac48326b97026b57c68421c90a08',
        },
        'libggml-cpu-sapphirerapids.so': {
          member: 'llama-b12189/libggml-cpu-sapphirerapids.so',
          size: 1_865_944,
          sha256: 'c0c6769212a6a129304d1386187677baf81834f53beba85530f6f2c3ff1c3508',
        },
        'libggml-cpu-skylakex.so': {
          member: 'llama-b12189/libggml-cpu-skylakex.so',
          size: 1_583_456,
          sha256: '4a2139be8d9e084ec50220a1295c91f436cc84ed38758173e22b5dcf74d7d1de',
        },
        'libggml-cpu-sse42.so': {
          member: 'llama-b12189/libggml-cpu-sse42.so',
          size: 980_488,
          sha256: '4574298456cd2f28c68d1fdfd66b3016906c1395a694a334dffeb0a938c60474',
        },
        'libggml-cpu-x64.so': {
          member: 'llama-b12189/libggml-cpu-x64.so',
          size: 976_512,
          sha256: '6c9b84c38e4b6cbc22a8b4f7aff4ce0335c9f67caab8133d86144d59b2d96b1d',
        },
        'libggml-cpu-zen4.so': {
          member: 'llama-b12189/libggml-cpu-zen4.so',
          size: 1_599_616,
          sha256: 'e5af657a5b69f7c7b8c66c7466e166de995526b8df046237030b4971325156fa',
        },
        'libggml-vulkan.so': {
          member: 'llama-b12189/libggml-vulkan.so',
          size: 41_213_944,
          sha256: '70cf5b48ff1dbed9172033e538df858a9ba5297efa0c5c807920973809ac051e',
        },
      },
    },
    cuda: {
      build: 'b12189',
      commit: '80d2c0c2c56e4a1bbf74be98f64b99927bf230bc',
      url: 'https://github.com/ggml-org/llama.cpp/releases/download/b12189/llama-b12189-bin-ubuntu-cuda-12.8-x64.tar.gz',
      size: 188_173_082,
      sha256: '664f720005135f621960b8f1550979a1bdd73b8ba887e2a47a314b0154fcaa0a',
      license: 'MIT',
      device: 'cuda',
      requirement: 'libcuda.so.1, libcudart.so.12, libcublas.so.12; NVIDIA Linux driver >= 570.26',
      server: 'llama-server',
      // Official Ubuntu x64 CUDA 12.8 server. libcudart, libcublas, and libcuda stay on the system.
      files: {
        'llama-server': {
          member: 'llama-b12189/llama-server',
          size: 17_888,
          sha256: 'ae64df992c8f2eaa77b0c0908d042caf759907be5d5f719c575a043e1573fce1',
        },
        'libllama-server-impl.so': {
          member: 'llama-b12189/libllama-server-impl.so',
          size: 8_085_512,
          sha256: '8916e3f382d6ab6c0368a9d9d781db29b9123366591fb5a4304b5abf9f963a20',
        },
        'libllama-common.so.0': {
          member: 'llama-b12189/libllama-common.so.0.9.0',
          size: 6_668_808,
          sha256: '06dbe6a3c748b15960fb168a353ea667aef2efb8d40d37b866526d412ab6840d',
        },
        'libmtmd.so.0': {
          member: 'llama-b12189/libmtmd.so.0.9.0',
          size: 2_279_120,
          sha256: '8e7b200d2c75f119d79afd1b0fe30d08facc5bc67f257bbd72e6b2aa7d2fe4cd',
        },
        'libllama.so.0': {
          member: 'llama-b12189/libllama.so.0.9.0',
          size: 5_601_304,
          sha256: '9f44f886fb34a9dd273b00d1dd7abddf3ffb00fb1072c10b6fa0e2036a6c2a9e',
        },
        'libggml.so.0': {
          member: 'llama-b12189/libggml.so.0.29.0',
          size: 55_960,
          sha256: '207cfc7c4b4b957a0e6f330cd2678290eae05508da23d8ed59b4b7fc0a828390',
        },
        'libggml-base.so.0': {
          member: 'llama-b12189/libggml-base.so.0.29.0',
          size: 970_656,
          sha256: '2bfcfaa4cd7eb73b2636b4839c17f3934539dc921d117d1a5bdf10acf3aa0a71',
        },
        LICENSE: {
          member: 'llama-b12189/LICENSE',
          size: 1_078,
          sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d',
        },
        'libggml-cuda.so': {
          member: 'llama-b12189/libggml-cuda.so',
          size: 189_266_824,
          sha256: 'd8e33b1d8f1ff507b15d1a6f44636e66292c2e7c7577dcf23f870f606a32eef9',
        },
        'libggml-cpu-alderlake.so': {
          member: 'llama-b12189/libggml-cpu-alderlake.so',
          size: 1_428_344,
          sha256: '6edbb06c09050ebb8ead52815444db509abd5165f9d10678b410d44b4059e347',
        },
        'libggml-cpu-cannonlake.so': {
          member: 'llama-b12189/libggml-cpu-cannonlake.so',
          size: 1_606_392,
          sha256: 'bc96880f83561cbf93b729cbd34a8791d1f6dfab3c1a318e69043ec4d55463ed',
        },
        'libggml-cpu-cascadelake.so': {
          member: 'llama-b12189/libggml-cpu-cascadelake.so',
          size: 1_618_384,
          sha256: '65569f90b60dd31bb9e37d36b587d4754146ac2ae61d847507b8dd5ca8297768',
        },
        'libggml-cpu-cooperlake.so': {
          member: 'llama-b12189/libggml-cpu-cooperlake.so',
          size: 1_618_552,
          sha256: 'd80702378366b6c395e02779797dbb5e7292594fc9b569d45eaa1ab581d2967d',
        },
        'libggml-cpu-haswell.so': {
          member: 'llama-b12189/libggml-cpu-haswell.so',
          size: 1_428_344,
          sha256: 'effa3a98726252496bdadd7b5d4307472b73e8b39e38f76b08f1086c243a2b44',
        },
        'libggml-cpu-icelake.so': {
          member: 'llama-b12189/libggml-cpu-icelake.so',
          size: 1_618_384,
          sha256: '9132c71888242c511f71a7c6803d115ced6228ebb8fe10d79005d55853cbcb0a',
        },
        'libggml-cpu-ivybridge.so': {
          member: 'llama-b12189/libggml-cpu-ivybridge.so',
          size: 1_351_712,
          sha256: '1add5bc34b568775c70aefb3825b6b93584446dfbb9acf07e9f7ccbc1e2bdd9d',
        },
        'libggml-cpu-piledriver.so': {
          member: 'llama-b12189/libggml-cpu-piledriver.so',
          size: 1_351_712,
          sha256: '0467790557b18feb8692ddfa76bf06bd987b6d05c07a91ec5af384ea30ad1942',
        },
        'libggml-cpu-sandybridge.so': {
          member: 'llama-b12189/libggml-cpu-sandybridge.so',
          size: 1_354_856,
          sha256: 'e6b81607688feff6caf7610e8cf575a1ec4614a8a51b2b801ddda02fbe099531',
        },
        'libggml-cpu-sapphirerapids.so': {
          member: 'llama-b12189/libggml-cpu-sapphirerapids.so',
          size: 1_860_272,
          sha256: 'ec4bf234097137a054a7b2c61cd54f69ac7ea3776feb9e572211b33001284c4a',
        },
        'libggml-cpu-skylakex.so': {
          member: 'llama-b12189/libggml-cpu-skylakex.so',
          size: 1_606_392,
          sha256: '02499c026a6c3d3b6c41aeaf0863b1588c8bbb99afa19119571793de62a7cfb2',
        },
        'libggml-cpu-sse42.so': {
          member: 'llama-b12189/libggml-cpu-sse42.so',
          size: 1_028_032,
          sha256: '4c30b489edd8178f44c0f0734befadc4ca02a202269787615b8a2905e7ce0edb',
        },
        'libggml-cpu-x64.so': {
          member: 'llama-b12189/libggml-cpu-x64.so',
          size: 1_019_928,
          sha256: '37ac675025e8ca8fdc4e8965a063dbca48366919c5688add23aecd87e19bc2d8',
        },
        'libggml-cpu-zen4.so': {
          member: 'llama-b12189/libggml-cpu-zen4.so',
          size: 1_618_552,
          sha256: '59dcbb71fcce3ef7b578a2132cc8c7a4dc2cfa51f4819719cd4068a1322bf231',
        },
      },
    },
  },
  renderer: {
    version: RENDERER_VERSION,
    sha256: 'afb90447c06126d1270c7a880c6bc6b560f7528f6a6e7d9cca44c6c8194682ff',
  },
};

/** The manifest for `<platform>-<arch>`, or null when Corral ships no Local engine for it. */
export function d1ManifestFor(platform: string, arch: string): D1Manifest | null {
  return `${platform}-${arch}` === LINUX_X64_CPU.target ? LINUX_X64_CPU : null;
}
