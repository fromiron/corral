import { createHash } from 'node:crypto';
import type { DeliveredDirective } from '@corral/contracts';
import { canonicalJson, type ReasoningResolution } from '@corral/contracts';
import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, Model } from '@earendil-works/pi-ai';
import type { Channel } from './channel.ts';
import type { EndpointSpec } from './endpoint.ts';
import {
  HostFrame,
  LEGACY_PROTOCOL_VERSION as PROTOCOL_VERSION,
  type StartFrame,
} from './protocol.ts';
import { assertReasoningCapabilities, reasoningRequest, verifyReasoningWire } from './reasoning.ts';
import { requestReasoningInput } from './reasoning-input.ts';
import { normalizeUsage } from './usage.ts';
import {
  directiveText,
  parametersOf,
  safe,
  systemPrompt,
  TOOL_TEXT,
  textOf,
  userPrompt,
} from './worker-tools.ts';

// One Pi execution in a worker (C-017–C-019). The worker owns a Pi Agent and a provider
// connection, nothing else: every model request asks the host for a permit first (the host
// fixes the context snapshot and attaches directives), every tool call asks the host to
// authorize and then to execute it, and the result is only proposed by `settled`.
// Pi's own tool events are not reported as facts (C-052 rule 1).

export interface WorkerDeps {
  /** pi-ai streaming, e.g. `models.streamSimple`; tests pass the faux provider. */
  streamFn: StreamFn;
  /** `endpoint` is the definition of an OpenAI-compatible endpoint (CR-005), when it is one. */
  resolveModel(
    provider: string,
    modelId: string,
    endpoint?: EndpointSpec,
  ): Model<string> | undefined;
}

type Reply = Exclude<HostFrame, StartFrame | { type: 'cancel' | 'directive' }>;

export function runWorker(port: Channel, deps: WorkerDeps): void {
  let executionId: string | null = null;
  let agent: Agent | null = null;
  let cancelled = false;
  let nextRequest = 0;
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
    if (frame.type === 'cancel') {
      cancelled = true;
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
    const settle = (outcome: 'succeeded' | 'failed' | 'cancelled', error?: string) => {
      port.send({ type: 'settled', ...head, outcome, ...(error ? { error: safe(error) } : {}) });
      port.kill();
    };
    const call = (frame: Record<string, unknown>) =>
      new Promise<Reply>((resolve) => {
        const requestId = `req_${++nextRequest}`;
        waiting.set(requestId, resolve);
        port.send({ ...frame, ...head, requestId });
      });

    const model = deps.resolveModel(
      start.model.provider,
      start.model.modelId,
      start.model.endpoint,
    );
    // A keyless endpoint never gets a key, whatever a permit carries (CR-005 §4).
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

    let permit: {
      modelCallId: string;
      apiKey: string | null;
      maxOutputTokens: number;
      reasoning?: ReasoningResolution;
    } | null = null;
    let chunk = 0;
    const authorized = new Map<string, string>();

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
        return {
          content: [{ type: 'text', text: JSON.stringify(reply.result ?? {}) }],
          details: reply.result ?? {},
        };
      },
    }));

    agent = new Agent({
      initialState: { model, systemPrompt: systemPrompt(start), tools },
      // Each request carries the token and output cap from its own permit.
      streamFn: (m, context, options) => {
        const active = permit;
        const chosen = reasoningRequest(m, options, active?.reasoning);
        const stream = deps.streamFn(chosen.model, context, {
          ...chosen.options,
          ...(keyOf(permit?.apiKey) ? { apiKey: keyOf(permit?.apiKey) } : {}),
          ...(permit ? { maxTokens: permit.maxOutputTokens } : {}),
          onPayload: async (payload, payloadModel) => {
            const actual = (await options?.onPayload?.(payload, payloadModel)) ?? payload;
            const wire = verifyReasoningWire(m, actual, active?.reasoning);
            if (active) {
              const serialized = canonicalJson(JSON.parse(JSON.stringify(actual)));
              const reply = await call({
                type: 'request_record',
                modelCallId: active.modelCallId,
                payloadHash: createHash('sha256').update(serialized).digest('hex'),
                payloadBytes: Buffer.byteLength(serialized),
                ...(wire ? { reasoning: wire } : {}),
              });
              if (reply.type !== 'ack' || cancelled) throw new Error('provider payload refused');
            }
            return actual;
          },
        });
        if (permit)
          port.send({ type: 'request_dispatched', ...head, modelCallId: permit.modelCallId });
        return stream;
      },
      getApiKey: () => keyOf(permit?.apiKey),
      toolExecution: 'sequential',
      prepareRequest: async ({ context }) => {
        let preparedContext = context;
        const prepare = async () => {
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
          return call({
            type: 'prepare_request',
            reasoningInput: requestReasoningInput(preparedContext, 'turn', assignment, [
              ...directives.keys(),
            ]),
          });
        };
        let reply = await prepare();
        for (let retries = 0; reply.type === 'reprepare' && retries < 2; retries++) {
          for (const directive of reply.directives)
            directives.set(directive.directiveId, directive);
          reply = await prepare();
        }
        if (reply.type !== 'permit' || cancelled) throw new Error('the request was refused');
        permit = {
          modelCallId: reply.modelCallId,
          apiKey: reply.apiKey,
          maxOutputTokens: reply.maxOutputTokens,
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
        return preparedContext === context ? undefined : { context: preparedContext };
      },
      beforeToolCall: async ({ toolCall }) => {
        const args = { ...((toolCall.arguments ?? {}) as Record<string, unknown>) };
        // The question being answered is this execution's, never the model's choice.
        if (toolCall.name === 'reply' && start.assignment.kind === 'question') {
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
      await agent.prompt(userPrompt(start));
    } catch (error) {
      settle(cancelled ? 'cancelled' : 'failed', String(error));
      return;
    }
    const last = [...agent.state.messages]
      .reverse()
      .find((m): m is AssistantMessage => m.role === 'assistant');
    if (cancelled || last?.stopReason === 'aborted') settle('cancelled');
    else if (last?.stopReason === 'error') settle('failed', last.errorMessage ?? 'model error');
    else settle('succeeded');
  }
}
