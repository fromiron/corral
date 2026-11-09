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
  runtime: PinnedDownload & {
    build: string;
    commit: string;
    license: string;
    /** The installed name of the server executable; one of `files`. */
    server: string;
    /** Files taken from the archive, keyed by their installed name. */
    files: Record<string, { member: string; size: number; sha256: string }>;
  };
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

/** Why a manifest cannot be installed or run, or null when it is complete. */
export function manifestProblem(manifest: D1Manifest): string | null {
  const { model, runtime, renderer } = manifest;
  const files = Object.entries(runtime?.files ?? {});
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
    pinned(runtime) &&
    text(runtime.build) &&
    COMMIT.test(runtime.commit ?? '') &&
    text(runtime.license) &&
    files.length > 0 &&
    Object.hasOwn(runtime.files, runtime.server) &&
    files.every(
      ([name, file]) =>
        SAFE_NAME.test(name) &&
        name !== model.file &&
        SAFE_MEMBER.test(file.member ?? '') &&
        size(file.size) &&
        SHA256.test(file.sha256 ?? ''),
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
    server: 'llama-server',
    // Recorded from the official archive; empty until then, which refuses the manifest.
    files: {},
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
