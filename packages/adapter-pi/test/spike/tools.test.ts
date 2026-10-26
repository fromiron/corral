import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { hashOf, spikeSession } from './sdk-session.ts';

// S2: Corral approves a tool call with the input it will actually run with,
// after every other extension's tool_call handler, including handlers added at runtime and
// calls one tool makes through another.

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

/** An extension with an `echo` tool that records what it ran with, and a `runner` tool that
 * calls `echo` itself. Its tool_call handler, added at session start, rewrites the path. */
function fileTools(ran: unknown[]) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'echo',
      label: 'echo',
      description: 'Echo a path.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
        ran.push(structuredClone(params));
        return { content: [{ type: 'text', text: params.path }], details: undefined };
      },
    });
    pi.registerTool({
      name: 'runner',
      label: 'runner',
      description: 'Run echo for a path.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params, signal, _update, ctx) => {
        const outcome = await ctx.executeTool('echo', { path: params.path }, { signal });
        return { content: outcome.result.content, details: undefined };
      },
    });
    pi.on('session_start', async () => {
      pi.on('tool_call', async (event) => {
        const input = event.input as { path?: string };
        if (input.path === 'a.txt') input.path = 'b.txt';
        return undefined;
      });
    });
  };
}

const callThenStop = (name: string, args: { [key: string]: string }) => [
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: 'toolUse' }),
  fauxAssistantMessage('Done.'),
];

describe('S2: approval with the final input', () => {
  it('approves the input another extension rewrote at runtime, and runs exactly that', async () => {
    const ran: unknown[] = [];
    const run = await spikeSession({
      responses: callThenStop('echo', { path: 'a.txt' }),
      extensions: [fileTools(ran)],
    });
    dispose = run.dispose;
    await run.session.prompt('Echo a.txt.');
    expect(run.log.approved).toHaveLength(1);
    expect(run.log.approved[0]?.input).toEqual({ path: 'b.txt' });
    expect(ran).toEqual([{ path: 'b.txt' }]);
    // tool_execution_start reports the arguments from before the hooks: never record it as
    // what ran. The approval is the record of the final input.
    expect(run.log.started[0]?.hash).toBe(hashOf({ path: 'a.txt' }));
  });

  it('a call one tool makes through another is approved too, with its parent', async () => {
    const ran: unknown[] = [];
    const run = await spikeSession({
      responses: callThenStop('runner', { path: 'a.txt' }),
      extensions: [fileTools(ran)],
    });
    dispose = run.dispose;
    await run.session.prompt('Run a.txt.');
    const nested = run.log.approved.find((a) => a.parent);
    expect(run.log.approved.map((a) => a.toolName)).toEqual(['runner', 'echo']);
    expect(nested?.parent).toBe(run.log.approved[0]?.toolCallId);
    expect(nested?.input).toEqual({ path: 'b.txt' });
    expect(ran).toEqual([{ path: 'b.txt' }]);
  });

  it('a refusal stops the call, nested or not', async () => {
    const ran: unknown[] = [];
    const run = await spikeSession({
      responses: [
        fauxAssistantMessage([fauxToolCall('echo', { path: 'x.txt' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage([fauxToolCall('runner', { path: 'y.txt' })], {
          stopReason: 'toolUse',
        }),
        fauxAssistantMessage('Done.'),
      ],
      extensions: [fileTools(ran)],
      approve: (name) => name === 'runner',
    });
    dispose = run.dispose;
    await run.session.prompt('Try both.');
    expect(ran).toEqual([]);
    const results = run.session.messages.filter((m) => m.role === 'toolResult');
    // The direct call fails. The nested refusal reaches the calling tool as an error result;
    // what that tool reports is its own choice, but the refused call did not run.
    expect((results[0] as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(results[1])).toContain('not approved by Corral');
  });

  it('a Corral handler that throws blocks the call (fail closed)', async () => {
    const ran: unknown[] = [];
    const run = await spikeSession({
      responses: callThenStop('echo', { path: 'x.txt' }),
      extensions: [fileTools(ran)],
      approve: () => {
        throw new Error('host unreachable');
      },
    });
    dispose = run.dispose;
    await run.session.prompt('Echo.');
    expect(ran).toEqual([]);
    const result = run.session.messages.find((m) => m.role === 'toolResult');
    expect((result as { isError?: boolean }).isError).toBe(true);
  });

  it('Pi built-in tools stay off; only registered tools are declared', async () => {
    const run = await spikeSession({
      responses: [fauxAssistantMessage('Hi.')],
      extensions: [fileTools([])],
    });
    dispose = run.dispose;
    expect(run.session.getActiveToolNames().sort()).toEqual(['echo', 'runner']);
  });
});
