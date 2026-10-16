import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import { type AssistantMessage, type Model, Type } from '@earendil-works/pi-ai';
import type { Channel } from './channel.ts';
import type { EndpointSpec } from './endpoint.ts';
import { HostFrame, PROTOCOL_VERSION, type StartFrame, type WorkerTool } from './protocol.ts';
import { normalizeUsage } from './usage.ts';

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

type Reply = Exclude<HostFrame, StartFrame | { type: 'cancel' }>;

const TOOL_TEXT: Record<WorkerTool, string> = {
  search:
    'Search registered documents, or explicitly choose Brave for an enabled live run. Returns registered source references.',
  read_document:
    'Read a registered documentId or sourceId. Raw URLs and filesystem paths are not accepted.',
  write_artifact:
    'Save your output text as a new immutable version. Returns its artifactVersionId.',
  list_files:
    'List files of the working copy under a relative folder (default: the root). Returns paths and sizes.',
  read_file:
    'Read a UTF-8 text file of the working copy by relative path. Read a file before changing it.',
  write_file:
    'Create or replace a UTF-8 text file by relative path. An existing file must be read first; if it changed since, the write is refused.',
  delete_file: 'Delete a file you have read, by relative path.',
  move_file: 'Move or rename a file you have read, from one relative path to another.',
  submit_result: 'Submit the versions that complete your task. Call it once, after write_artifact.',
  spawn_subagents:
    'Start callable agents on separate tasks, in parallel. Returns their taskIds; then call await_tasks.',
  await_tasks:
    'Wait until the given tasks you started finish. Returns each status and the versions it submitted.',
  ask: 'Ask a callable agent a question and wait for its answer (or a timeout).',
  reply: 'Answer the question you were given. Call it once; your task ends with the answer.',
  read_artifact: 'Read the text of an artifact version you are allowed to see.',
};

/** Parameters the model fills in; ids of the run, owner and question come from Corral. */
function parametersOf(name: WorkerTool, start: StartFrame) {
  const node = (targets: { nodeId: string }[]) =>
    Type.Union(targets.map((t) => Type.Literal(t.nodeId)));
  switch (name) {
    case 'search':
      return Type.Object({
        query: Type.String({ minLength: 1, maxLength: 1000 }),
        provider: Type.Optional(Type.Union([Type.Literal('corpus'), Type.Literal('brave')])),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
      });
    case 'read_document':
      return Type.Union([
        Type.Object({ documentId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
        Type.Object({ sourceId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
      ]);
    case 'write_artifact':
      return Type.Object({ text: Type.String() });
    case 'list_files':
      return Type.Object({ path: Type.Optional(Type.String({ maxLength: 500 })) });
    case 'read_file':
    case 'delete_file':
      return Type.Object({ path: Type.String({ minLength: 1, maxLength: 500 }) });
    case 'write_file':
      return Type.Object({
        path: Type.String({ minLength: 1, maxLength: 500 }),
        text: Type.String(),
      });
    case 'move_file':
      return Type.Object({
        from: Type.String({ minLength: 1, maxLength: 500 }),
        to: Type.String({ minLength: 1, maxLength: 500 }),
      });
    case 'submit_result':
      return Type.Object({ artifactVersionIds: Type.Array(Type.String(), { minItems: 1 }) });
    case 'spawn_subagents':
      return Type.Object({
        tasks: Type.Array(
          Type.Object({ targetNodeId: node(start.delegateTo), brief: Type.String() }),
          { minItems: 1, maxItems: 4 },
        ),
      });
    case 'await_tasks':
      return Type.Object({ taskIds: Type.Array(Type.String(), { minItems: 1 }) });
    case 'ask':
      return Type.Object({
        targetNodeId: node(start.askTo),
        body: Type.String(),
        artifactRefs: Type.Optional(Type.Array(Type.String())),
      });
    case 'reply':
      return Type.Object({
        body: Type.String(),
        evidenceRefs: Type.Optional(Type.Array(Type.String())),
      });
    case 'read_artifact':
      return Type.Object({ artifactVersionId: Type.String() });
  }
}

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

    let permit: { modelCallId: string; apiKey: string | null; maxOutputTokens: number } | null =
      null;
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
        const stream = deps.streamFn(m, context, {
          ...options,
          ...(keyOf(permit?.apiKey) ? { apiKey: keyOf(permit?.apiKey) } : {}),
          ...(permit ? { maxTokens: permit.maxOutputTokens } : {}),
        });
        if (permit)
          port.send({ type: 'request_dispatched', ...head, modelCallId: permit.modelCallId });
        return stream;
      },
      getApiKey: () => keyOf(permit?.apiKey),
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

function systemPrompt(start: StartFrame): string {
  const names = (targets: { nodeId: string; label: string }[]) =>
    targets.map((t) => `${t.label} (${t.nodeId})`).join(', ');
  const lines = [
    start.role.prompt,
    '',
    `You are ${start.role.name}, one step of a Corral team. Your output contract is "${start.role.outputContract}".`,
  ];
  if (start.assignment.kind === 'delegated') {
    lines.push('Another agent delegated a task to you; it is given as "task" below.');
  }
  if (start.assignment.kind === 'question') {
    lines.push(
      'Another agent asked you the question given as "question" below. Answer it with reply.',
    );
  } else {
    lines.push(
      'When your work is complete, call write_artifact with the full output text, then call submit_result with the artifactVersionId it returned.',
    );
  }
  if (start.role.outputContract === 'review') {
    // Corral checks this exact shape; anything else counts as inconclusive, never as a pass.
    const target =
      start.inputs.find((i) => i.name === 'draft' && i.artifactVersionId) ??
      start.inputs.find((i) => i.artifactVersionId);
    lines.push(
      'Your output text must be a JSON review object and nothing else: ' +
        `{"targetArtifactVersionId": "${target?.artifactVersionId ?? '<the draft version>'}", ` +
        `"criteriaVersionId": "${start.criteriaVersionId}", "verdict": "pass" | "revise" | "inconclusive", ` +
        '"issues": [{"criterionId": "...", "reason": "...", "severity": "required" | "advisory", "evidenceRefs": []}], ' +
        '"evidenceRefs": []}. A revise verdict needs at least one issue.',
      // Ids the schema accepts, tied to the criteria text in the "criteria" input (#20).
      'For criterionId use c1 for the first criterion in the criteria input, c2 for the second, and so on; use "general" for an issue no criterion covers.',
    );
  }
  if (start.tools.includes('spawn_subagents')) {
    lines.push(
      `You may delegate tasks to: ${names(start.delegateTo)}. Use spawn_subagents, then await_tasks.`,
    );
  }
  if (start.tools.includes('ask')) lines.push(`You may ask: ${names(start.askTo)}. Use ask.`);
  lines.push(
    'Instructions from the person supervising this run may arrive during your work; follow them.',
  );
  return lines.join('\n');
}

function userPrompt(start: StartFrame): string {
  const round = start.round ? `This is round ${start.round} of a review loop.\n\n` : '';
  return (
    round +
    start.inputs
      .map((input) =>
        input.artifactVersionId
          ? `## ${input.name} (version ${input.artifactVersionId})\n\n${input.text}`
          : `## ${input.name}\n\n${input.text}`,
      )
      .join('\n\n')
  );
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
