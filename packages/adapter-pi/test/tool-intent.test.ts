import type { RunEvent } from '@corral/contracts';
import { waitForProjection } from '@corral/core';
import { linearCorral } from '@corral/testkit';
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { liveRuntime } from './harness.ts';

// llm-runtime.md: a call's `i` is its intent, for display only. It leaves the arguments before the
// Coordinator sees them, so calls differing only in `i` stay the same call.

it('takes each call’s intent out of its arguments, so sentences that differ never make calls differ', async () => {
  let declared: unknown;
  let calls = 0;
  const respond: FauxResponseStep = (context) => {
    const tools = getCurrentTools(context.messages);
    declared ??= tools.find((tool) => tool.name === 'write_artifact')?.parameters;
    calls += 1;
    if (calls <= 3)
      return fauxAssistantMessage(
        [
          fauxToolCall('write_artifact', {
            text: 'Same draft',
            i: `Save the draft, try ${calls}`,
          } as never),
        ],
        { stopReason: 'toolUse' },
      );
    return fauxAssistantMessage('Done.');
  };
  const { transport } = liveRuntime(Array.from({ length: 8 }, () => respond));
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_tool_intent',
    definition: linearCorral(['writer']),
    mode: 'live',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (event) => events.push(event), onFrame: () => {} });
  await waitForProjection(transport, runId, (state) =>
    ['succeeded', 'failed', 'cancelled'].includes(state.status),
  );
  expect(declared).toMatchObject({ properties: { i: { type: 'string' } } });
  const requested = events.filter(
    (event): event is Extract<RunEvent, { type: 'tool.requested' }> =>
      event.type === 'tool.requested' && event.payload.name === 'write_artifact',
  );
  expect(requested).toHaveLength(3);
  for (const [index, event] of requested.entries()) {
    expect(event.payload.validatedArgs).not.toHaveProperty('i');
    expect(event.payload.intent).toBe(`Save the draft, try ${index + 1}`);
  }
  const args = requested.map((event) => JSON.stringify(event.payload.validatedArgs));
  expect(new Set(args).size).toBe(1);
});

it('gives a By model role the Hashline tools on a Hashline family, and an unset writing role none', async () => {
  const offered: string[][] = [];
  const respond: FauxResponseStep = (context) => {
    offered.push(getCurrentTools(context.messages).map((tool) => tool.name));
    return fauxAssistantMessage('Done.');
  };
  for (const mode of ['model', undefined] as const) {
    const { transport } = liveRuntime([respond, respond]);
    const definition = linearCorral(['writer']);
    definition.roles = definition.roles.map((role) => ({
      ...role,
      allowedWorkTools: [
        'write_artifact',
        'read_file',
        'write_file',
      ] as typeof role.allowedWorkTools,
      ...(mode ? { editingMode: mode } : {}),
    }));
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: `cmd_mode_${mode ?? 'unset'}`,
      definition,
      mode: 'live',
    });
    if (!runId) throw new Error('the run did not start');
    await waitForProjection(transport, runId, (state) =>
      ['succeeded', 'failed', 'cancelled'].includes(state.status),
    );
  }
  expect(offered[0]).toEqual(expect.arrayContaining(['read_hashline', 'edit_hashline']));
  expect(offered.at(-1)).not.toContain('read_hashline');
});
