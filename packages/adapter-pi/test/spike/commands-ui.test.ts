import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { spikeSession } from './sdk-session.ts';

// S7 (CR-018, plan §6 H1): extension commands and dialogs.
// - A command (like `/ponytail ultra`) runs before a run starts and changes later requests.
// - Pi refuses extension commands while a run is streaming, so Corral cannot route one into a
//   running execution: in R1 they are run options, given before the run starts.
// - Dialogs reach a host UI context with their title and timeout; Corral answers them.

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

/** A Ponytail-like extension: `/mode <level>` stores a level that a prompt section reflects. */
function modeExtension(onTool?: () => Promise<void>) {
  return (pi: ExtensionAPI) => {
    let level = 'off';
    pi.registerCommand('mode', {
      description: 'Set the mode.',
      handler: async (args) => {
        level = args.trim() || 'off';
        pi.appendEntry('mode', { level });
      },
    });
    pi.on('before_agent_start', async (event) => {
      const sections = event.systemPromptOptions?.sections as Record<string, string> | undefined;
      if (sections && level !== 'off') sections.mode = `Mode: ${level}.`;
    });
    pi.registerTool({
      name: 'step',
      label: 'step',
      description: 'A step.',
      parameters: Type.Object({}),
      execute: async () => {
        await onTool?.();
        return { content: [{ type: 'text', text: 'ok' }], details: undefined };
      },
    });
  };
}

describe('S7: extension commands and dialogs', () => {
  it('[TC-HAR-007-H] a command before the run changes the requests, without a model call', async () => {
    const run = await spikeSession({
      responses: [fauxAssistantMessage('Done.')],
      extensions: [modeExtension()],
    });
    dispose = run.dispose;
    await run.session.prompt('/mode ultra');
    expect(run.log.permits).toEqual([]);
    await run.session.prompt('Work.');
    expect(run.log.requests[0]?.systemPrompt).toContain('Mode: ultra.');
  });

  it('[TC-HAR-007-N] Pi refuses an extension command while the run is going', async () => {
    let session: AgentSession | undefined;
    let refusal = '';
    const run = await spikeSession({
      responses: [
        fauxAssistantMessage([fauxToolCall('step', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Done.'),
      ],
      extensions: [
        modeExtension(async () => {
          await session?.steer('/mode off').catch((error: unknown) => {
            refusal = String(error);
          });
        }),
      ],
    });
    session = run.session;
    dispose = run.dispose;
    await run.session.prompt('Work.');
    expect(refusal).toContain('cannot be queued');
  });

  it('[TC-HAR-007-H] a dialog reaches the host with its title and timeout, and gets the host answer', async () => {
    const asked: { title: string; timeout?: number }[] = [];
    const ui = new Proxy(
      {
        confirm: async (title: string, _message: string, opts?: { timeout?: number }) => {
          asked.push({ title, ...(opts?.timeout ? { timeout: opts.timeout } : {}) });
          return false;
        },
      },
      { get: (target, key) => (target as Record<PropertyKey, unknown>)[key] ?? (() => undefined) },
    ) as unknown as ExtensionUIContext;
    let answer: boolean | undefined;
    const run = await spikeSession({
      responses: [
        fauxAssistantMessage([fauxToolCall('ask_first', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Done.'),
      ],
      extensions: [
        (pi) => {
          pi.registerTool({
            name: 'ask_first',
            label: 'ask_first',
            description: 'Ask before acting.',
            parameters: Type.Object({}),
            execute: async (_id, _params, _signal, _update, ctx) => {
              answer = await ctx.ui.confirm('Delete the draft?', 'It cannot be undone.', {
                timeout: 30_000,
              });
              return { content: [{ type: 'text', text: String(answer) }], details: undefined };
            },
          });
        },
      ],
    });
    dispose = run.dispose;
    await run.session.bindExtensions({ uiContext: ui });
    await run.session.prompt('Go.');
    expect(asked).toEqual([{ title: 'Delete the draft?', timeout: 30_000 }]);
    expect(answer).toBe(false);
  });
});
