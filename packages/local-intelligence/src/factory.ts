// One local AI instance per server: the shared embedding engine and the effort judge on it.
// The caller creates it once and closes it on shutdown; nothing starts until the first use.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { type Bundle, bundledManifest } from './bundle.ts';
import { loadEffortClassifier } from './effort/classifier.ts';
import { EFFORT_PREPROCESS_VERSION } from './effort/preprocess.ts';
import { LocalEffortProvider } from './effort/provider.ts';
import { type Device, LocalEmbeddingEngine } from './engine/engine.ts';
import { builtHelperPath, type HelperLauncher, spawnHelper } from './engine/helper.ts';
import { cpuThreads, defaultLocalAiDir, runtimeTarget } from './platform.ts';

export interface LocalIntelligenceOptions {
  /** Where bundles are installed. Defaults to the OS's per-user data directory. */
  root?: string;
  device?: Device;
  /** Reads CORRAL_LOCAL_AI_HELPER, the helper executable's path. */
  env?: NodeJS.ProcessEnv;
  bundle?: Bundle;
  effortWeights?: unknown;
  launch?: HelperLauncher;
  platform?: string;
  arch?: string;
  logicalCores?: number;
}

export interface LocalIntelligence {
  readonly root: string;
  readonly bundle: Bundle;
  /** `<platform>-<arch>`, or null when the bundle has no runtime for this machine. */
  readonly target: string | null;
  readonly engine: LocalEmbeddingEngine;
  readonly effort: LocalEffortProvider;
  close(): Promise<void>;
}

/** The trained effort classifier shipped with this package. */
export function bundledEffortWeights(): unknown {
  return JSON.parse(readFileSync(new URL('../weights/effort-v1.json', import.meta.url), 'utf8'));
}

export function createLocalIntelligence(options: LocalIntelligenceOptions = {}): LocalIntelligence {
  const bundle = options.bundle ?? bundledManifest();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const root = options.root ?? defaultLocalAiDir();
  const target = runtimeTarget(bundle, platform, arch);
  const classifier = loadEffortClassifier(options.effortWeights ?? bundledEffortWeights(), {
    dims: bundle.embedding.dims,
    baseModelSha256: bundle.model.sha256,
    preprocessVersion: EFFORT_PREPROCESS_VERSION,
  });
  const engine = new LocalEmbeddingEngine({
    root,
    bundle,
    target,
    helperPath: (options.env ?? process.env).CORRAL_LOCAL_AI_HELPER || builtHelperPath(platform),
    launch: options.launch ?? spawnHelper,
    device: options.device,
    threads: cpuThreads(arch, options.logicalCores ?? availableParallelism()),
  });
  const effort = new LocalEffortProvider({ engine, classifier, release: bundle.release });
  return { root, bundle, target, engine, effort, close: () => engine.close() };
}
