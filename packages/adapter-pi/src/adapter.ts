import type {
  AgentAdapter,
  AgentHandle,
  AgentHost,
  AgentSettlement,
  AgentStartInput,
  ModelProfileSnapshot,
} from '@corral/contracts';
import type { Channel } from './channel.ts';
import { PROTOCOL_VERSION, WorkerFrame, type WorkerTool } from './protocol.ts';

// Host side of the Pi worker (C-017). The adapter turns worker frames into AgentHost calls,
// one at a time and in order, so a request permit is committed before the next frame runs.
// A worker that breaks the protocol, speaks for another execution or exits early fails its
// execution; it never completes one (Technical-Design §7.4).

export interface PiAdapterOptions {
  /** A fresh worker for one execution (ADR-017: spawned when needed). */
  spawn(): Channel;
  /** Access token for the provider of this model, asked per request; null for keyless. */
  credentials(model: ModelProfileSnapshot): Promise<string | null>;
  /** How long a cancelled worker may take to stop before it is terminated. */
  cancelGraceMs?: number;
}

const INVALID = 'the model worker sent an invalid message';

export class PiAgentAdapter implements AgentAdapter {
  private readonly options: PiAdapterOptions;

  constructor(options: PiAdapterOptions) {
    this.options = options;
  }

  async start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle> {
    const { provider, modelId } = input.model;
    if (input.mode !== 'live' || !provider || !modelId) {
      throw new Error('the Pi adapter runs live models only');
    }
    return new WorkerExecution(input, host, this.options, { provider, modelId }).handle;
  }
}

class WorkerExecution {
  readonly handle: AgentHandle;
  private state: 'starting' | 'running' | 'done' = 'starting';
  private queue: Promise<void> = Promise.resolve();
  private readonly channel: Channel;
  private readonly settlement: Promise<AgentSettlement>;
  private resolve!: (settlement: AgentSettlement) => void;
  private timer: ReturnType<typeof setTimeout> | null = null;

  private readonly input: AgentStartInput;
  private readonly host: AgentHost;
  private readonly options: PiAdapterOptions;
  private readonly model: { provider: string; modelId: string };

  constructor(
    input: AgentStartInput,
    host: AgentHost,
    options: PiAdapterOptions,
    model: { provider: string; modelId: string },
  ) {
    this.input = input;
    this.host = host;
    this.options = options;
    this.model = model;
    this.settlement = new Promise((resolve) => {
      this.resolve = resolve;
    });
    this.channel = options.spawn();
    this.channel.onFrame((raw) => {
      this.queue = this.queue.then(() => this.receive(raw)).catch(() => this.violation());
    });
    this.channel.onExit((code) => {
      this.finish({
        outcome: 'failed',
        error: `the model worker stopped unexpectedly (${code === null ? 'killed' : `exit ${code}`})`,
      });
    });
    this.handle = {
      cancel: (reason) => this.cancel(reason),
      waitForSettlement: () => this.settlement,
    };
  }

  private send(frame: Record<string, unknown>) {
    this.channel.send({
      ...frame,
      protocolVersion: PROTOCOL_VERSION,
      executionId: this.input.executionId,
    });
  }

  private finish(settlement: AgentSettlement) {
    if (this.state === 'done') return;
    this.state = 'done';
    if (this.timer) clearTimeout(this.timer);
    this.resolve(settlement);
  }

  private violation() {
    if (this.state === 'done') return;
    this.finish({ outcome: 'failed', error: INVALID });
    this.channel.kill();
  }

  private async cancel(reason: string) {
    if (this.state === 'done') return;
    this.send({ type: 'cancel', reason });
    this.timer = setTimeout(() => {
      if (this.state === 'done') return;
      this.finish({
        outcome: 'cancelled',
        error: 'the model worker did not stop in time and was terminated',
      });
      this.channel.kill();
    }, this.options.cancelGraceMs ?? 10_000);
  }

  private async receive(raw: unknown) {
    if (this.state === 'done') return;
    const parsed = WorkerFrame.safeParse(raw);
    if (!parsed.success) return this.violation();
    const frame = parsed.data;
    if (frame.type === 'ready') {
      if (this.state !== 'starting') return this.violation();
      this.state = 'running';
      const { role } = this.input;
      this.send({
        type: 'start',
        model: this.model,
        role: { name: role.name, prompt: role.prompt, outputContract: role.outputContract },
        inputs: this.input.inputs.map(({ name, text }) => ({ name, text })),
        // Only the tools this role may use, and that its links make meaningful, are offered;
        // the host still checks every call.
        tools: offeredTools(this.input),
        assignment:
          this.input.assignment.kind === 'delegated'
            ? { kind: 'delegated', brief: this.input.assignment.brief }
            : this.input.assignment.kind === 'question'
              ? {
                  kind: 'question',
                  questionId: this.input.assignment.questionId,
                  body: this.input.assignment.body,
                }
              : { kind: 'scheduled' },
        delegateTo: this.input.capabilities.delegateTo,
        askTo: this.input.capabilities.askTo,
      });
      return;
    }
    if (this.state !== 'running' || frame.executionId !== this.input.executionId) {
      return this.violation();
    }

    switch (frame.type) {
      case 'prepare_request': {
        try {
          const permit = await this.host.prepareModelRequest();
          const apiKey = await this.options.credentials(this.input.model);
          this.send({
            type: 'permit',
            requestId: frame.requestId,
            modelCallId: permit.modelCallId,
            maxOutputTokens: permit.maxOutputTokens,
            directives: permit.directives,
            apiKey,
          });
        } catch (error) {
          this.send({ type: 'refused', requestId: frame.requestId, reason: reasonOf(error) });
        }
        return;
      }
      case 'authorize_tool': {
        try {
          const decision = await this.host.authorizeTool({ name: frame.name, args: frame.args });
          this.send({
            type: 'tool_authorization',
            requestId: frame.requestId,
            ok: decision.ok,
            toolCallId: decision.toolCallId,
            ...(decision.ok ? {} : { reason: decision.error.message }),
          });
        } catch (error) {
          this.send({
            type: 'tool_authorization',
            requestId: frame.requestId,
            ok: false,
            toolCallId: 'tool_refused',
            reason: reasonOf(error),
          });
        }
        return;
      }
      case 'execute_tool': {
        try {
          const outcome = await this.host.executeTool(frame.toolCallId);
          this.send({
            type: 'tool_result',
            requestId: frame.requestId,
            ok: outcome.ok,
            ...(outcome.ok ? { result: outcome.result } : { reason: outcome.error.message }),
          });
        } catch (error) {
          this.send({
            type: 'tool_result',
            requestId: frame.requestId,
            ok: false,
            reason: reasonOf(error),
          });
        }
        return;
      }
      case 'observe':
        await this.host
          .observe({
            kind: 'model_completed',
            modelCallId: frame.modelCallId,
            text: frame.text,
            usage: frame.usage,
            ...(frame.rawUsage ? { rawUsage: frame.rawUsage } : {}),
          })
          .catch(() => {});
        return;
      case 'stream':
        this.host.streamText({
          modelCallId: frame.modelCallId,
          chunkIndex: frame.chunkIndex,
          text: frame.text,
        });
        return;
      case 'settled':
        this.finish({ outcome: frame.outcome, ...(frame.error ? { error: frame.error } : {}) });
        return;
    }
  }
}

function offeredTools(input: AgentStartInput): WorkerTool[] {
  const { role, capabilities, assignment } = input;
  const may = (tool: string) =>
    (role.allowedCollaborationTools as readonly string[]).includes(tool);
  const tools: WorkerTool[] = [];
  if (role.allowedWorkTools.includes('write_artifact')) tools.push('write_artifact');
  if (may('read_artifact')) tools.push('read_artifact');
  if (may('spawn_subagents') && capabilities.delegateTo.length > 0) tools.push('spawn_subagents');
  if (may('await_tasks') && capabilities.delegateTo.length > 0) tools.push('await_tasks');
  if (may('ask') && capabilities.askTo.length > 0) tools.push('ask');
  if (may('reply') && assignment.kind === 'question') tools.push('reply');
  if (may('submit_result') && assignment.kind !== 'question') tools.push('submit_result');
  return tools;
}

function reasonOf(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300) || 'refused';
}
