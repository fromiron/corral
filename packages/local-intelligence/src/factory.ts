// One local AI owner per server. Explicit decision overrides may also own a decision engine.
// The caller creates it once and closes it on shutdown. Default providers start on first use.
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import type {
  DecisionCancellation,
  DecisionProvider,
  EffortQuestion,
  ReasoningInput,
} from '@corral/contracts';
import { type Bundle, bundledManifest } from './bundle.ts';
import type { LocalDecisionEngine } from './decision/engine.ts';
import {
  type CalibratedEffortAnswer,
  type DecisionEffortProviderOptions,
  type DecisionMeetingSelectorOptions,
  LocalDecisionEffortProvider,
  LocalDecisionMeetingSelector,
} from './decision/providers.ts';
import type { DecisionBackend, DecisionEngineState, DecisionErrorCode } from './decision/types.ts';
import { loadEffortClassifier } from './effort/classifier.ts';
import { EFFORT_PREPROCESS_VERSION } from './effort/preprocess.ts';
import { LocalEffortProvider } from './effort/provider.ts';
import { type Device, type EngineState, LocalEmbeddingEngine } from './engine/engine.ts';
import { builtHelperPath, type HelperLauncher, spawnHelper } from './engine/helper.ts';
import { BundleInstaller, type InstallProgressView } from './installer.ts';
import { LocalMeetingSelector } from './meeting/selector.ts';
import { cpuThreads, defaultLocalAiDir, runtimeTarget } from './platform.ts';

export interface LocalEffortPort extends DecisionProvider {
  warmUp(): Promise<void>;
  decide(
    question: EffortQuestion,
    cancellation: DecisionCancellation,
  ): Promise<CalibratedEffortAnswer>;
  decideRequest(
    input: ReasoningInput,
    cancellation: DecisionCancellation,
  ): Promise<CalibratedEffortAnswer>;
}

export interface LocalMeetingPort extends Pick<LocalMeetingSelector, 'select'> {
  /** Selected decision roles can prepare independently; legacy selectors have no warmup hook. */
  warmUp?(): Promise<void>;
}

export interface DecisionModelIdentity {
  /** Public artifact identifier, not a file path or user text. */
  id: string;
  sha256: string;
}

export interface LocalDecisionOverride {
  /** Caller verifies artifacts and configures deterministic warmup. Factory owns close on success. */
  engine: LocalDecisionEngine;
  identity: DecisionModelIdentity;
  effort?: Omit<DecisionEffortProviderOptions, 'engine' | 'release'>;
  meeting?: Omit<DecisionMeetingSelectorOptions, 'engine' | 'release'>;
}

export interface LocalDecisionStatus {
  roles: ('effort' | 'meeting')[];
  identity: DecisionModelIdentity;
  state: DecisionEngineState;
  requestedBackend: DecisionBackend;
  actualBackend: DecisionBackend | null;
  error: DecisionErrorCode | null;
}

export interface LocalIntelligenceOptions {
  /** Where bundles are installed. Defaults to the OS's per-user data directory. */
  root?: string;
  device?: Device;
  /** Reads CORRAL_LOCAL_AI_HELPER, the helper executable's path. */
  env?: NodeJS.ProcessEnv;
  bundle?: Bundle;
  effortWeights?: unknown;
  launch?: HelperLauncher;
  /** Downloads for the settings panel's install. */
  fetchFn?: typeof fetch;
  platform?: string;
  arch?: string;
  logicalCores?: number;
  /** Explicit opt-in only. Unselected roles keep the embedding providers. */
  decision?: LocalDecisionOverride;
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
  /** Separate from embedding/install status; present only for an explicit override. */
  decision?: LocalDecisionStatus;
}

export interface LocalIntelligence {
  readonly root: string;
  readonly bundle: Bundle;
  /** `<platform>-<arch>`, or null when the bundle has no runtime for this machine. */
  readonly target: string | null;
  readonly engine: LocalEmbeddingEngine;
  readonly effort: LocalEffortPort;
  readonly meeting: LocalMeetingPort;
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

export function createLocalIntelligence(options: LocalIntelligenceOptions = {}): LocalIntelligence {
  const decision = options.decision;
  if (
    decision &&
    ((!decision.effort && !decision.meeting) ||
      typeof decision.identity?.id !== 'string' ||
      typeof decision.identity?.sha256 !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/.test(decision.identity?.id ?? '') ||
      !/^[a-f0-9]{64}$/.test(decision.identity?.sha256 ?? ''))
  )
    throw new Error('decision override requires enabled roles and a public model identity');
  const decisionEngine = decision?.engine;
  const identity = decision
    ? { id: decision.identity.id, sha256: decision.identity.sha256 }
    : undefined;
  const roles: LocalDecisionStatus['roles'] = [
    ...(decision?.effort ? ['effort' as const] : []),
    ...(decision?.meeting ? ['meeting' as const] : []),
  ];
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
  const effort: LocalEffortPort = decision?.effort
    ? new LocalDecisionEffortProvider({
        ...decision.effort,
        engine: decision.engine,
        release: decision.identity.id,
      })
    : new LocalEffortProvider({
        engine,
        release: bundle.release,
        classifier: loadEffortClassifier(options.effortWeights ?? bundledEffortWeights(), {
          dims: bundle.embedding.dims,
          baseModelSha256: bundle.model.sha256,
          preprocessVersion: EFFORT_PREPROCESS_VERSION,
        }),
      });
  let meetingSelector: LocalMeetingSelector | undefined;
  const meeting: LocalIntelligence['meeting'] = decision?.meeting
    ? new LocalDecisionMeetingSelector({
        ...decision.meeting,
        engine: decision.engine,
        release: decision.identity.id,
      })
    : {
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
    onInstalled: () => engine.refreshInstall(),
  });
  // Runtime and spawn errors name the bundle folder or the helper; the panel shows neither.
  const withoutPaths = (text: string | null) => {
    if (!text) return text;
    const scrubbed = text.replaceAll(root, '<local AI folder>');
    return helperPath ? scrubbed.replaceAll(helperPath, '<local AI helper>') : scrubbed;
  };
  const safeDecisionErrors = new Set<DecisionErrorCode>([
    'cancelled',
    'timeout',
    'closed',
    'unavailable',
    'queue_full',
    'startup_failed',
    'startup_timeout',
    'helper_failed',
    'invalid_request',
    'invalid_budget',
    'input_too_long',
    'invalid_response',
  ]);
  const decisionStatus = (): LocalDecisionStatus | undefined => {
    if (!decisionEngine || !identity) return undefined;
    const current = decisionEngine.status();
    return {
      roles: [...roles],
      identity: { ...identity },
      state: current.state,
      requestedBackend: current.requestedBackend,
      actualBackend: current.actualBackend,
      error:
        current.error === null
          ? null
          : safeDecisionErrors.has(current.error)
            ? current.error
            : 'helper_failed',
    };
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
      ...(decisionEngine ? { decision: decisionStatus() } : {}),
    };
  };
  let closing: Promise<void> | null = null;
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
    close: () => {
      closing ??= (async () => {
        const results = await Promise.allSettled([
          installer.cancel(),
          engine.close(),
          ...(decisionEngine ? [decisionEngine.close()] : []),
        ]);
        const failure = results.find((result) => result.status === 'rejected');
        if (failure?.status === 'rejected') throw failure.reason;
      })();
      return closing;
    },
  };
}
