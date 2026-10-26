import { createHash } from 'node:crypto';
import type { DeliveredDirective } from '@corral/contracts';
import { canonicalJson, type ReasoningResolution } from '@corral/contracts';
import { accountModelStream } from '@corral/pi-runtime-port';
import {
  automaticCompactionThresholdFor,
  contextBudgetLimitsFor,
} from '@corral/pi-runtime-port/budget';
import {
  Agent,
  type AgentContext,
  type AgentTool,
  type StreamFn,
} from '@earendil-works/pi-agent-core';
import {
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  normalizeContext,
  type SimpleStreamOptions,
} from '@earendil-works/pi-ai';
import type { Channel } from './channel.ts';
import { inspectContext, reconcileContextUsage } from './context-usage.ts';
import type { EndpointSpec } from './endpoint.ts';
import {
  ContextMeter,
  measureContext,
  pruneToolResults,
  selectCompactableRange,
  summarizeRegion,
} from './ported/dsh/context.ts';
import {
  HostFrame,
  LEGACY_PROTOCOL_VERSION as PROTOCOL_VERSION,
  type StartFrame,
} from './protocol.ts';
import {
  assertReasoningCapabilities,
  reasoningRequest,
  requestOutputCap,
  verifyReasoningWire,
} from './reasoning.ts';
import { requestReasoningInput } from './reasoning-input.ts';
import { providerRequestFence } from './request-fence.ts';
import {
  assertImagePayload,
  assertProtectedPayload,
  checkpointContext,
  conversationMessages,
  missingParentQuestions,
  requestRecord,
  resumedMessages,
  withProtectedContext,
  withRequiredImages,
} from './request-record.ts';
import { managedRetryStream } from './request-retry.ts';
import { corralToolResultContent } from './tool-result-content.ts';
import { normalizeUsage } from './usage.ts';
import {
  directiveText,
  parametersOf,
  parentQuestionsText,
  promptSections,
  replyCompletesAssignment,
  safe,
  systemPrompt,
  TOOL_TEXT,
  textOf,
  userPrompt,
} from './worker-tools.ts';

// One Pi execution in a worker. The worker owns a Pi Agent and a provider
// connection, nothing else: every model request asks the host for a permit first (the host
// fixes the context snapshot and attaches directives), every tool call asks the host to
// authorize and then to execute it, and the result is only proposed by `settled`.
// Pi's own tool events are not reported as facts.

export interface WorkerDeps {
  /** pi-ai streaming, e.g. `models.streamSimple`; tests pass the faux provider. */
  streamFn: StreamFn;
  /** `endpoint` is the definition of an OpenAI-compatible endpoint, when it is one. */
  resolveModel(
    provider: string,
    modelId: string,
    endpoint?: EndpointSpec,
  ): Model<string> | undefined;
}

type Reply = Exclude<HostFrame, StartFrame | { type: 'cancel' | 'directive' | 'compact' }>;

export function runWorker(port: Channel, deps: WorkerDeps): void {
  let executionId: string | null = null;
  let agent: Agent | null = null;
  let cancelled = false;
  const cancellation = new AbortController();
  let nextRequest = 0;
  let pendingCompaction: string | null = null;
  const directives = new Map<string, DeliveredDirective>();
  const waiting = new Map<string, (reply: Reply) => void>();

  port.onFrame((raw) => {
    const parsed = HostFrame.safeParse(raw);
    if (!parsed.success) {
      port.kill();
      return;
    }
    const frame = parsed.data;
    if (frame.type === 'start') {
      if (executionId === null) void execute(frame);
      return;
    }
    if (frame.executionId !== executionId) return;
    if (frame.type === 'compact') {
      pendingCompaction = frame.commandId;
      return;
    }
    if (frame.type === 'cancel') {
      cancelled = true;
      cancellation.abort();
      for (const [requestId, resolve] of waiting)
        resolve({
          type: 'refused',
          protocolVersion: PROTOCOL_VERSION,
          executionId,
          requestId,
          reason: 'cancelled',
        });
      waiting.clear();
      agent?.abort();
      return;
    }
    if (frame.type === 'directive') {
      directives.set(frame.directiveId, frame);
      return;
    }
    waiting.get(frame.requestId)?.(frame);
    waiting.delete(frame.requestId);
  });
  port.send({ type: 'ready', protocolVersion: PROTOCOL_VERSION });

  async function execute(start: StartFrame) {
    executionId = start.executionId;
    const head = { protocolVersion: PROTOCOL_VERSION, executionId: start.executionId };
    const settle = (
      outcome: 'succeeded' | 'failed' | 'cancelled',
      error?: string,
      finalTextModelCallId?: string,
    ) => {
      port.send({
        type: 'settled',
        ...head,
        outcome,
        ...(error ? { error: safe(error) } : {}),
        ...(finalTextModelCallId ? { finalTextModelCallId } : {}),
      });
      port.kill();
    };
    const call = (frame: Record<string, unknown>) =>
      new Promise<Reply>((resolve) => {
        const requestId = `req_${++nextRequest}`;
        waiting.set(requestId, resolve);
        port.send({ ...frame, ...head, requestId });
      });

    const catalogModel = deps.resolveModel(
      start.model.provider,
      start.model.modelId,
      start.model.endpoint,
    );
    const model = catalogModel
      ? {
          ...catalogModel,
          ...(start.model.contextWindow !== undefined
            ? { contextWindow: start.model.contextWindow }
            : {}),
        }
      : undefined;
    // A keyless endpoint never gets a key, whatever a permit carries.
    const keyless = start.model.endpoint?.keyless === true;
    const keyOf = (apiKey: string | null | undefined) =>
      keyless ? undefined : (apiKey ?? undefined);
    if (!model) {
      settle('failed', `model ${start.model.provider}/${start.model.modelId} is not available`);
      return;
    }

    try {
      assertReasoningCapabilities(model, start.reasoningCapabilities);
    } catch {
      settle('failed', 'model reasoning capabilities changed');
      return;
    }

    type ModelPermit = {
      modelCallId: string;
      apiKey: string | null;
      maxOutputTokens: number;
      reasoning?: ReasoningResolution;
      sessionId?: string;
      cacheRetention?: 'none' | 'short' | 'long';
    };
    let permit: ModelPermit | null = null;
    let protectedSections: ReturnType<typeof promptSections>;
    try {
      protectedSections = promptSections(start);
    } catch {
      settle('failed', 'protected prompt limit exceeded');
      return;
    }
    let completionAccepted = false;
    let attemptedTools = false;
    let finalTextModelCallId: string | undefined;
    const meter = new ContextMeter();
    let lastPrepared: Context | undefined;
    let measuredContext: ReturnType<typeof inspectContext> | null = null;
    let chunk = 0;
    const authorized = new Map<string, string>();
    let logicalRequests = 0;
    let logicalRequestId = '';

    const tools: AgentTool[] = start.tools.map((name) => ({
      name,
      label: name,
      description: TOOL_TEXT[name],
      parameters: parametersOf(name, start),
      executionMode: 'sequential',
      // Runs only after the host authorized this call; the host records tool.started.
      execute: async (piCallId) => {
        const toolCallId = authorized.get(piCallId);
        if (!toolCallId) throw new Error('this tool call was not authorized');
        const reply = await call({ type: 'execute_tool', toolCallId });
        if (reply.type !== 'tool_result' || !reply.ok) {
          throw new Error(reply.type === 'tool_result' ? (reply.reason ?? 'refused') : 'refused');
        }
        // Only the Coordinator's successful tool reply establishes completion.
        if (
          name === 'submit_result' ||
          (name === 'reply' && replyCompletesAssignment(start.assignment, reply.result ?? {}))
        )
          completionAccepted = true;
        return corralToolResultContent(name, reply.result ?? {});
      },
    }));

    let forceCompaction = false;
    const prepareRequest = async (context: AgentContext, retryIndex = 0) => {
      if (!retryIndex) logicalRequestId = `request_${++logicalRequests}`;
      let preparedContext = context;
      const prepare = async () => {
        const state = await call({ type: 'get_protected_context' });
        if (state.type !== 'protected_context') throw new Error('protected context refused');
        if (state.value) {
          const protectedState = withProtectedContext(preparedContext, state.value);
          preparedContext = protectedState.context;
          protectedSections = [
            ...protectedSections.filter((section) => section.name !== 'corral_state'),
            protectedState.section,
          ];
        }
        const present = JSON.stringify(preparedContext.messages);
        const missing = [...directives.values()].filter(
          (d) => !present.includes(JSON.stringify(directiveText([d])).slice(1, -1)),
        );
        if (missing.length)
          preparedContext = {
            ...preparedContext,
            messages: [
              ...preparedContext.messages,
              { role: 'user', content: directiveText(missing), timestamp: Date.now() },
            ],
          };
        const assignment =
          start.assignment.kind === 'delegated'
            ? start.assignment.brief
            : start.assignment.kind === 'question'
              ? start.assignment.body
              : '';
        const saved = await call({
          type: 'checkpoint_context',
          value: checkpointContext(preparedContext, 'pi-core'),
        });
        if (saved.type !== 'runtime_checkpoint') throw new Error('runtime checkpoint refused');
        preparedContext = pruneToolResults(preparedContext);
        const budget = contextBudgetLimitsFor(model);
        const hardLimit =
          model.contextWindow - (start.compaction?.reserveTokens ?? budget.requestHeadroom);
        const commandId = pendingCompaction;
        pendingCompaction = null;
        const beforeHash = createHash('sha256')
          .update(canonicalJson(JSON.parse(JSON.stringify(preparedContext.messages))))
          .digest('hex');
        const summaryCalls: string[] = [];
        if (commandId)
          await call({
            type: 'compaction_report',
            report: { commandId, phase: 'started', beforeHash, modelCallIds: [] },
          });
        try {
          if (
            commandId ||
            forceCompaction ||
            meter.measure(preparedContext, model).tokens >
              automaticCompactionThresholdFor({ hardLimit })
          ) {
            const region = selectCompactableRange(
              preparedContext.messages,
              forceCompaction ? 0 : (start.compaction?.keepRecentTokens ?? budget.keepRecentTokens),
            );
            forceCompaction = false;
            if (!region) throw new Error('context cannot fit without dropping required input');
            const summaryRequestId = `request_${++logicalRequests}`;
            const compacted = await summarizeRegion(
              normalizeContext({ messages: preparedContext.messages as Message[] }),
              region,
              (summary) =>
                managedRetryStream({
                  model,
                  signal: cancellation.signal,
                  open: async (retryIndex) => {
                    const record = requestRecord(
                      summary,
                      'compaction',
                      'pi-core',
                      [],
                      protectedSections,
                    );
                    const grant = await call({
                      type: 'prepare_request',
                      logicalRequestId: summaryRequestId,
                      retryIndex,
                      record,
                      reasoningInput: requestReasoningInput(summary, 'compaction', '', []),
                    });
                    if (grant.type !== 'permit' || cancelled) throw new Error('compaction refused');
                    summaryCalls.push(grant.modelCallId);
                    try {
                      return accountModelStream(
                        await sendRequest(
                          grant,
                          model,
                          summary,
                          { signal: cancellation.signal },
                          false,
                        ),
                        (response) => {
                          port.send({
                            type: 'observe',
                            ...head,
                            modelCallId: grant.modelCallId,
                            text: textOf(response),
                            ...normalizeUsage(response),
                          });
                        },
                      );
                    } catch (error) {
                      port.send({
                        type: 'observe',
                        ...head,
                        modelCallId: grant.modelCallId,
                        text: '',
                        usage: {
                          inputTokens: null,
                          outputTokens: null,
                          cachedInputTokens: null,
                          reasoningTokens: null,
                        },
                        rawUsage: null,
                      });
                      throw error;
                    }
                  },
                }).result(),
              Date.now,
            );
            const currentState = await call({ type: 'get_protected_context' });
            if (currentState.type !== 'protected_context')
              throw new Error('protected context refused');
            if (currentState.value?.hash !== state.value?.hash) {
              if (commandId)
                await call({
                  type: 'compaction_report',
                  report: {
                    commandId,
                    phase: 'failed',
                    beforeHash,
                    afterHash: beforeHash,
                    modelCallIds: summaryCalls,
                  },
                });
              return { type: 'reprepare' as const, directives: [] };
            }
            let restored = withRequiredImages(compacted.context, start.images);
            if (state.value) restored = withProtectedContext(restored, state.value).context;
            if (meter.measure(restored, model).tokens >= hardLimit)
              throw new Error('compacted context still exceeds model capacity');
            preparedContext = { ...preparedContext, messages: restored.messages };
            if (commandId)
              await call({
                type: 'compaction_report',
                report: {
                  commandId,
                  phase: 'completed',
                  beforeHash,
                  afterHash: createHash('sha256')
                    .update(canonicalJson(JSON.parse(JSON.stringify(preparedContext.messages))))
                    .digest('hex'),
                  modelCallIds: summaryCalls,
                },
              });
          }
        } catch (error) {
          if (!commandId) throw error;
          if (!cancelled)
            await call({
              type: 'compaction_report',
              report: {
                commandId,
                phase: 'failed',
                beforeHash,
                afterHash: beforeHash,
                modelCallIds: summaryCalls,
              },
            });
        }
        lastPrepared = normalizeContext({ messages: preparedContext.messages as Message[] });
        measuredContext = inspectContext(preparedContext);
        return call({
          type: 'prepare_request',
          logicalRequestId,
          retryIndex,
          record: requestRecord(
            preparedContext,
            retryIndex ? 'retry' : 'turn',
            'pi-core',
            [...directives.values()].map((d) => ({
              directiveId: d.directiveId,
              text: directiveText([d]),
            })),
            protectedSections,
            { usage: measuredContext.usage },
          ),
          reasoningInput: requestReasoningInput(preparedContext, 'turn', assignment, [
            ...directives.keys(),
          ]),
        });
      };
      let reply = await prepare();
      for (let retries = 0; reply.type === 'reprepare' && retries < 2; retries++) {
        for (const directive of reply.directives) directives.set(directive.directiveId, directive);
        reply = await prepare();
      }
      if (reply.type !== 'permit' || cancelled) throw new Error('the request was refused');
      permit = {
        modelCallId: reply.modelCallId,
        apiKey: reply.apiKey,
        maxOutputTokens: reply.maxOutputTokens,
        sessionId: reply.sessionId,
        cacheRetention: reply.cacheRetention,
        ...(reply.reasoning ? { reasoning: reply.reasoning } : {}),
      };
      chunk = 0;
      // Older hosts may deliver a directive only with the permit (compatibility path).
      const present = JSON.stringify(preparedContext.messages);
      const missing = reply.directives.filter(
        (d) => !present.includes(JSON.stringify(directiveText([d])).slice(1, -1)),
      );
      for (const directive of reply.directives) directives.set(directive.directiveId, directive);
      if (missing.length)
        preparedContext = {
          ...preparedContext,
          messages: [
            ...preparedContext.messages,
            { role: 'user', content: directiveText(missing), timestamp: Date.now() },
          ],
        };
      const parentQuestions = missingParentQuestions(
        reply.parentQuestions ?? [],
        protectedSections,
      );
      if (parentQuestions.length)
        preparedContext = {
          ...preparedContext,
          messages: [
            ...preparedContext.messages,
            {
              role: 'user',
              content: parentQuestionsText(parentQuestions),
              timestamp: Date.now(),
            },
          ],
        };
      return preparedContext === context ? undefined : { context: preparedContext };
    };

    function sendRequest(
      active: ModelPermit,
      m: Model<string>,
      context: Context,
      options?: SimpleStreamOptions,
      requireImages = true,
    ): ReturnType<StreamFn> {
      const measured = inspectContext(context);
      if (requireImages) lastPrepared = context;
      const fence = providerRequestFence(m, undefined, options?.signal);
      const chosen = reasoningRequest(m, options, active?.reasoning);
      const outputCap = active ? requestOutputCap(chosen.model, active.maxOutputTokens) : undefined;
      const stream = deps.streamFn(chosen.model, normalizeContext(context), {
        ...chosen.options,
        maxRetries: 0,
        sessionId: active?.sessionId ?? options?.sessionId,
        cacheRetention: active?.cacheRetention ?? options?.cacheRetention,
        ...(fence ? { fetch: fence.fetch, transport: 'sse' as const } : {}),
        ...(keyOf(active.apiKey) ? { apiKey: keyOf(active.apiKey) } : {}),
        ...(outputCap ? { maxTokens: outputCap } : {}),
        onPayload: async (payload, payloadModel) => {
          const actual = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
          const serialized = canonicalJson(JSON.parse(JSON.stringify(actual)));
          assertProtectedPayload(actual, protectedSections, serialized);
          if (requireImages) assertImagePayload(actual, start.images);
          const wire = verifyReasoningWire(
            m,
            actual,
            active?.reasoning,
            outputCap,
            start.model.auth,
          );
          if (active) {
            const contextUsage = reconcileContextUsage(measured.usage, measured.probes, serialized);
            const reply = await call({
              type: 'request_record',
              modelCallId: active.modelCallId,
              payloadHash: createHash('sha256').update(serialized).digest('hex'),
              payloadBytes: Buffer.byteLength(serialized),
              skills: [],
              ...(contextUsage ? { contextUsage } : {}),
              ...(wire ? { reasoning: wire } : {}),
            });
            if (reply.type !== 'ack' || cancelled) throw new Error('provider payload refused');
          }
          fence?.approve(actual);
          return actual;
        },
      });
      port.send({ type: 'request_dispatched', ...head, modelCallId: active.modelCallId });
      return stream;
    }

    agent = new Agent({
      initialState: {
        model,
        systemPrompt: systemPrompt(start),
        tools,
        messages: [
          ...conversationMessages(start.conversation),
          ...resumedMessages(start.resumeContext, Boolean(start.meeting)),
        ],
      },
      // Each request carries the token and output cap from its own permit.
      streamFn: (m, context, options) => {
        let current = context;
        return managedRetryStream({
          model: m,
          signal: options?.signal ?? cancellation.signal,
          onContextOverflow: () => {
            forceCompaction = true;
            return true;
          },
          beforeRetry: (message) => {
            if (permit)
              port.send({
                type: 'observe',
                ...head,
                modelCallId: permit.modelCallId,
                text: textOf(message),
                ...normalizeUsage(message),
              });
          },
          open: async (attempt) => {
            if (attempt) {
              const next = await prepareRequest({ messages: current.messages, tools }, attempt);
              if (next)
                current = normalizeContext({ messages: next.context.messages as Message[] });
            }
            if (!permit) throw new Error('request has no permit');
            return await sendRequest(permit, m, current, options);
          },
        });
      },
      getApiKey: () => keyOf(permit?.apiKey),
      toolExecution: 'sequential',
      finishTurn: () => (completionAccepted ? { action: 'end' } : undefined),
      prepareRequest: ({ context }) => prepareRequest(context),
      beforeToolCall: async ({ toolCall }) => {
        const args = { ...((toolCall.arguments ?? {}) as Record<string, unknown>) };
        // Only the omitted legacy ID defaults to the assigned question. Explicit
        // child IDs remain subject to the Coordinator's current-execution check.
        if (
          toolCall.name === 'reply' &&
          start.assignment.kind === 'question' &&
          args.questionId === undefined
        ) {
          args.questionId = start.assignment.questionId;
        }
        const reply = await call({ type: 'authorize_tool', name: toolCall.name, args });
        if (reply.type !== 'tool_authorization' || !reply.ok) {
          return {
            block: true,
            reason: reply.type === 'tool_authorization' ? (reply.reason ?? 'refused') : 'refused',
          };
        }
        authorized.set(toolCall.id, reply.toolCallId);
        return undefined;
      },
    });

    agent.subscribe((event) => {
      if (!permit) return;
      if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
        port.send({
          type: 'stream',
          ...head,
          modelCallId: permit.modelCallId,
          chunkIndex: chunk++,
          text: event.assistantMessageEvent.delta,
        });
      }
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const message = event.message as AssistantMessage;
        if (lastPrepared) meter.observe(lastPrepared, model, message);
        attemptedTools ||= message.content.some((part) => part.type === 'toolCall');
        // Meetings answer before any tool; a final-reply role may use tools first.
        finalTextModelCallId =
          message.stopReason === 'stop' &&
          textOf(message).trim() &&
          (start.role.answer === 'final_reply' || !attemptedTools)
            ? permit.modelCallId
            : undefined;
        const { usage, rawUsage } = normalizeUsage(message);
        port.send({
          type: 'observe',
          ...head,
          modelCallId: permit.modelCallId,
          text: textOf(message),
          usage,
          rawUsage,
        });
      }
    });

    try {
      await agent.prompt(
        userPrompt(start),
        start.images?.map((image) => ({ type: 'image', data: image.data, mimeType: image.mime })),
      );
    } catch (error) {
      settle(cancelled ? 'cancelled' : 'failed', String(error));
      return;
    }
    const last = [...agent.state.messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === 'assistant');
    if (!cancelled && !completionAccepted && last?.stopReason === 'stop' && lastPrepared)
      await call({
        type: 'checkpoint_context',
        value: checkpointContext({ messages: [...lastPrepared.messages, last] }, 'pi-core'),
      });
    if (pendingCompaction && !cancelled)
      await call({
        type: 'compaction_report',
        report: { commandId: pendingCompaction, phase: 'skipped', modelCallIds: [] },
      });
    if (cancelled || last?.stopReason === 'aborted') settle('cancelled');
    else if (last?.stopReason === 'error') settle('failed', last.errorMessage ?? 'model error');
    else settle('succeeded', undefined, finalTextModelCallId);
  }
}
