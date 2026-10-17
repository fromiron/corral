import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  canonicalJson,
  type DeliveredDirective,
  EditTextResult,
  HarnessCommand,
  type HarnessReport,
  LspQuery,
  ModelRequestRecord,
  ToolDescriptor,
} from '@corral/contracts';
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type JsonObject,
  normalizeContext,
  type Tool,
  Type,
  validateToolArguments,
} from '@earendil-works/pi-ai';
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  createEditToolDefinition,
  createReadToolDefinition,
  createSyntheticSourceInfo,
  createWriteToolDefinition,
  DefaultResourceLoader,
  type Extension,
  ModelRuntime,
  type ReadToolInput,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
  type WriteToolInput,
} from '@earendil-works/pi-coding-agent';
import { z } from 'zod';
import type { Channel } from './channel.ts';
import { extensionUi } from './extension-ui.ts';
import { lockResources } from './locked-resources.ts';
import { mcpExtension } from './mcp.ts';
import { PROTOCOL_VERSION, SdkHostFrame, type SdkStartFrame } from './protocol.ts';
import { normalizeUsage } from './usage.ts';
import type { WorkerDeps } from './worker.ts';
import { parametersOf, systemPrompt, TOOL_TEXT, textOf, userPrompt } from './worker-tools.ts';

export interface SdkWorkerDeps extends WorkerDeps {
  /** Private execution directory; the process launcher also isolates HOME and jiti here. */
  directory: string;
  now(): number;
}
type Reply = Exclude<SdkHostFrame, { type: 'start' | 'cancel' | 'directive' }>;
const hashOf = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const cleanJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const directiveText = (d: DeliveredDirective) =>
  `Corral instruction (${d.directiveId}):\n${d.text}`;

/** One explicit SDK session. Pi's session state never commits Corral domain state. */
export function runSdkWorker(port: Channel, deps: SdkWorkerDeps): void {
  let executionId: string | null = null;
  let session: AgentSession | undefined;
  let cancelled = false;
  let nextRequest = 0;
  const waiting = new Map<string, (reply: Reply) => void>();
  const directives = new Map<string, DeliveredDirective>();
  port.onFrame((raw) => {
    const parsed = SdkHostFrame.safeParse(raw);
    if (!parsed.success) {
      port.kill();
      return;
    }
    const frame = parsed.data;
    if (frame.type === 'start') {
      if (executionId !== null || !('harness' in frame)) {
        port.kill();
        return;
      }
      executionId = frame.executionId;
      void execute(frame);
      return;
    }
    if (frame.executionId !== executionId) {
      port.kill();
      return;
    }
    if (frame.type === 'cancel') {
      cancelled = true;
      for (const [requestId, resolveReply] of waiting)
        resolveReply({
          type: 'refused',
          protocolVersion: 2,
          executionId,
          requestId,
          reason: 'cancelled',
        });
      waiting.clear();
      void session?.abort();
    } else if (frame.type === 'directive') {
      if (directives.has(frame.directiveId) || cancelled) return;
      directives.set(frame.directiveId, frame);
      if (session?.isStreaming)
        void session.steer(directiveText(frame)).catch(() => {
          cancelled = true;
          void session?.abort();
        });
    } else {
      waiting.get(frame.requestId)?.(frame);
      waiting.delete(frame.requestId);
    }
  });
  port.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });

  async function execute(start: SdkStartFrame) {
    const head = { protocolVersion: PROTOCOL_VERSION, executionId: start.executionId };
    const send = (frame: Record<string, unknown>) => port.send({ ...frame, ...head });
    const call = (frame: Record<string, unknown>): Promise<Reply> => {
      if (cancelled) return Promise.reject(new Error('cancelled'));
      return new Promise((resolveReply) => {
        const requestId = `req_${++nextRequest}`;
        waiting.set(requestId, resolveReply);
        send({ ...frame, requestId });
      });
    };
    const ack = async (frame: Record<string, unknown>) => {
      if ((await call(frame)).type !== 'ack') throw new Error('host refused');
    };
    let notifications = Promise.resolve();
    let reported = false;
    let requiredExtensionFailed = false;
    let registryUpdates = Promise.resolve();
    let registryRevision = 1;
    let reportedRegistryHash = '';
    const codemodeExits = new Map<string, Promise<void>[]>();
    let shuttingDown: Promise<unknown> | undefined;
    const shutdown = () =>
      (shuttingDown ??= session
        ? session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' })
        : Promise.resolve());
    let failureCode: Extract<HarnessReport, { ok: false }>['code'] = 'sdk_start_failed';
    try {
      const model = deps.resolveModel(
        start.model.provider,
        start.model.modelId,
        start.model.endpoint,
      );
      if (!model) throw new Error('model unavailable');
      failureCode = 'policy_denied';
      if (
        start.harness.policy === 'strict' &&
        (start.resources.extensions.length ||
          start.resources.mcp?.length ||
          start.harness.allowedTools.includes('codemode'))
      )
        throw new Error('native extensions need trust');
      for (const resource of start.resources.extensions) {
        if (
          !start.harness.resources.some((r) => r.kind === 'extension' && r.hash === resource.hash)
        )
          throw new Error('unbound extension');
      }
      failureCode = 'resource_invalid';
      start = {
        ...start,
        resources: lockResources(start.resources, start.harness, deps.directory),
      };
      for (const resource of start.harness.resources.filter((r) => r.required)) {
        if (
          resource.kind === 'extension' &&
          !start.resources.extensions.some((e) => e.hash === resource.hash)
        )
          throw new Error('missing extension');
        if (
          resource.kind === 'skill' &&
          !start.resources.skills.some(
            (s) =>
              s.hash === resource.hash && (resource.skillMode !== 'mandatory' || s.content.trim()),
          )
        )
          throw new Error('missing skill');
      }
      const directory = deps.directory;
      const agentDir = join(directory, 'agent');
      const cwd = start.resources.cwd ?? join(directory, 'work');
      if (
        start.resources.mcp?.some(
          ({ server }) => !start.harness.projectTools?.mcpServerIds?.includes(server.id),
        )
      )
        throw new Error('unselected MCP server');
      mkdirSync(agentDir, { recursive: true });
      mkdirSync(cwd, { recursive: true });
      const runtime = await ModelRuntime.create({
        authPath: join(directory, 'auth.json'),
        modelsPath: null,
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      let purpose: ModelRequestRecord['purpose'] = 'turn';
      let nativeDepth = 0;
      let requests: Promise<void> = Promise.resolve();
      const proxyMessage = (message: AssistantMessage): AssistantMessage => ({
        ...message,
        api: 'corral-proxy',
        provider: 'corral',
        model: model.id,
      });
      const proxyEvent = (event: AssistantMessageEvent): AssistantMessageEvent => {
        if ('partial' in event) return { ...event, partial: proxyMessage(event.partial) };
        if (event.type === 'done') return { ...event, message: proxyMessage(event.message) };
        if (event.type === 'error') return { ...event, error: proxyMessage(event.error) };
        return event;
      };
      runtime.registerProvider('corral', {
        api: 'corral-proxy',
        baseUrl: 'http://127.0.0.1:9/corral-unused',
        apiKey: 'corral-permit-placeholder',
        models: [
          {
            id: model.id,
            name: model.name,
            api: 'corral-proxy',
            reasoning: model.reasoning,
            input: model.input,
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          },
        ],
        streamSimple: (_model, context, options) => {
          const out = createAssistantMessageEventStream();
          const requestPurpose = nativeDepth ? 'extension' : purpose;
          const owned = cleanJson(context) as Context;
          owned.messages = owned.messages.map((message) =>
            message.role === 'assistant' && message.provider === 'corral'
              ? { ...message, provider: model.provider, api: model.api, model: model.id }
              : message,
          );
          const mandatory =
            requestPurpose === 'compaction'
              ? []
              : start.resources.skills.filter((skill) => skill.mode === 'mandatory');
          if (mandatory.length) {
            let system = owned.messages.findLast((message) => message.role === 'system');
            if (!system) {
              system = { role: 'system', content: '', timestamp: deps.now() };
              owned.messages.unshift(system);
            }
            system.sections = { ...system.sections };
            for (const skill of mandatory) {
              if (!skill.content.trim()) throw new Error('mandatory skill missing');
              system.sections[`skill_${skill.name}`] =
                `Skill resources: skills/${skill.name}/\n${skill.content}`;
            }
          }
          const requestContext = normalizeContext(owned);
          // Core has one active request per execution. Nested provider requests queue here too.
          requests = requests.then(async () => {
            let modelCallId: string | undefined;
            let observed = false;
            try {
              await registryUpdates;
              if (requiredExtensionFailed) throw new Error('required extension failed');
              if (cancelled || options?.signal?.aborted) throw new Error('cancelled');
              const record = requestRecord(requestContext, requestPurpose, directives);
              const permit = await call({ type: 'prepare_request', ...record });
              if (permit.type !== 'permit' || cancelled || options?.signal?.aborted)
                throw new Error('request refused');
              modelCallId = permit.modelCallId;
              await ack({ type: 'request_dispatched', modelCallId });
              if (cancelled || options?.signal?.aborted)
                throw new Error('cancelled before dispatch');
              const stream = await deps.streamFn(model, requestContext, {
                ...options,
                apiKey: start.model.endpoint?.keyless ? undefined : (permit.apiKey ?? undefined),
                maxTokens: permit.maxOutputTokens,
                onPayload: async (payload, payloadModel) => {
                  const updated = await options?.onPayload?.(payload, payloadModel);
                  const actual = cleanJson(updated ?? payload);
                  const serialized = canonicalJson(actual);
                  for (const skill of mandatory)
                    if (!serialized.includes(JSON.stringify(skill.content).slice(1, -1)))
                      throw new Error('mandatory skill removed from provider payload');
                  await ack({
                    type: 'request_record',
                    modelCallId,
                    payloadHash: hashOf(actual),
                    payloadBytes: Buffer.byteLength(serialized),
                  });
                  if (cancelled || options?.signal?.aborted)
                    throw new Error('cancelled before HTTP dispatch');
                  return actual;
                },
              });
              let chunkIndex = 0;
              for await (const event of stream) {
                if (event.type === 'text_delta' && !cancelled)
                  send({
                    type: 'stream',
                    modelCallId,
                    chunkIndex: chunkIndex++,
                    text: event.delta,
                  });
                if (event.type === 'done' || event.type === 'error') {
                  const answer = event.type === 'done' ? event.message : event.error;
                  send({
                    type: 'observe',
                    modelCallId,
                    text: textOf(answer),
                    ...normalizeUsage(answer),
                  });
                  observed = true;
                }
                out.push(proxyEvent(event));
              }
              const answer = await stream.result();
              if (!observed)
                send({
                  type: 'observe',
                  modelCallId,
                  text: textOf(answer),
                  ...normalizeUsage(answer),
                });
              observed = true;
              out.end(proxyMessage(answer));
            } catch {
              const answer = failedMessage(
                cancelled || options?.signal?.aborted ? 'aborted' : 'error',
                deps.now(),
              );
              if (modelCallId && !observed)
                send({ type: 'observe', modelCallId, text: '', ...normalizeUsage(answer) });
              out.push({
                type: 'error',
                reason: answer.stopReason === 'aborted' ? 'aborted' : 'error',
                error: proxyMessage(answer),
              });
              out.end(proxyMessage(answer));
            }
          });
          return out;
        },
      });
      const proxyModel = runtime.getModel('corral', model.id);
      if (!proxyModel) throw new Error('proxy unavailable');
      const authorized = new Map<string, { toolCallId: string; argsHash: string }>();
      const descriptors = new Map<string, ToolDescriptor>();
      const schemas = new Map<string, Tool>();
      const customTools: ToolDefinition[] = start.tools.map((name) => {
        if (name === 'edit' || name === 'write') {
          const definition =
            name === 'edit' ? createEditToolDefinition(cwd) : createWriteToolDefinition(cwd);
          return {
            name,
            label: definition.label,
            description: `${definition.description} Corral requires a prior read by this execution before changing an existing file. Only worktree-relative paths are accepted.`,
            parameters: definition.parameters,
            promptSnippet: definition.promptSnippet,
            promptGuidelines: definition.promptGuidelines,
            annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
            executionMode: 'sequential',
            execute: async (piCallId, args, signal, update, ctx) => {
              const auth = takeAuthorization(piCallId, args);
              const reply = await call({ type: 'execute_tool', toolCallId: auth.toolCallId });
              if (reply.type !== 'tool_result' || !reply.ok)
                throw new Error(
                  reply.type === 'tool_result'
                    ? (reply.reason ?? 'Corral write refused')
                    : 'Corral write refused',
                );
              if (name === 'edit') return EditTextResult.shape.result.parse(reply.result?.piResult);
              const formatter = createWriteToolDefinition(cwd, {
                operations: { mkdir: async () => {}, writeFile: async () => {} },
              });
              const input: WriteToolInput = validateToolArguments(formatter, {
                type: 'toolCall',
                id: piCallId,
                name,
                arguments: args as JsonObject,
              });
              return formatter.execute(piCallId, input, signal, update, ctx);
            },
          };
        }
        if (name === 'read') {
          const definition = createReadToolDefinition(cwd);
          return {
            name: definition.name,
            label: definition.label,
            parameters: definition.parameters,
            outputSchema: definition.outputSchema,
            promptGuidelines: definition.promptGuidelines,
            annotations: { readOnlyHint: true, openWorldHint: false },
            description:
              'Read UTF-8 text through Corral. Paths are relative to the worktree; skills/<name>/ is reserved for bound skill files. Supports offset/limit; output is bounded to 2,000 lines or 50 KiB.',
            executionMode: 'sequential',
            execute: async (piCallId, args, signal, onUpdate, ctx) => {
              const auth = takeAuthorization(piCallId, args);
              const reply = await call({ type: 'execute_tool', toolCallId: auth.toolCallId });
              if (
                reply.type !== 'tool_result' ||
                !reply.ok ||
                typeof reply.result?.text !== 'string'
              )
                throw new Error(
                  reply.type === 'tool_result'
                    ? (reply.reason ?? 'Corral read refused')
                    : 'Corral read refused',
                );
              const text = reply.result.text;
              const reader = createReadToolDefinition(cwd, {
                operations: {
                  access: async () => {},
                  readFile: async () => Buffer.from(text, 'utf8'),
                  detectImageMimeType: async () => null,
                },
              });
              const readArgs: ReadToolInput = validateToolArguments(definition, {
                type: 'toolCall',
                id: piCallId,
                name: 'read',
                arguments: args as JsonObject,
              });
              const result = await reader.execute(piCallId, readArgs, signal, onUpdate, ctx);
              return {
                ...result,
                details: {
                  ...result.details,
                  source: {
                    path: reply.result.path,
                    sha256: reply.result.sha256,
                    resourceHash: reply.result.resourceHash,
                  },
                },
              };
            },
          };
        }
        return {
          name,
          label: name,
          description:
            name === 'run_check'
              ? 'Run a selected registered check against a frozen copy. Corral may request permission for this exact launch. Read state, verdict and stale separately; a stale or inconclusive report does not prove a pass.'
              : name === 'lsp_query'
                ? 'Query a selected language server for diagnostics, definition or references in the working copy. Positions are zero-based UTF-16 offsets. Corral may request launch permission. Results include file hashes; use read_file before editing.'
                : TOOL_TEXT[name],
          parameters:
            name === 'lsp_query'
              ? Type.Unsafe(
                  z.toJSONSchema(
                    z.union([
                      LspQuery.options[0].extend({
                        serverId: z.enum(start.harness.projectTools?.lspServerIds ?? []),
                      }),
                      LspQuery.options[1].extend({
                        serverId: z.enum(start.harness.projectTools?.lspServerIds ?? []),
                      }),
                    ]),
                    { target: 'draft-07', io: 'input' },
                  ),
                )
              : name === 'run_check'
                ? Type.Object(
                    {
                      commandId: Type.Union(
                        (start.harness.projectTools?.checkIds ?? []).map((id) => Type.Literal(id)),
                      ),
                    },
                    { additionalProperties: false },
                  )
                : parametersOf(name, start),
          executionMode: 'sequential',
          execute: async (piCallId, args) => {
            const auth = takeAuthorization(piCallId, args);
            const reply = await call({ type: 'execute_tool', toolCallId: auth.toolCallId });
            if (reply.type !== 'tool_result' || !reply.ok)
              throw new Error(
                reply.type === 'tool_result'
                  ? (reply.reason ?? 'Corral tool refused')
                  : 'Corral tool refused',
              );
            return {
              content: [{ type: 'text', text: JSON.stringify(reply.result ?? {}) }],
              details: reply.result ?? {},
            };
          },
        };
      });
      const register = (tool: ToolDefinition, source: string) => {
        descriptors.set(tool.name, describeTool(tool, source));
        schemas.set(tool.name, {
          name: tool.name,
          description: tool.description,
          parameters: JSON.parse(JSON.stringify(tool.parameters)) as Tool['parameters'],
        });
      };
      for (const tool of customTools) register(tool, 'corral');
      const takeAuthorization = (id: string, args: unknown) => {
        if (requiredExtensionFailed) throw new Error('required extension failed');
        const auth = authorized.get(id);
        authorized.delete(id);
        if (!auth || auth.argsHash !== hashOf(cleanJson(args)))
          throw new Error('arguments changed after authorization');
        return auth;
      };
      const wrappedTools = new WeakSet<ToolDefinition>();
      const nativeParents = new Map<string, string>();
      const wrappedHandlers = new WeakSet<object>();
      const publishRegistry = () => {
        const tools = [...descriptors.values()];
        const hash = hashOf(tools);
        if (!reported || hash === reportedRegistryHash) return;
        reportedRegistryHash = hash;
        const expectedRevision = registryRevision++;
        registryUpdates = registryUpdates.then(() =>
          ack({
            type: 'harness_tools',
            update: { snapshotHash: start.harness.snapshotHash, expectedRevision, tools },
          }),
        );
        void registryUpdates.catch(() => {
          requiredExtensionFailed = true;
        });
      };
      const wrapExtension = (extension: Extension) => {
        const codemode =
          extension.path === '<inline:corral-codemode>' &&
          start.harness.allowedTools.includes('codemode');
        const mcp = extension.path === '<inline:corral-mcp>' && !!start.resources.mcp?.length;
        if (mcp) extension.commands.clear();
        const resource = mcp
          ? { source: 'extension:pi-mcp@1.3.0', hash: '' }
          : codemode
            ? { source: 'extension:pi-codemode@1.3.0', hash: '' }
            : start.resources.extensions.find((e) => resolve(e.path) === resolve(extension.path));
        if (!resource) throw new Error('unbound extension loaded');
        if (
          codemode ||
          mcp ||
          start.harness.resources.some(
            (ref) => ref.kind === 'extension' && ref.hash === resource.hash && ref.required,
          )
        ) {
          for (const [event, handlers] of extension.handlers)
            extension.handlers.set(
              event,
              handlers.map((handler) => {
                if (wrappedHandlers.has(handler)) return handler;
                const wrapped = async (...args: Parameters<typeof handler>) => {
                  try {
                    return await handler(...args);
                  } catch {
                    requiredExtensionFailed = true;
                    throw new Error('required extension failed');
                  }
                };
                wrappedHandlers.add(wrapped);
                return wrapped;
              }),
            );
        }
        for (const { definition } of extension.tools.values()) {
          if (descriptors.has(definition.name)) throw new Error('tool name collision');
          if (!start.harness.allowedTools.includes(definition.name)) definition.exposure = 'hidden';
          register(definition, resource.source);
          if (wrappedTools.has(definition)) continue;
          wrappedTools.add(definition);
          const execute = definition.execute;
          definition.execute = async (id, args, signal, update, ctx) => {
            if (nativeParents.has(id)) throw new Error('duplicate active tool call');
            const auth = takeAuthorization(id, args);
            await ack({
              type: 'native_tool_start',
              toolCallId: auth.toolCallId,
              argsHash: auth.argsHash,
            });
            nativeDepth++;
            nativeParents.set(id, auth.toolCallId);
            const exits: Promise<void>[] = [];
            if (codemode) codemodeExits.set(id, exits);
            let outcome: 'succeeded' | 'failed' = 'failed';
            try {
              const result = await execute(id, args, signal, update, ctx);
              outcome = 'succeeded';
              return result;
            } finally {
              // Pi's result/close can precede Worker exit; keep the host lease until exit.
              if (codemode) {
                await Promise.all(exits);
                codemodeExits.delete(id);
              }
              nativeDepth--;
              nativeParents.delete(id);
              if (!cancelled)
                await ack({ type: 'native_tool_finish', toolCallId: auth.toolCallId, outcome });
            }
          };
        }
      };
      const settings = SettingsManager.inMemory({
        cacheWarming: 'off',
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxAgentDelayMs: 5 },
      });
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        skillsOverride: (base) => ({
          ...base,
          skills: start.resources.skills.map((skill) => ({
            name: skill.name,
            description: skill.description,
            filePath: `skills/${skill.name}/SKILL.md`,
            baseDir: `skills/${skill.name}`,
            disableModelInvocation: skill.mode !== 'auto',
            sourceInfo: createSyntheticSourceInfo(`skills/${skill.name}/SKILL.md`, {
              source: 'corral',
            }),
          })),
        }),
        additionalExtensionPaths: start.resources.extensions.map((e) => e.path),
        systemPromptOverride: () => systemPrompt(start),
        appendSystemPromptOverride: () => [],
        extensionFactories: [
          ...(start.resources.mcp?.length
            ? [
                {
                  name: 'corral-mcp',
                  factory: mcpExtension(start.resources, directory, async (serverId, challenge) => {
                    const reply = await call({
                      type: 'mcp_authorization',
                      serverId,
                      ...(challenge ? { challenge } : {}),
                    });
                    if (reply.type !== 'mcp_authorization')
                      throw new Error('MCP authorization unavailable');
                    return reply.token;
                  }),
                },
              ]
            : []),
          ...(start.harness.allowedTools.includes('codemode')
            ? [
                {
                  name: 'corral-codemode',
                  factory: createCodemodeExtension({
                    models: false,
                    onWorkerStarted: (id, exited) => {
                      const exits = codemodeExits.get(id);
                      if (!exits) throw new Error('unowned codemode worker');
                      exits.push(exited);
                    },
                  }),
                },
              ]
            : []),
          {
            name: 'corral',
            factory: (pi) => {
              pi.on('before_agent_start', (event) => {
                pi.setActiveTools(
                  pi
                    .getActiveTools()
                    .filter(
                      (name) => descriptors.has(name) && start.harness.allowedTools.includes(name),
                    ),
                );
                event.systemPromptOptions.sections.cwd =
                  'The working copy root (paths are relative to it).';
                for (const skill of start.resources.skills.filter((s) => s.mode === 'mandatory')) {
                  if (!skill.content.trim()) throw new Error('mandatory skill is empty');
                  event.systemPromptOptions.sections[`skill_${skill.name}`] = skill.content;
                }
              });
              pi.on('tool_call', async (event) => {
                await registryUpdates;
                if (requiredExtensionFailed)
                  return { block: true, reason: 'required extension failed' };
                const descriptor = descriptors.get(event.toolName);
                if (
                  !descriptor ||
                  (descriptor.source !== 'corral' &&
                    !start.harness.allowedTools.includes(event.toolName))
                )
                  return { block: true, reason: 'tool is not bound to this role' };
                if (event.toolName === 'reply' && start.assignment.kind === 'question')
                  event.input.questionId = start.assignment.questionId;
                try {
                  const args = cleanJson(event.input);
                  const schema = schemas.get(event.toolName);
                  if (!schema) return { block: true, reason: 'missing tool schema' };
                  const validated = validateToolArguments(schema, {
                    type: 'toolCall',
                    id: event.toolCallId,
                    name: event.toolName,
                    arguments: args as JsonObject,
                  });
                  // Pi validates before hooks. Validate again without silently coercing a hook's changes.
                  if (hashOf(validated) !== hashOf(cleanJson(event.input)))
                    return { block: true, reason: 'invalid final tool arguments' };
                  const parentToolCallId = event.parentToolCallId
                    ? nativeParents.get(event.parentToolCallId)
                    : undefined;
                  if (event.parentToolCallId && !parentToolCallId)
                    return { block: true, reason: 'nested tool parent is closed' };
                  const decision = await call({
                    type: 'authorize_tool',
                    name: event.toolName,
                    args,
                    ...(parentToolCallId ? { parentToolCallId } : {}),
                  });
                  if (decision.type !== 'tool_authorization' || !decision.ok)
                    return {
                      block: true,
                      reason:
                        decision.type === 'tool_authorization'
                          ? (decision.reason ?? 'Corral refused this tool call')
                          : 'Corral refused this tool call',
                    };
                  authorized.set(event.toolCallId, {
                    toolCallId: decision.toolCallId,
                    argsHash: hashOf(args),
                  });
                  return undefined;
                } catch {
                  return { block: true, reason: 'Corral authorization failed' };
                }
              });
            },
          },
        ],
        extensionsOverride: (base) => {
          const ours = base.extensions.filter((e) => e.path === '<inline:corral>');
          const rest = base.extensions.filter((e) => e.path !== '<inline:corral>');
          for (const extension of rest) wrapExtension(extension);
          return { ...base, extensions: [...rest, ...ours] };
        },
      });
      failureCode = 'extension_load_failed';
      await loader.reload();
      if (loader.getExtensions().errors.length) throw new Error('extension failed to load');
      failureCode = 'sdk_start_failed';
      ({ session } = await createAgentSession({
        cwd,
        agentDir,
        model: proxyModel,
        thinkingLevel: 'off',
        modelRuntime: runtime,
        resourceLoader: loader,
        noTools: 'builtin',
        customTools,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager: settings,
      }));
      const extensionRuntime = loader.getExtensions().runtime;
      const refreshTools = extensionRuntime.refreshTools;
      extensionRuntime.refreshTools = () => {
        try {
          for (const [name, descriptor] of descriptors)
            if (descriptor.source !== 'corral') {
              descriptors.delete(name);
              schemas.delete(name);
            }
          for (const extension of loader.getExtensions().extensions)
            if (extension.path !== '<inline:corral>') wrapExtension(extension);
          refreshTools();
          publishRegistry();
        } catch (error) {
          requiredExtensionFailed = true;
          throw error;
        }
      };
      const uiContext = extensionUi(
        session.extensionRunner.getUIContext(),
        async (request, signal) => {
          if (cancelled || signal?.aborted) return { status: 'cancelled' };
          const requestId = `req_${++nextRequest}`;
          const reply = new Promise<Reply>((resolve) => waiting.set(requestId, resolve));
          const abort = () => send({ type: 'ui_cancel', requestId });
          signal?.addEventListener('abort', abort, { once: true });
          try {
            send({ type: 'ui_request', requestId, request });
            const result = await reply;
            if (result.type !== 'ui_answer') throw new Error('extension UI request refused');
            return result.result;
          } finally {
            signal?.removeEventListener('abort', abort);
          }
        },
        (notice) => {
          notifications = notifications.then(() => ack({ type: 'ui_notice', notice }));
          // Preserve the rejection for the next session boundary without an unhandled promise.
          void notifications.catch(() => {});
        },
      );
      failureCode = 'extension_load_failed';
      const requiredPaths = new Set(
        start.resources.extensions
          .filter((extension) =>
            start.harness.resources.some(
              (resource) =>
                resource.kind === 'extension' &&
                resource.hash === extension.hash &&
                resource.required,
            ),
          )
          .map((extension) => resolve(extension.path)),
      );
      await session.bindExtensions({
        uiContext,
        onError: (error) => {
          if (requiredPaths.has(resolve(error.extensionPath))) requiredExtensionFailed = true;
        },
      });
      await notifications;
      if (requiredExtensionFailed) throw new Error('required extension initialization failed');
      session.setActiveToolsByName(
        [
          ...new Set([
            ...session.getActiveToolNames(),
            ...(start.harness.allowedTools.includes('codemode') ? ['codemode'] : []),
          ]),
        ].filter((name) => start.harness.allowedTools.includes(name)),
      );
      failureCode = 'policy_denied';
      // A registered foreign provider could bypass the permit. Never select it implicitly.
      if (session.model?.provider !== 'corral') throw new Error('extension replaced the model');
      const diagnostics = runtime.getRegisteredProviderIds().some((id) => id !== 'corral')
        ? ['unmanaged_provider_registered']
        : [];
      const commands = session.extensionRunner.getRegisteredCommands().map((command) => {
        const resource = start.resources.extensions.find(
          (extension) => resolve(extension.path) === resolve(command.sourceInfo.path),
        );
        if (!resource) throw new Error('unbound extension command');
        const packageName = resource.source
          .slice('extension:'.length, resource.source.lastIndexOf('@'))
          .replace(/^@/, '')
          .replaceAll('/', '-');
        return HarnessCommand.parse({
          name: command.name,
          invocation: command.invocationName,
          alias: `${packageName}:${command.name}`,
          source: resource.source,
          description: command.description ?? '',
          condition: 'startup',
        });
      });
      if (new Set(commands.map((command) => command.alias)).size !== commands.length)
        throw new Error('ambiguous extension command alias');
      const initialTools = [...descriptors.values()];
      reportedRegistryHash = hashOf(initialTools);
      await ack({
        type: 'harness_report',
        report: {
          ok: true,
          snapshotHash: start.harness.snapshotHash,
          tools: initialTools,
          diagnostics,
          ...(commands.length ? { commands } : {}),
        },
      });
      reported = true;
      publishRegistry();
      let settled = false;
      session.subscribe((event) => {
        if (event.type === 'agent_start') settled = false;
        if (event.type === 'agent_settled') settled = true;
        if (event.type === 'auto_retry_start') purpose = 'retry';
        if (event.type === 'compaction_start') purpose = 'compaction';
        if (event.type === 'auto_retry_end' || event.type === 'compaction_end') purpose = 'turn';
      });
      for (const command of start.resources.startupCommands) {
        const match = /^\/([\w][\w:.-]*)([\s\S]*)$/.exec(command);
        if (!match || (match[2] && !/^\s/.test(match[2])))
          throw new Error('unsupported startup command');
        const selected =
          commands.find((item) => item.alias === match[1]) ??
          commands.find((item) => item.invocation === match[1]);
        if (!selected || ['reload', 'login', 'logout'].includes(selected.invocation))
          throw new Error('unknown or unsupported startup command');
        await session.prompt(`/${selected.invocation}${match[2]}`);
      }
      if (cancelled) throw new Error('cancelled');
      start = {
        ...start,
        inputs: start.inputs.map((input) =>
          input.name === 'brief' && input.artifactVersionId === null
            ? {
                ...input,
                text: input.text.replace(
                  /^\/skill:([^\s]+)(?:[ \t]+(.*))?$/gm,
                  (_match, name: string, rest: string | undefined) => {
                    const skill = start.resources.skills.find((skill) => skill.name === name);
                    if (!skill?.content.trim()) throw new Error('explicit skill is not available');
                    return `Corral skill (${name}):\n${skill.content}\n\n${rest ?? ''}`;
                  },
                ),
              }
            : input,
        ),
      };
      await session.prompt(
        [userPrompt(start), ...[...directives.values()].map(directiveText)].join('\n\n'),
      );
      await session.waitForIdle();
      await notifications;
      await requests;
      if (requiredExtensionFailed) throw new Error('required extension failed');
      if (!settled) throw new Error('SDK did not settle');
      const last = [...session.messages]
        .reverse()
        .find((m): m is AssistantMessage => m.role === 'assistant');
      await shutdown();
      await registryUpdates;
      send({
        type: 'settled',
        outcome:
          cancelled || last?.stopReason === 'aborted'
            ? 'cancelled'
            : !last || last.stopReason === 'error'
              ? 'failed'
              : 'succeeded',
      });
    } catch {
      try {
        await shutdown();
      } catch {
        /* Process shutdown remains the final cleanup fence. */
      }
      if (!reported && !cancelled) {
        try {
          await ack({
            type: 'harness_report',
            report: { ok: false, snapshotHash: start.harness.snapshotHash, code: failureCode },
          });
        } catch {
          /* The host may already have closed the execution. */
        }
      }
      send({
        type: 'settled',
        outcome: cancelled ? 'cancelled' : 'failed',
        error: 'harness execution failed',
      });
    } finally {
      try {
        await shutdown();
      } catch {
        /* The worker exit closes remaining owned resources. */
      }
      session?.dispose();
      waiting.clear();
      port.kill();
    }
  }
}

function describeTool(tool: ToolDefinition, source: string): ToolDescriptor {
  const annotations = tool.annotations;
  return ToolDescriptor.parse({
    source,
    name: tool.name,
    schemaHash: hashOf(cleanJson(tool.parameters)),
    ...(annotations ? { annotations } : {}),
    exposure: tool.exposure ?? 'direct',
    sideEffect:
      source === 'corral' && ['run_check', 'lsp_query'].includes(tool.name)
        ? 'external'
        : source === 'corral' &&
            ['edit', 'write', 'write_file', 'delete_file', 'move_file'].includes(tool.name)
          ? 'workspace'
          : annotations?.readOnlyHint === true && annotations.openWorldHint === false
            ? 'none'
            : 'unknown',
  });
}

function requestRecord(
  context: Context,
  purpose: ModelRequestRecord['purpose'],
  directives: Map<string, DeliveredDirective>,
): ModelRequestRecord {
  const value = cleanJson(context);
  const serialized = canonicalJson(value);
  const text = context.messages
    .flatMap((message) =>
      message.role !== 'user'
        ? []
        : typeof message.content === 'string'
          ? [message.content]
          : message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])),
    )
    .join('\n');
  const sections: ModelRequestRecord['sections'] = [];
  for (const message of context.messages) {
    if (message.role !== 'system') continue;
    for (const [name, content] of Object.entries(message.sections ?? {})) {
      const body = canonicalJson(cleanJson(content));
      sections.push({
        name: /^[a-zA-Z][\w-]{0,63}$/.test(name) ? name : `section_${sections.length}`,
        source: name.startsWith('skill_') ? 'skill' : 'runtime',
        hash: hashOf(cleanJson(content)),
        bytes: Buffer.byteLength(body),
      });
    }
  }
  return ModelRequestRecord.parse({
    purpose,
    directiveIds: [...directives.values()]
      .filter((d) => text.includes(directiveText(d)))
      .map((d) => d.directiveId),
    contextHash: hashOf(value),
    contextBytes: Buffer.byteLength(serialized),
    sections,
  });
}

function failedMessage(stopReason: 'error' | 'aborted', timestamp: number): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'corral-proxy',
    provider: 'corral',
    model: 'unavailable',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    errorMessage: 'Corral request refused or interrupted',
    timestamp,
  };
}
