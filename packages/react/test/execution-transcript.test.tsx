import { Coordinator, InProcessTransport, waitForProjection } from '@corral/core';
import {
  collaborationCorral,
  FakeClock,
  Gate,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { act, render, screen, within } from '@testing-library/react';
import { IntlProvider } from 'use-intl';
import { describe, expect, it } from 'vitest';
import { ExecutionTranscript } from '../src/components/ExecutionTranscript.tsx';
import messages from '../src/messages/en.json' with { type: 'json' };
import { createRunSession } from '../src/run/session.ts';
import { buildTranscript } from '../src/run/transcript.ts';

// The per-execution conversation (roadmap UX-A3): requests, streamed replies, tools,
// questions and the person's instructions, from committed events only.

async function drain() {
  for (let i = 0; i < 300; i++) await Promise.resolve();
}

async function collaborationRun(options: { steerWriter?: string } = {}) {
  const clock = new FakeClock();
  const writerGate = new Gate();
  const transport = new InProcessTransport(
    new Coordinator({
      clock,
      timers: clock,
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({
        turns: 2,
        reply: (turn, input) => `Reply ${turn} from ${input.nodeId}.`,
        beforeReply: (turn, input) =>
          options.steerWriter && input.nodeId === 'write' && turn === 1
            ? writerGate.wait()
            : Promise.resolve(),
      }),
    }),
  );
  const { runId } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_start',
    definition: collaborationCorral(),
    mode: 'mock',
  });
  if (!runId) throw new Error('no run');
  if (options.steerWriter) {
    for (let i = 0; i < 200 && writerGate.waiting === 0; i++) await drain();
    const p = (await transport.getSnapshot(runId)).projection;
    const writer = p.executionOrder.find((id) => p.executions[id]?.nodeId === 'write') ?? '';
    await transport.sendCommand({
      schemaVersion: '0.1',
      commandId: 'cmd_steer',
      runId,
      type: 'steer',
      payload: { targetExecutionId: writer, text: options.steerWriter, delivery: 'next_request' },
    });
    writerGate.open();
  }
  await waitForProjection(transport, runId, (p) => p.status === 'succeeded');
  const session = createRunSession(transport, () => `cmd_${Math.random()}`);
  await session.getState().open(runId);
  await drain();
  const state = session.getState();
  const projection = state.projection;
  if (!projection) throw new Error('no projection');
  const writer = projection.executionOrder.find(
    (id) => projection.executions[id]?.nodeId === 'write',
  );
  return { session, writer: writer ?? '', state };
}

describe('buildTranscript (UX-A3)', () => {
  it('[TC-OBS-001-H] puts one execution’s requests, replies, tools, question and versions in order', async () => {
    const { state, writer } = await collaborationRun();
    const entries = buildTranscript(state.events, state.projection, state.streams, writer);
    const kinds = entries.map((e) => e.kind);
    expect(kinds[0]).toBe('started');
    expect(kinds).toContain('question');
    expect(kinds.filter((k) => k === 'request')).toHaveLength(2);
    expect(kinds.filter((k) => k === 'reply')).toHaveLength(2);
    expect(kinds.at(-1)).toBe('settled');
    // The question comes before the requests that use its answer.
    expect(kinds.indexOf('question')).toBeLessThan(kinds.indexOf('request'));
    const question = entries.find((e) => e.kind === 'question');
    expect(question?.kind === 'question' && question.status).toBe('answered');
    expect(question?.kind === 'question' && question.answer).toContain('Reply 1 from respond');
    const reply = entries.find((e) => e.kind === 'reply');
    expect(reply?.kind === 'reply' && reply.text).toContain('Reply 1 from write');
    const tools = entries.flatMap((e) => (e.kind === 'tool' ? [`${e.name}:${e.status}`] : []));
    expect(tools).toEqual(
      expect.arrayContaining(['write_artifact:finished', 'submit_result:finished']),
    );
  });

  it('[TC-OBS-001-N] another execution’s facts never appear, and an unknown execution has no entries', async () => {
    const { state, writer } = await collaborationRun();
    const entries = buildTranscript(state.events, state.projection, state.streams, writer);
    expect(entries.every((e) => !('text' in e) || !String(e.text).includes('from research'))).toBe(
      true,
    );
    expect(buildTranscript(state.events, state.projection, state.streams, 'exec_9999')).toEqual([]);
  });
});

describe('ExecutionTranscript (UX-A3)', () => {
  it('[TC-OBS-001-N] completed tool-only replies do not look like pending model requests', async () => {
    const { session, writer } = await collaborationRun();
    session.setState((state) => ({
      streams: Object.fromEntries(
        Object.entries(state.streams).map(([id, stream]) => [id, { ...stream, text: '' }]),
      ),
    }));
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ExecutionTranscript session={session} executionId={writer} />
      </IntlProvider>,
    );
    expect(screen.queryByText(messages.Transcript.waiting)).not.toBeInTheDocument();
    expect(screen.getAllByText('Response complete · no text')).toHaveLength(2);
  });
  it('[TC-RNS-010-H] shows the person’s instruction with where it went, and the reply that followed it', async () => {
    const { session, writer } = await collaborationRun({ steerWriter: 'Cite the vendor docs.' });
    render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <ExecutionTranscript session={session} executionId={writer} />
      </IntlProvider>,
    );
    await act(async () => {});
    const log = screen.getByRole('log', { name: 'Conversation' });
    const instruction = within(log).getByTestId(/^transcript-instruction-/);
    expect(instruction.textContent).toContain('You');
    expect(instruction.textContent).toContain('Cite the vendor docs.');
    expect(instruction.textContent).toContain('Included in a model request');
    expect(log.textContent).toContain('Reply 2 from write');
    expect(log.textContent).toContain('Asked Source Responder');
  });

  it('[TC-RNS-010-N] an instruction is shown on the request it reached, not on an earlier one', async () => {
    const { state, writer } = await collaborationRun({ steerWriter: 'Cite the vendor docs.' });
    const entries = buildTranscript(state.events, state.projection, state.streams, writer);
    const requests = entries.filter((e) => e.kind === 'request');
    const delivered = requests.map((r) => (r.kind === 'request' ? r.directives.length : 0));
    // Accepted while request 1 was already out, so it reaches request 2, not request 1.
    expect(delivered).toEqual([0, 1]);
    const at = entries.findIndex((e) => e.kind === 'instruction');
    const requestAt = entries.flatMap((e, i) => (e.kind === 'request' ? [i] : []));
    expect(at).toBeGreaterThan(requestAt[0] ?? -1);
    expect(at).toBeLessThan(requestAt[1] ?? -1);
  });
});
