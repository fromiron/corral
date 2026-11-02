// One local AI instance per server: the shared embedding engine and the effort judge on it.
// The caller creates it once and closes it on shutdown; nothing starts until the first use.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { type Bundle, bundledManifest } from './bundle.ts';
import { loadEffortClassifier } from './effort/classifier.ts';
import { EFFORT_PREPROCESS_VERSION } from './effort/preprocess.ts';
import { LocalEffortProvider } from './effort/provider.ts';
import { type Device, type EngineState, LocalEmbeddingEngine } from './engine/engine.ts';
import { builtHelperPath, type HelperLauncher, spawnHelper } from './engine/helper.ts';
import { BundleInstaller, type InstallProgressView } from './installer.ts';
import { LocalMeetingSelector, loadMeetingWeights } from './meeting/selector.ts';
import { cpuThreads, defaultLocalAiDir, runtimeTarget } from './platform.ts';

export interface LocalIntelligenceOptions {
  /** Where bundles are installed. Defaults to the OS's per-user data directory. */
  root?: string;
  device?: Device;
  /** Reads CORRAL_LOCAL_AI_HELPER, the helper executable's path. */
  env?: NodeJS.ProcessEnv;
  bundle?: Bundle;
  effortWeights?: unknown;
  meetingWeights?: unknown;
  launch?: HelperLauncher;
  /** Downloads for the settings panel's install. */
  fetchFn?: typeof fetch;
  platform?: string;
  arch?: string;
  logicalCores?: number;
}

/** What the settings panel shows. */
export interface LocalAiStatus {
  release: string;
  modelName: string;
  state: EngineState | 'installing';
  /** The full download for this machine, or null when it has no runtime. */
  downloadBytes: number | null;
  progress: InstallProgressView | null;
  /** The last install failure, else why the engine cannot run. */
  error: string | null;
}

export interface LocalIntelligence {
  readonly root: string;
  readonly bundle: Bundle;
  /** `<platform>-<arch>`, or null when the bundle has no runtime for this machine. */
  readonly target: string | null;
  readonly engine: LocalEmbeddingEngine;
  readonly effort: LocalEffortProvider;
  readonly meeting: Pick<LocalMeetingSelector, 'select'>;
  status(): LocalAiStatus;
  /** Starts installing this release in the background unless it cannot or need not. */
  install(): LocalAiStatus;
  /** Stops a running install; resolves once its partial files are removed. */
  cancelInstall(): Promise<LocalAiStatus>;
  /** Cancels a running install and stops the engine. */
  close(): Promise<void>;
}

/** The trained effort classifier shipped with this package. */
export function bundledEffortWeights(): unknown {
  return JSON.parse(readFileSync(new URL('../weights/effort-v2.json', import.meta.url), 'utf8'));
}

export function bundledMeetingWeights(): unknown {
  return JSON.parse(readFileSync(new URL('../weights/meeting-v1.json', import.meta.url), 'utf8'));
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
  const helperPath =
    (options.env ?? process.env).CORRAL_LOCAL_AI_HELPER || builtHelperPath(platform);
  const engine = new LocalEmbeddingEngine({
    root,
    bundle,
    target,
    helperPath,
    launch: options.launch ?? spawnHelper,
    device: options.device,
    threads: cpuThreads(arch, options.logicalCores ?? availableParallelism()),
  });
  const effort = new LocalEffortProvider({ engine, classifier, release: bundle.release });
  let meetingSelector: LocalMeetingSelector | undefined;
  const meeting: LocalIntelligence['meeting'] = {
    async select(input) {
      if (engine.available() !== true) return null;
      meetingSelector ??= new LocalMeetingSelector(
        engine,
        loadMeetingWeights(options.meetingWeights ?? bundledMeetingWeights(), {
          dims: bundle.embedding.dims,
          baseModelSha256: bundle.model.sha256,
        }),
      );
      return meetingSelector.select(input);
    },
  };
  const installer = new BundleInstaller({
    root,
    bundle,
    target,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    onInstalled: () => engine.refreshInstall(),
  });
  // Runtime and spawn errors name the bundle folder or the helper; the panel shows neither.
  const withoutPaths = (text: string | null) => {
    if (!text) return text;
    const scrubbed = text.replaceAll(root, '<local AI folder>');
    return helperPath ? scrubbed.replaceAll(helperPath, '<local AI helper>') : scrubbed;
  };
  const status = (): LocalAiStatus => {
    const installing = installer.running();
    // An install from the CLI counts too.
    if (!installing) engine.refreshInstall();
    const current = engine.status();
    return {
      release: bundle.release,
      modelName: bundle.model.name,
      state: installing ? 'installing' : current.state,
      downloadBytes: installer.downloadBytes(),
      progress: installer.progress(),
      error: withoutPaths(installer.error() ?? current.error),
    };
  };
  return {
    root,
    bundle,
    target,
    engine,
    effort,
    meeting,
    status,
    install: () => {
      if (status().state !== 'unsupported') installer.start();
      return status();
    },
    cancelInstall: async () => {
      await installer.cancel();
      return status();
    },
    close: async () => {
      await installer.cancel();
      await engine.close();
    },
  };
}
