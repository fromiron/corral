import { fauxAssistantMessage, fauxToolCall, Type } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { spikeSession } from './sdk-session.ts';

// S3 (CR-018, plan §6 H1): a Reins directive reaches the model as a Pi steer message, and the
// Corral provider can tell which directives each request carries (C-052 rule 3), because each
// directive text carries its id.

let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  dispose = undefined;
});

const MARK = /\[directive (dir_\d+)\]/g;
const directivesIn = (systemAndMessages: string) =>
  [...new Set([...systemAndMessages.matchAll(MARK)].map((m) => m[1] as string))].sort();

/** The host pushes a directive while a tool is running; Corral's extension steers it in. */
function directiveDuringTool(directive: { id: string; text: string }) {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: 'slow_step',
      label: 'slow_step',
      description: 'A step that takes a while.',
      parameters: Type.Object({}),
      execute: async () => {
        pi.sendMessage(
          {
            customType: 'corral.directive',
            content: `[directive ${directive.id}] Instruction from the person supervising this run: ${directive.text}`,
            display: true,
            details: { directiveId: directive.id },
          },
          { deliverAs: 'steer' },
        );
        return { content: [{ type: 'text', text: 'step done' }], details: undefined };
      },
    });
  };
}

describe('S3: directives as steer messages', () => {
  it('[TC-HAR-003-H] a directive sent during a tool enters the next request and stays after it', async () => {
    const seen: string[][] = [];
    const run = await spikeSession({
      responses: [
        fauxAssistantMessage([fauxToolCall('slow_step', {})], { stopReason: 'toolUse' }),
        (context) => {
          seen.push(directivesIn(JSON.stringify(context.messages)));
          return fauxAssistantMessage([fauxToolCall('slow_step', {})], { stopReason: 'toolUse' });
        },
        (context) => {
          seen.push(directivesIn(JSON.stringify(context.messages)));
          return fauxAssistantMessage('Done.');
        },
      ],
      extensions: [directiveDuringTool({ id: 'dir_1', text: 'Use bullet points.' })],
    });
    dispose = run.dispose;
    await run.session.prompt('Work.');
    // Request 1 had none; request 2 (after the tool) has dir_1; request 3 still has it.
    expect(seen).toEqual([['dir_1'], ['dir_1']]);
    const steer = run.session.messages.filter(
      (m) =>
        m.role === 'custom' && (m as { customType?: string }).customType === 'corral.directive',
    );
    // The second tool call sent the same directive again; a real host sends each id once.
    expect(steer.length).toBeGreaterThanOrEqual(1);
  });
});
