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

    const run = async (): Promise<AgentSettlement> => {
      try {
        let text = '';
        for (let turn = 1; turn <= this.options.turns; turn++) {
          checkpoint();
          const permit = await host.prepareModelRequest();
          await this.options.beforeReply?.(turn, input);
          checkpoint();
          text = reply(turn, input, permit);
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
