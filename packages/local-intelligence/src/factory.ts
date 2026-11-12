// One local AI instance per server: the embedding engine with the meeting model, for meeting
// analysis. The caller creates it once and closes it on shutdown; nothing starts until the first
// use.
import { availableParallelism } from 'node:os';
import { type Bundle, bundledManifest } from './bundle.ts';
import { BundleBusyError } from './busy.ts';
import { type Device, type EngineState, LocalEmbeddingEngine } from './engine/engine.ts';
import { builtHelperPath, type HelperLauncher, spawnHelper } from './engine/helper.ts';
import { removeMeetingReleases } from './install.ts';
import { BundleInstaller, type InstallProgressView } from './installer.ts';
import { LocalMeetingSelector } from './meeting/selector.ts';
import { cpuThreads, defaultLocalAiDir, runtimeTarget } from './platform.ts';

export interface LocalIntelligenceOptions {
  /** Where bundles are installed. Defaults to the OS's per-user data directory. */
  root?: string;
  device?: Device;
  /** Reads CORRAL_LOCAL_AI_HELPER, the helper executable's path. */
  env?: NodeJS.ProcessEnv;
  bundle?: Bundle;
  launch?: HelperLauncher;
  /** Downloads for the settings panel's install. */
  fetchFn?: typeof fetch;
  /**
   * Awaited after an install's files are on disk and before that install is accepted. A removal
   * in that gap discards the install, including files the callback writes afterwards.
   */
  beforeAccept?(): Promise<void>;
  platform?: string;
  arch?: string;
  logicalCores?: number;
}

/** What the settings panel shows. */
export interface LocalAiStatus {
  release: string;
  /** Display name of the model the bundle installs. */
  models: { meeting: string };
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
  readonly meeting: Pick<LocalMeetingSelector, 'select'>;
  status(): LocalAiStatus;
  /** Starts installing this release in the background unless it cannot or need not. */
  install(): LocalAiStatus;
  /** The in-flight install, including the moment before it is accepted. Null when none runs. */
  installing(): Promise<void> | null;
  /** Stops a running install; resolves once its partial files are removed. */
  cancelInstall(): Promise<LocalAiStatus>;
  /**
   * Stops the helper Corral started and deletes this bundle's release folders. Refused while an
   * install or an embedding is in progress. The judge model under `d1` stays.
   */
  remove(): Promise<LocalAiStatus>;
  /** Cancels a running install and stops the engine. */
  close(): Promise<void>;
}

export function createLocalIntelligence(options: LocalIntelligenceOptions = {}): LocalIntelligence {
  const bundle = options.bundle ?? bundledManifest();
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const root = options.root ?? defaultLocalAiDir();
  const target = runtimeTarget(bundle, platform, arch);
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
  let meetingSelector: LocalMeetingSelector | undefined;
  const meeting: LocalIntelligence['meeting'] = {
    async select(input) {
      if (engine.available() !== true) return null;
      meetingSelector ??= new LocalMeetingSelector(engine, bundle.release);
      return meetingSelector.select(input);
    },
  };
  const installer = new BundleInstaller({
    root,
    bundle,
    target,
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    ...(options.beforeAccept ? { beforeAccept: options.beforeAccept } : {}),
    onInstalled: () => engine.refreshInstall(),
    onDiscarded: () => {
      removeMeetingReleases(root, bundle);
      engine.refreshInstall();
    },
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
      models: { meeting: bundle.models.meeting.name },
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
    meeting,
    status,
    install: () => {
      if (status().state !== 'unsupported') installer.start();
      return status();
    },
    installing: () => installer.installing(),
    cancelInstall: async () => {
      await installer.cancel();
      return status();
    },
    remove: async () => {
      if (!target) throw new Error('local AI has no runtime for this platform');
      if (installer.running()) throw new BundleBusyError('installing');
      if (engine.busy()) throw new BundleBusyError('computing');
      installer.invalidate();
      await engine.stop();
      removeMeetingReleases(root, bundle);
      engine.refreshInstall();
      return status();
    },
    close: async () => {
      installer.invalidate();
      await installer.cancel();
      await engine.close();
    },
  };
}
