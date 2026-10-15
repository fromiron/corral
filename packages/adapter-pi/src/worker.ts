import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { type AssistantMessage, type Model, Type } from '@earendil-works/pi-ai';
import type { Channel } from './channel.ts';
import { HostFrame, PROTOCOL_VERSION, type StartFrame } from './protocol.ts';
import { normalizeUsage } from './usage.ts';

// One Pi execution in a worker (C-017–C-019). The worker owns a Pi Agent and a provider
// connection, nothing else: every model request asks the host for a permit first (the host
// fixes the context snapshot and attaches directives), every tool call asks the host to
// authorize and then to execute it, and the result is only proposed by `settled`.
// Pi's own tool events are not reported as facts (C-052 rule 1).

export interface WorkerDeps {
  /** pi-ai streaming, e.g. `models.streamSimple`; tests pass the faux provider. */
  streamFn: StreamFn;
  resolveModel(provider: string, modelId: string): Model<string> | undefined;
}

type Reply = Exclude<HostFrame, StartFrame | { type: 'cancel' }>;

const TOOL_TEXT: Record<StartFrame['tools'][number], string> = {
  write_artifact:
    'Save your output text as a new immutable version. Returns its artifactVersionId.',
  submit_result: 'Submit the versions that complete your task. Call it once, after write_artifact.',
};

export function runWorker(port: Channel, deps: WorkerDeps): void {
  let executionId: string | null = null;
  let agent: Agent | null = null;
  let cancelled = false;
  let nextRequest = 0;
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
      agent?.abort();
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

    const model = deps.resolveModel(start.model.provider, start.model.modelId);
    if (!model) {
      settle('failed', `model ${start.model.provider}/${start.model.modelId} is not available`);
      return;
    }

    let permit: { modelCallId: string; apiKey: string | null; maxOutputTokens: number } | null =
      null;
    let chunk = 0;
    const authorized = new Map<string, string>();

    const tools: AgentTool[] = start.tools.map((name) => ({
      name,
      label: name,
      description: TOOL_TEXT[name],
      parameters:
        name === 'write_artifact'
          ? Type.Object({ text: Type.String() })
          : Type.Object({ artifactVersionIds: Type.Array(Type.String(), { minItems: 1 }) }),
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
      streamFn: (m, context, options) =>
        deps.streamFn(m, context, {
          ...options,
          ...(permit?.apiKey ? { apiKey: permit.apiKey } : {}),
          ...(permit ? { maxTokens: permit.maxOutputTokens } : {}),
        }),
      getApiKey: () => permit?.apiKey ?? undefined,
      toolExecution: 'sequential',
      prepareRequest: async ({ context }) => {
        const reply = await call({ type: 'prepare_request' });
        if (reply.type !== 'permit') {
          throw new Error(reply.type === 'refused' ? reply.reason : 'the request was refused');
        }
        permit = {
          modelCallId: reply.modelCallId,
          apiKey: reply.apiKey,
          maxOutputTokens: reply.maxOutputTokens,
        };
        chunk = 0;
        if (reply.directives.length === 0) return undefined;
        // Directives fixed into this request's snapshot, and only those (C-052 rule 3).
        const directive = {
          role: 'user' as const,
          content: [{ type: 'text' as const, text: directiveText(reply.directives) }],
          timestamp: Date.now(),
        };
        return { context: { ...context, messages: [...context.messages, directive] } };
      },
      beforeToolCall: async ({ toolCall }) => {
        const reply = await call({
          type: 'authorize_tool',
          name: toolCall.name,
          args: (toolCall.arguments ?? {}) as Record<string, unknown>,
        });
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

function systemPrompt(start: StartFrame): string {
  return [
    start.role.prompt,
    '',
    `You are ${start.role.name}, one step of a Corral team. Your output contract is "${start.role.outputContract}".`,
    'When your work is complete, call write_artifact with the full output text, then call submit_result with the artifactVersionId it returned.',
    'Instructions from the person supervising this run may arrive during your work; follow them.',
  ].join('\n');
}

function userPrompt(start: StartFrame): string {
  return start.inputs.map((input) => `## ${input.name}\n\n${input.text}`).join('\n\n');
}

function directiveText(directives: { directiveId: string; text: string }[]): string {
  return directives
    .map((d) => `Instruction from the person supervising this run (${d.directiveId}): ${d.text}`)
    .join('\n');
}

function textOf(message: AssistantMessage): string {
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('');
}

/** Provider errors can echo request details; keep a short message without credentials. */
function safe(text: string): string {
  return text
    .replace(/(bearer\s+)[\w.-]+/gi, '$1[redacted]')
    .replace(/\b(sk|rt|eyJ)[\w.-]{8,}/g, '[redacted]')
    .slice(0, 300);
}
