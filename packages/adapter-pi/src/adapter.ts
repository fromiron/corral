import {
  type AgentAdapter,
  type AgentHandle,
  type AgentHost,
  type AgentSettlement,
  type AgentStartInput,
  FILE_TOOLS,
  type ModelProfileSnapshot,
  ModelRequestRecord,
} from '@corral/contracts';
import type { Channel } from './channel.ts';
import type { EndpointSpec } from './endpoint.ts';
import {
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SdkResources,
  SdkWorkerFrame,
  WorkerFrame,
  type WorkerTool,
} from './protocol.ts';

// Host side of the Pi worker (C-017). The adapter turns worker frames into AgentHost calls,
// one at a time and in order, so a request permit is committed before the next frame runs.
// A worker that breaks the protocol, speaks for another execution or exits early fails its
// execution; it never completes one (Technical-Design §7.4).

export interface PiAdapterOptions {
  /** A fresh worker for one execution (ADR-017: spawned when needed). */
  spawn(): Channel;
  spawnSdk?(): Channel;
  harness?(input: AgentStartInput): Promise<SdkResources>;
  /** Access token for the provider of this model, asked per request; null for keyless. */
  credentials(model: ModelProfileSnapshot): Promise<string | null>;
  /** How long a cancelled worker may take to stop before it is terminated. */
  cancelGraceMs?: number;
  /** The OpenAI-compatible endpoint behind this model, if it is one (CR-005); no keys in it. */
  endpoint?(model: ModelProfileSnapshot): EndpointSpec | null;
}

type WorkerModel = { provider: string; modelId: string; endpoint?: EndpointSpec };

const INVALID = 'the model worker sent an invalid message';

export class PiAgentAdapter implements AgentAdapter {
  private readonly options: PiAdapterOptions;

  constructor(options: PiAdapterOptions) {
    this.options = options;
  }

  async start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle> {
    let resources: SdkResources | undefined;
    if (input.role.harness) {
      if (
        !input.harness ||
        !this.options.spawnSdk ||
        !this.options.harness ||
        !host.reportHarness ||
        !host.pendingDirectives ||
        !host.beginNativeTool ||
        !host.finishNativeTool ||
        input.harness.binding.profileId !== input.role.harness.profileId ||
        input.harness.binding.revision !== input.role.harness.revision
      )
        throw new Error('the harness runtime is unavailable or unresolved');
      try {
        resources = SdkResources.parse(await this.options.harness(input));
      } catch {
        throw new Error('harness resources could not be prepared');
      }
    } else if (input.harness) throw new Error('unexpected harness snapshot');
    const { provider, modelId } = input.model;
    if (input.mode !== 'live' || !provider || !modelId) {
      throw new Error('the Pi adapter runs live models only');
    }
    const endpoint = this.options.endpoint?.(input.model) ?? undefined;
    return new WorkerExecution(
      input,
      host,
      this.options,
      {
        provider,
        modelId,
        ...(endpoint ? { endpoint } : {}),
      },
      resources,
    ).handle;
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
  private pendingSettlement: AgentSettlement | null = null;
  private readonly uiRequests = new Map<string, AbortController>();
  private readonly uiRequestIds = new Set<string>();

  private readonly input: AgentStartInput;
  private readonly host: AgentHost;
  private readonly options: PiAdapterOptions;
  private readonly model: WorkerModel;
  private readonly resources: SdkResources | undefined;

  constructor(
    input: AgentStartInput,
    host: AgentHost,
    options: PiAdapterOptions,
    model: WorkerModel,
    resources?: SdkResources,
  ) {
    this.input = input;
    this.host = host;
    this.options = options;
    this.model = model;
    this.resources = resources;
    this.settlement = new Promise((resolve) => {
      this.resolve = resolve;
    });
    this.channel = resources ? options.spawnSdk!() : options.spawn();
    this.channel.onFrame((raw) => {
      this.queue = this.queue.then(() => this.receive(raw)).catch(() => this.violation());
    });
    this.channel.onExit((code) => {
      // Drain already-received IPC before deciding whether the worker supplied a result.
      void this.queue.finally(() => {
        this.finish(
          this.pendingSettlement ?? {
            outcome: 'failed',
            error: `the model worker stopped unexpectedly (${code === null ? 'killed' : `exit ${code}`})`,
          },
        );
      });
    });
    this.handle = {
      cancel: (reason) => this.cancel(reason),
      waitForSettlement: () => this.settlement,
      ...(resources
        ? {
            pushDirective: (directive: { directiveId: string; text: string }) => {
              if (this.state === 'running' && !this.pendingSettlement)
                this.send({ type: 'directive', ...directive });
            },
          }
        : {}),
    };
  }

  private send(frame: Record<string, unknown>) {
    this.channel.send({
      ...frame,
      protocolVersion: this.resources ? PROTOCOL_VERSION : LEGACY_PROTOCOL_VERSION,
      executionId: this.input.executionId,
    });
  }

  private finish(settlement: AgentSettlement) {
    if (this.state === 'done') return;
    this.state = 'done';
    for (const controller of this.uiRequests.values()) controller.abort();
    this.uiRequests.clear();
    if (this.timer) clearTimeout(this.timer);
    this.resolve(settlement);
  }

  private violation() {
    if (this.state === 'done') return;
    this.pendingSettlement = { outcome: 'failed', error: INVALID };
    this.waitForExit();
    this.channel.kill();
  }

  private waitForExit() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.finish({
          outcome: 'failed',
          terminationMode: 'unconfirmed',
          error: 'termination_unconfirmed',
        });
      },
      Math.min(this.options.cancelGraceMs ?? 1_000, 1_000),
    );
  }

  private async cancel(reason: string) {
    if (this.state === 'done' || this.pendingSettlement) return;
    for (const controller of this.uiRequests.values()) controller.abort();
    this.send({ type: 'cancel', reason });
    this.timer = setTimeout(
      () => {
        if (this.state === 'done') return;
        this.pendingSettlement = {
          outcome: 'cancelled',
          error: 'the model worker did not stop in time and was terminated',
          terminationMode: 'forced',
        };
        this.waitForExit();
        this.channel.kill();
      },
      Math.min(this.options.cancelGraceMs ?? 9_000, 9_000),
    );
  }

  private async receive(raw: unknown) {
    if (this.state === 'done' || this.pendingSettlement) return;
    const parsed = (this.resources ? SdkWorkerFrame : WorkerFrame).safeParse(raw);
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
        inputs: this.input.inputs.map(({ name, artifactVersionId, text }) => ({
          name,
          artifactVersionId,
          text,
        })),
        criteriaVersionId: this.input.criteriaVersionId,
        round: this.input.round,
        // Only the tools this role may use, and that its links make meaningful, are offered;
        // the host still checks every call.
        tools: this.resources
          ? [
              ...offeredTools(this.input).filter((name) =>
                this.input.harness?.allowedTools.includes(name),
              ),
              ...(this.input.harness?.allowedTools.includes('read') &&
              (this.input.role.allowedWorkTools.includes('read_file') ||
                this.input.harness.resources.some((resource) => resource.kind === 'skill'))
                ? ['read']
                : []),
              ...(this.input.harness?.allowedTools.includes('write') &&
              role.allowedWorkTools.includes('write_file')
                ? ['write']
                : []),
              ...(this.input.harness?.allowedTools.includes('edit') &&
              role.allowedWorkTools.includes('write_file') &&
              role.allowedWorkTools.includes('read_file')
                ? ['edit']
                : []),
              ...(this.input.harness?.allowedTools.includes('run_check') &&
              this.input.harness.projectTools?.checkIds.length
                ? ['run_check']
                : []),
            ]
          : offeredTools(this.input),
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
        ...(this.resources ? { harness: this.input.harness, resources: this.resources } : {}),
      });
      if (this.resources)
        for (const directive of this.host.pendingDirectives!())
          this.send({ type: 'directive', ...directive });
      return;
    }
    if (this.state !== 'running' || frame.executionId !== this.input.executionId) {
      return this.violation();
    }

    switch (frame.type) {
      case 'ui_request': {
        if (this.uiRequestIds.has(frame.requestId)) return this.violation();
        this.uiRequestIds.add(frame.requestId);
        const controller = new AbortController();
        this.uiRequests.set(frame.requestId, controller);
        try {
          if (!this.host.requestExtensionUi) throw new Error('extension UI unavailable');
          // Human input must not block the queue that carries its abort and the worker's exit.
          const result = this.host.requestExtensionUi(frame.request, {
            get aborted() {
              return controller.signal.aborted;
            },
            onCancel: (listener) => {
              controller.signal.addEventListener('abort', listener, { once: true });
              return () => controller.signal.removeEventListener('abort', listener);
            },
          });
          void result
            .then(
              (answer) => {
                if (this.state === 'running' && !this.pendingSettlement)
                  this.send({ type: 'ui_answer', requestId: frame.requestId, result: answer });
              },
              () => {
                if (this.state === 'running' && !this.pendingSettlement)
                  this.send({
                    type: 'refused',
                    requestId: frame.requestId,
                    reason: 'extension UI unavailable',
                  });
              },
            )
            .finally(() => this.uiRequests.delete(frame.requestId));
        } catch {
          this.uiRequests.delete(frame.requestId);
          this.send({
            type: 'refused',
            requestId: frame.requestId,
            reason: 'extension UI unavailable',
          });
        }
        return;
      }
      case 'ui_cancel':
        this.uiRequests.get(frame.requestId)?.abort();
        return;
      case 'ui_notice':
        try {
          if (!this.host.notifyExtensionUi) throw new Error('extension UI unavailable');
          await this.host.notifyExtensionUi(frame.notice);
          this.send({ type: 'ack', requestId: frame.requestId });
        } catch {
          this.send({
            type: 'refused',
            requestId: frame.requestId,
            reason: 'extension UI unavailable',
          });
        }
        return;
      case 'harness_report':
      case 'request_record':
      case 'native_tool_start':
      case 'native_tool_finish': {
        try {
          if (frame.type === 'harness_report') await this.host.reportHarness!(frame.report);
          else if (frame.type === 'request_record') {
            if (!this.host.recordProviderPayload)
              throw new Error('provider request recording unavailable');
            await this.host.recordProviderPayload({
              modelCallId: frame.modelCallId,
              payloadHash: frame.payloadHash,
              payloadBytes: frame.payloadBytes,
            });
          } else if (frame.type === 'native_tool_start')
            await this.host.beginNativeTool!(frame.toolCallId, frame.argsHash);
          else await this.host.finishNativeTool!(frame.toolCallId, frame.outcome);
          this.send({ type: 'ack', requestId: frame.requestId });
        } catch (error) {
          this.send({ type: 'refused', requestId: frame.requestId, reason: reasonOf(error) });
        }
        return;
      }
      case 'request_dispatched':
        if (this.resources && !('requestId' in frame)) return this.violation();
        try {
          await this.host.modelRequestDispatched?.(frame.modelCallId);
          if ('requestId' in frame) this.send({ type: 'ack', requestId: frame.requestId });
        } catch (error) {
          if ('requestId' in frame)
            this.send({ type: 'refused', requestId: frame.requestId, reason: reasonOf(error) });
          else throw error;
        }
        return;
      case 'prepare_request': {
        try {
          if (this.resources && !('purpose' in frame)) return this.violation();
          const permit = await this.host.prepareModelRequest(
            'purpose' in frame
              ? ModelRequestRecord.parse({
                  purpose: frame.purpose,
                  directiveIds: frame.directiveIds,
                  contextHash: frame.contextHash,
                  contextBytes: frame.contextBytes,
                  sections: frame.sections,
                })
              : undefined,
          );
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
        this.pendingSettlement = {
          outcome: frame.outcome,
          ...(frame.error ? { error: 'the model worker reported a request failure' } : {}),
        };
        this.waitForExit();
        return;
    }
  }
}

function offeredTools(input: AgentStartInput): WorkerTool[] {
  const { role, capabilities, assignment } = input;
  const may = (tool: string) =>
    (role.allowedCollaborationTools as readonly string[]).includes(tool);
  const tools: WorkerTool[] = [];
  if (role.allowedWorkTools.includes('search')) tools.push('search');
  if (role.allowedWorkTools.includes('read_document')) tools.push('read_document');
  if (role.allowedWorkTools.includes('write_artifact')) tools.push('write_artifact');
  for (const file of FILE_TOOLS) if (role.allowedWorkTools.includes(file)) tools.push(file);
  if (may('read_artifact')) tools.push('read_artifact');
  if (may('spawn_subagents') && capabilities.delegateTo.length > 0) tools.push('spawn_subagents');
  if (may('await_tasks') && capabilities.delegateTo.length > 0) tools.push('await_tasks');
  if (may('ask') && capabilities.askTo.length > 0) tools.push('ask');
  if (may('reply') && assignment.kind === 'question') tools.push('reply');
  if (may('submit_result') && assignment.kind !== 'question') tools.push('submit_result');
  return tools;
}

function reasonOf(_error: unknown): string {
  // Provider exceptions may echo credentials, local paths or the full request body.
  return 'the host could not complete this request';
}
