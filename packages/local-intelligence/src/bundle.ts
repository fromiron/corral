// The bundle this build installs and runs: the meeting model (stock EmbeddingGemma 2) and the
// LiteRT-LM C library for each supported desktop target, each pinned by size and sha256. The library is taken from the
// official `litert-lm-api` wheel, so both the wheel and the extracted files are pinned.
import bundled from './bundle.json' with { type: 'json' };

export interface PinnedFile {
  url: string;
  size: number;
  sha256: string;
}

export interface RuntimeTargetFiles extends PinnedFile {
  /** The file the helper loads. */
  library: string;
  /** Files extracted from the wheel, keyed by their installed name. */
  files: Record<string, { member: string; size: number; sha256: string }>;
}

export interface ModelFile extends PinnedFile {
  name: string;
  file: string;
  dims: number;
  maxInputTokens: number;
}

export interface Bundle {
  schemaVersion: 2;
  release: string;
  models: { meeting: ModelFile };
  runtime: {
    name: string;
    version: string;
    apiVersion: { major: number; minor: number };
    targets: Record<string, RuntimeTargetFiles>;
  };
}

const SAFE_NAME = /^[A-Za-z0-9._-]+$/;
const SHA256 = /^[0-9a-f]{64}$/;

function validSize(size: unknown) {
  return Number.isSafeInteger(size) && (size as number) > 0;
}

function validPinned(file: PinnedFile) {
  return /^https:\/\//.test(file.url) && validSize(file.size) && SHA256.test(file.sha256);
}

/** Rejects a manifest that could write outside the bundle folder or skip a check. */
export function validBundle(bundle: Bundle): Bundle {
  const targets = Object.values(bundle.runtime?.targets ?? {});
  const model = bundle.models?.meeting;
  const valid =
    bundle.schemaVersion === 2 &&
    SAFE_NAME.test(bundle.release ?? '') &&
    !!model &&
    SAFE_NAME.test(model.file ?? '') &&
    validPinned(model) &&
    validSize(model.dims) &&
    validSize(model.maxInputTokens) &&
    targets.length > 0 &&
    targets.every((target) => {
      const files = Object.entries(target.files ?? {});
      return (
        validPinned(target) &&
        files.length > 0 &&
        Object.hasOwn(target.files, target.library) &&
        files.every(
          ([name, file]) =>
            SAFE_NAME.test(name) &&
            name !== model.file &&
            typeof file.member === 'string' &&
            file.member.length > 0 &&
            validSize(file.size) &&
            SHA256.test(file.sha256),
        )
      );
    });
  if (!valid) throw new Error('local AI bundle manifest is invalid');
  return bundle;
}

export function bundledManifest(): Bundle {
  return validBundle(bundled as Bundle);
}
