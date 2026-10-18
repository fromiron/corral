import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  createFauxCore,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  type InlineExtension,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';

// H1 spike harness (CR-018, plan §6 H1). A Pi SDK session wired the way ADR-027 proposes:
// - a ModelRuntime with no credentials, and one "corral" provider whose streamSimple asks a
//   host for a permit before every request and only then calls the real stream (faux here);
// - in-memory settings (cache warming off) and session;
// - resources only from explicit paths, with automatic discovery switched off;
// - a Corral extension loaded last that approves tool calls with their final input.
// Nothing here is product code; it answers whether the public API can hold these boundaries.

export const PROVIDER = 'corral';
export const API = 'corral-proxy';
export const MODEL_ID = 'faux-1';
export const CORRAL_EXTENSION = '<inline:corral>';

export interface PermitLog {
  /** One entry per permit the host granted, in order. */
  permits: string[];
  /** One entry per request that reached the underlying stream, with the permit it used. */
  dispatches: string[];
  /** Requests the host refused. */
  refused: number;
  /** Final tool input the Corral extension approved, per tool call id. */
  approved: { toolName: string; toolCallId: string; parent?: string; input: unknown }[];
  /** Hash of the input each tool started with (from tool_execution_start). */
  started: { toolCallId: string; hash: string }[];
  /** before_provider_request payload hashes (only HTTP providers emit payloads). */
  payloads: string[];
  /** What the Corral provider received for each dispatched request: the final context. */
  requests: { permit: string; hash: string; systemPrompt: string }[];
}

export const hashOf = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

export interface SpikeOptions {
  responses: FauxResponseStep[];
  /** Extensions loaded before Corral's, in this order. */
  extensions?: (ExtensionFactory | InlineExtension)[];
  /** File-based extensions bound to the role (absolute paths). */
  extensionPaths?: string[];
  skillPaths?: string[];
  customTools?: ToolDefinition[];
  /** Host decision for each permit request; default grants. */
  permit?: (n: number) => boolean;
  /** Corral's tool_call decision on the final input; default approves. Throwing is allowed. */
  approve?: (toolName: string, input: unknown) => boolean;
  settings?: Record<string, unknown>;
  contextWindow?: number;
  cwd?: string;
  systemPrompt?: string;
  /** Rewrites discovered skills, e.g. to give them paths without local folders. */
  skillsOverride?: ConstructorParameters<typeof DefaultResourceLoader>[0]['skillsOverride'];
  appendSystemPrompt?: string[];
}

export async function spikeSession(options: SpikeOptions) {
  const scratch = mkdtempSync(join(tmpdir(), 'corral-har-'));
  const agentDir = join(scratch, 'agent');
  mkdirSync(agentDir);
  const cwd = options.cwd ?? join(scratch, 'work');
  mkdirSync(cwd, { recursive: true });

  const faux = createFauxCore({});
  faux.setResponses(options.responses);
  const fauxModel = faux.getModel();

  const log: PermitLog = {
    permits: [],
    dispatches: [],
    refused: 0,
    approved: [],
    started: [],
    payloads: [],
    requests: [],
  };
  let asked = 0;

  const modelRuntime = await ModelRuntime.create({
    authPath: join(scratch, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  modelRuntime.registerProvider(PROVIDER, {
    api: API,
    // Required for custom models; never contacted: streamSimple below answers every request.
    baseUrl: 'http://127.0.0.1:9/corral-unused',
    // Pi wants a configured key before it sends; the real one only ever comes with a permit.
    apiKey: 'corral-permit-placeholder',
    models: [
      {
        id: MODEL_ID,
        name: 'Corral proxy',
        api: API,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: options.contextWindow ?? 128_000,
        maxTokens: 4096,
      },
    ],
    streamSimple: (_model, context, streamOptions) => {
      const out = createAssistantMessageEventStream();
      void (async () => {
        asked += 1;
        const granted = options.permit ? options.permit(asked) : true;
        if (!granted) {
          log.refused += 1;
          const message: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: API,
            provider: PROVIDER,
            model: MODEL_ID,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: 'error',
            errorMessage: 'the request was refused',
            timestamp: Date.now(),
          };
          out.push({ type: 'error', reason: 'error', error: message });
          out.end(message);
          return;
        }
        const permitId = `permit_${log.permits.length + 1}`;
        log.permits.push(permitId);
        log.dispatches.push(permitId);
        log.requests.push({
          permit: permitId,
          hash: hashOf(context),
          // Pi 1.3 carries the system prompt as system messages with named sections.
          systemPrompt: JSON.stringify(context.messages.filter((m) => m.role === 'system')),
        });
        const inner = faux.streamSimple(fauxModel, context, {
          ...streamOptions,
          apiKey: 'test-access-token-not-a-secret',
        });
        for await (const event of inner) out.push(event);
        out.end(await inner.result());
      })();
      return out;
    },
  });
  const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
  if (!model) throw new Error('corral model not registered');

  const corral: InlineExtension = {
    name: 'corral',
    factory: (pi: ExtensionAPI) => {
      pi.on('tool_call', async (event) => {
        const allowed = options.approve ? options.approve(event.toolName, event.input) : true;
        log.approved.push({
          toolName: event.toolName,
          toolCallId: event.toolCallId,
          ...(event.parentToolCallId ? { parent: event.parentToolCallId } : {}),
          input: structuredClone(event.input),
        });
        if (!allowed) return { block: true, reason: 'not approved by Corral' };
        return undefined;
      });
      pi.on('tool_execution_start', async (event) => {
        log.started.push({ toolCallId: event.toolCallId, hash: hashOf(event.args) });
      });
      pi.on('before_provider_request', async (event) => {
        log.payloads.push(hashOf(event.payload));
        return undefined;
      });
    },
  };

  const settingsManager = SettingsManager.inMemory({
    cacheWarming: 'off',
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 5 },
    ...options.settings,
  } as never);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: options.extensionPaths ?? [],
    additionalSkillPaths: options.skillPaths ?? [],
    extensionFactories: [...(options.extensions ?? []), corral],
    // The SDK applies no project trust: without these, a project's .pi/SYSTEM.md and
    // .pi/APPEND_SYSTEM.md reach the request even with every other discovery switched off (S4).
    systemPromptOverride: () => options.systemPrompt ?? 'You are one role of a Corral team.',
    appendSystemPromptOverride: () => options.appendSystemPrompt ?? [],
    ...(options.skillsOverride ? { skillsOverride: options.skillsOverride } : {}),
    // Corral's extension runs last whatever order discovery produced.
    extensionsOverride: (base) => {
      const ours = base.extensions.filter((e) => e.path === CORRAL_EXTENSION);
      const rest = base.extensions.filter((e) => e.path !== CORRAL_EXTENSION);
      return { ...base, extensions: [...rest, ...ours] };
    },
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir,
    model,
    thinkingLevel: 'off',
    modelRuntime,
    resourceLoader,
    noTools: 'builtin',
    customTools: options.customTools ?? [],
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
  });
  await session.bindExtensions({});

  return {
    session,
    modelRuntime,
    resourceLoader,
    faux,
    log,
    cwd,
    scratch,
    dispose() {
      session.dispose();
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}
