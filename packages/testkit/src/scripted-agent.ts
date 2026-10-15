import type {
  AgentAdapter,
  AgentHandle,
  AgentHost,
  AgentSettlement,
  AgentStartInput,
  RequestPermit,
} from '@corral/contracts';

export interface ScriptedAgentOptions {
  /** Model requests per execution. A steer accepted between requests reaches the next one. */
  turns: number;
  /** Awaited before each reply; tests pass a Gate to pin interleavings, demos pass a delay. */
  beforeReply?: (turn: number, input: AgentStartInput) => Promise<void>;
  /** Reply text. The default echoes inputs and delivered directives so steering is observable. */
  reply?: (turn: number, input: AgentStartInput, permit: RequestPermit) => string;
  /**
   * Takes over one execution when it returns a settlement (tests that need a specific move);
   * returning null leaves the default behaviour.
   */
  script?: (input: AgentStartInput, host: AgentHost) => Promise<AgentSettlement | null>;
  /** Use the protocol tools a role and its links allow (spawn/await, ask, reply). Default on. */
  collaborate?: boolean;
}

export function defaultReply(turn: number, input: AgentStartInput, permit: RequestPermit): string {
  const inputs = input.inputs.map((i) => `${i.name}@${i.artifactVersionId ?? 'run_input'}`);
  const lines = [
    `${input.role.name} (${input.nodeId}) turn ${turn}`,
    `inputs: ${inputs.join(', ') || 'none'}`,
  ];
  if (permit.directives.length === 0) lines.push('directives: none');
  for (const d of permit.directives) lines.push(`directive ${d.directiveId}: ${d.text}`);
  return lines.join('\n');
}

class Cancelled extends Error {}

/**
 * Deterministic AgentAdapter (Test-Strategy §3). It never decides domain state:
 * every request, tool call and result goes through the host.
 */
export class ScriptedAgentAdapter implements AgentAdapter {
  private readonly options: ScriptedAgentOptions;

  constructor(options: ScriptedAgentOptions) {
    this.options = options;
  }

  async start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle> {
    let cancelled = false;
    const checkpoint = () => {
      if (cancelled) throw new Cancelled();
    };
    const reply = this.options.reply ?? defaultReply;

    const collaboration = this.options.collaborate ?? true;
    const tools = input.role.allowedCollaborationTools;

    /** One model request through the host: permit, reply, streamed text, observation. */
    const request = async (turn: number, extra: string[]): Promise<string> => {
      checkpoint();
      const permit = await host.prepareModelRequest();
      await this.options.beforeReply?.(turn, input);
      checkpoint();
      const text = [reply(turn, input, permit), ...extra].join('\n');
      // Stream the reply in a few pieces, as a model would, before reporting it.
      for (const [chunkIndex, piece] of chunks(text).entries()) {
        host.streamText({ modelCallId: permit.modelCallId, chunkIndex, text: piece });
      }
      await host.observe({
        kind: 'model_completed',
        modelCallId: permit.modelCallId,
        text,
        usage: { inputTokens: null, outputTokens: text.length },
      });
      return text;
    };

    const run = async (): Promise<AgentSettlement> => {
      try {
        const scripted = await this.options.script?.(input, host);
        if (scripted) return scripted;
        const notes: string[] = [];

        // A responder answers its question and is done (Spec §6 step 5–6).
        if (collaboration && input.assignment.kind === 'question' && tools.includes('reply')) {
          const answer = await request(1, [`answers ${input.assignment.questionId}`]);
          checkpoint();
          const replied = await host.invokeTool({
            name: 'reply',
            args: { questionId: input.assignment.questionId, body: answer, evidenceRefs: [] },
          });
          return replied.ok ? { outcome: 'succeeded' } : failed(replied.error);
        }

        // Delegate two parts to the first callable helper, then read what they submitted.
        const delegateTo = input.capabilities.delegateTo[0];
        if (collaboration && delegateTo && tools.includes('spawn_subagents')) {
          const spawned = await host.invokeTool({
            name: 'spawn_subagents',
            args: {
              tasks: [1, 2].map((part) => ({
                targetNodeId: delegateTo.nodeId,
                brief: `Find primary sources for part ${part}.`,
              })),
            },
          });
          if (!spawned.ok) return failed(spawned.error);
          checkpoint();
          const awaited = await host.invokeTool({
            name: 'await_tasks',
            args: { taskIds: spawned.result.taskIds as string[] },
          });
          if (!awaited.ok) return failed(awaited.error);
          const children = awaited.result.tasks as { artifactVersionIds: string[] }[];
          for (const versionId of children.flatMap((c) => c.artifactVersionIds)) {
            const read = await host.invokeTool({
              name: 'read_artifact',
              args: { artifactVersionId: versionId },
            });
            if (read.ok) notes.push(`read ${versionId}`);
          }
        }

        // Ask the first callable responder, and use the answer.
        const askTo = input.capabilities.askTo[0];
        if (collaboration && askTo && tools.includes('ask')) {
          checkpoint();
          const asked = await host.invokeTool({
            name: 'ask',
            args: {
              targetNodeId: askTo.nodeId,
              body: 'Which source supports the main claim?',
              artifactRefs: input.inputs.flatMap((i) =>
                i.artifactVersionId ? [i.artifactVersionId] : [],
              ),
            },
          });
          if (!asked.ok) return failed(asked.error);
          const result = asked.result as { outcome: string; body?: string };
          notes.push(
            result.outcome === 'answered'
              ? `answer: ${result.body}`
              : `no answer (${result.outcome})`,
          );
        }

        let text = '';
        for (let turn = 1; turn <= this.options.turns; turn++) {
          text = await request(turn, turn === this.options.turns ? notes : []);
        }
        checkpoint();
        const written = await host.invokeTool({ name: 'write_artifact', args: { text } });
        if (!written.ok) return failed(written.error);
        checkpoint();
        const artifactVersionId = written.result.artifactVersionId;
        const submitted = await host.invokeTool({
          name: 'submit_result',
          args: { artifactVersionIds: [artifactVersionId] },
        });
        if (!submitted.ok) return failed(submitted.error);
        return { outcome: 'succeeded' };
      } catch (error) {
        if (error instanceof Cancelled) return { outcome: 'cancelled' };
        return { outcome: 'failed', error: String(error) };
      }
    };

    const settlement = run();
    return {
      cancel: async () => {
        cancelled = true;
      },
      waitForSettlement: () => settlement,
    };
  }
}

function failed(error: { code: string; message: string }): AgentSettlement {
  return { outcome: 'failed', error: `${error.code}: ${error.message}` };
}

function chunks(text: string, count = 3): string[] {
  const size = Math.max(1, Math.ceil(text.length / count));
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}
