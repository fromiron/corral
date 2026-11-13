import type { ModelProfileSnapshot, RunEvent } from '@corral/contracts';
import {
  FakeClock,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  buildReviewInput,
  REVIEW_ANSWER_MAX_LENGTH,
  REVIEW_INPUT_MAX_LENGTH,
  type ReviewCursor,
  type ReviewInputSource,
} from '../src/advisor/delta.ts';
import {
  applyEvent,
  Coordinator,
  emptyProjection,
  InMemoryRunStore,
  InProcessTransport,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

// The advisor's review input (docs/specs/features/advisor.md, 계약): what the watched execution
// produced after the advisor's cursor, built from the Run's public record only.

type Actor = RunEvent['actor'];
const AGENT: Actor = { kind: 'agent', id: 'agent' };

class Log {
  readonly events: RunEvent[] = [];
  readonly responses = new Map<string, string>();
  private seq = 0;

  push(type: RunEvent['type'], payload: Record<string, unknown>, actor: Actor = AGENT): this {
    this.seq++;
    this.events.push({
      schemaVersion: '0.1',
      eventId: `evt_${this.seq}`,
      runId: 'run_1',
      runSeq: this.seq,
      recordedAt: '2026-01-01T00:00:00.000Z',
      actor,
      causedByEventIds: [],
      type,
      payload,
    } as unknown as RunEvent);
    return this;
  }

  execution(executionId: string): this {
    this.push('execution.created', {
      executionId,
      parentExecutionId: null,
      nodeId: `node_${executionId}`,
      taskId: `task_${executionId}`,
      attemptNo: 1,
      depth: 0,
      iterationId: null,
      modelProfile: 'fast',
    });
    return this.state(executionId, 'queued', 'active');
  }

  state(executionId: string, from: string, to: string): this {
    return this.push('execution.state_changed', {
      executionId,
      from,
      to,
      activity: null,
      waitingOn: null,
    });
  }

  prepare(executionId: string, modelCallId: string): this {
    return this.push('model.request_prepared', {
      executionId,
      modelCallId,
      contextSnapshotId: `ctx_${modelCallId}`,
      profile: 'fast',
      configRevision: 0,
      directiveIds: [],
      inputArtifactVersionIds: [],
    });
  }

  finish(
    executionId: string,
    modelCallId: string,
    text: string | null,
    extra: { interrupted?: true } = {},
  ): this {
    const responseRef = text === null ? null : `response_${modelCallId}`;
    if (responseRef && text !== null) this.responses.set(responseRef, text);
    return this.push('model.finished', {
      executionId,
      modelCallId,
      responseRef,
      rawUsage: { apiKey: 'sk-live-RAWUSAGESECRET' },
      normalizedUsage: {
        inputTokens: 1,
        outputTokens: 1,
        cachedInputTokens: null,
        reasoningTokens: null,
      },
      certainty: 'reported',
      ...extra,
    });
  }

  call(executionId: string, modelCallId: string, text: string): this {
    return this.prepare(executionId, modelCallId).finish(executionId, modelCallId, text);
  }

  tool(
    executionId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>,
    end:
      | { kind: 'finished'; resultRef?: string }
      | { kind: 'failed'; error: string }
      | { kind: 'blocked'; reason: string }
      | { kind: 'running' } = { kind: 'finished' },
    actor: Actor = AGENT,
  ): this {
    this.push('tool.requested', { executionId, toolCallId, name, validatedArgs: args }, actor);
    if (end.kind === 'blocked')
      return this.push('tool.blocked', { executionId, toolCallId, reason: end.reason });
    this.push('tool.started', { executionId, toolCallId, effectId: `eff_${toolCallId}` });
    if (end.kind === 'running') return this;
    return this.finishTool(executionId, toolCallId, end);
  }

  finishTool(
    executionId: string,
    toolCallId: string,
    end: { kind: 'finished'; resultRef?: string } | { kind: 'failed'; error: string },
  ): this {
    return this.push('tool.finished', {
      executionId,
      toolCallId,
      resultRef: end.kind === 'finished' ? (end.resultRef ?? `result_${toolCallId}`) : null,
      error: end.kind === 'failed' ? end.error : null,
    });
  }

  artifact(executionId: string, artifactVersionId: string, name: string, modelCallId: string) {
    return this.push('artifact.version_created', {
      artifactVersionId,
      artifactId: `art_${artifactVersionId}`,
      version: 2,
      parentVersionId: null,
      name,
      contract: { kind: 'text' },
      contentHash: 'a'.repeat(64),
      byteLength: 1,
      authorExecutionId: executionId,
      modelCallId,
      contextSnapshotId: null,
    });
  }

  run(): RunProjection {
    return this.events.reduce(applyEvent, emptyProjection('run_1'));
  }

  source(
    executionId: string,
    cursor: ReviewCursor | null,
    extra: Partial<ReviewInputSource> = {},
  ): ReviewInputSource {
    return {
      run: this.run(),
      events: this.events,
      executionId,
      cursor,
      taskInput: 'Write the release notes for version 2.',
      readResponse: (ref) => this.responses.get(ref) ?? null,
      ...extra,
    };
  }
}

const EXEC = 'exec_a';

describe('buildReviewInput', () => {
  it('returns nothing and keeps the cursor when nothing new was finished', () => {
    const log = new Log().execution(EXEC).prepare(EXEC, 'call_1');
    const first = buildReviewInput(log.source(EXEC, null));
    expect(first).toEqual({ text: '', cursor: null, calls: 0, trimmed: 0 });

    log.finish(EXEC, 'call_1', 'First answer.');
    const read = buildReviewInput(log.source(EXEC, null));
    expect(read.calls).toBe(1);
    const again = buildReviewInput(log.source(EXEC, read.cursor));
    expect(again.text).toBe('');
    expect(again.calls).toBe(0);
    expect(again.cursor).toEqual(read.cursor);
  });

  it('advances the cursor so the next review reads only what came after', () => {
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'Answer one.')
      .call(EXEC, 'call_2', 'Answer two.');
    const first = buildReviewInput(log.source(EXEC, null));
    expect(first.calls).toBe(2);
    expect(first.cursor).toMatchObject({ modelCallId: 'call_2', no: 2 });
    expect(first.text).toContain('Answer one.');
    expect(first.text).toContain('Answer two.');

    log.call(EXEC, 'call_3', 'Answer three.');
    const second = buildReviewInput(log.source(EXEC, first.cursor));
    expect(second.calls).toBe(1);
    expect(second.cursor).toMatchObject({ modelCallId: 'call_3', no: 3 });
    expect(second.text).toContain('Request 3');
    expect(second.text).toContain('Answer three.');
    expect(second.text).not.toContain('Answer one.');
    expect(second.text).not.toContain('Answer two.');
  });

  it('starts the first review with the task input and leaves it out later', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'Answer one.');
    const first = buildReviewInput(log.source(EXEC, null));
    expect(first.text.startsWith('Task input:\nWrite the release notes for version 2.')).toBe(true);
    log.call(EXEC, 'call_2', 'Answer two.');
    const second = buildReviewInput(log.source(EXEC, first.cursor));
    expect(second.text).not.toContain('Task input');
    expect(second.text).not.toContain('release notes');
  });

  it('cuts an answer at the per-call cap with a marker that says how much was left out', () => {
    const long = 'x'.repeat(REVIEW_ANSWER_MAX_LENGTH + 1234);
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', long);
    const { text } = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(REVIEW_ANSWER_MAX_LENGTH).toBe(6000);
    expect(text).toContain(
      `${'x'.repeat(REVIEW_ANSWER_MAX_LENGTH)}\n[... 1234 more characters left out]`,
    );
    expect(text).not.toContain('x'.repeat(REVIEW_ANSWER_MAX_LENGTH + 1));
  });

  it('shortens the oldest tool summaries first to fit the total and says how many', () => {
    const log = new Log().execution(EXEC);
    for (let call = 1; call <= 4; call++) {
      log.call(EXEC, `call_${call}`, `${call}`.repeat(5000));
      for (let tool = 1; tool <= 6; tool++)
        log.tool(
          EXEC,
          `tool_${call}_${tool}`,
          'read_file',
          { path: `src/${call}/${tool}.ts` },
          {
            kind: 'failed',
            error: `summary-${call}-${tool} ${'e'.repeat(150)}`,
          },
        );
    }
    const result = buildReviewInput(log.source(EXEC, null));
    expect(REVIEW_INPUT_MAX_LENGTH).toBe(24000);
    expect(result.text.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX_LENGTH);
    expect(result.calls).toBe(4);
    expect(result.trimmed).toBeGreaterThan(0);
    expect(result.text).toContain(`Note: ${result.trimmed} tool summaries left out to fit.`);
    // The oldest call lost its summaries; the newest kept them; every row kept its target.
    expect(result.text).not.toContain('summary-1-1');
    expect(result.text).toContain('summary-4-6');
    expect(result.text).toContain('- read_file · src/1/1.ts · failed');
    expect(result.text).toContain('- read_file · src/4/6.ts · failed');
    expect(result.text).toContain('4'.repeat(5000));
    expect(result.text).toContain('1'.repeat(5000));
  });

  it('drops whole oldest calls when the answers alone exceed the total and says how many', () => {
    const log = new Log().execution(EXEC);
    for (let call = 1; call <= 5; call++)
      log.call(EXEC, `call_${call}`, String.fromCharCode(96 + call).repeat(6000));
    const result = buildReviewInput(log.source(EXEC, null));
    expect(result.text.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX_LENGTH);
    expect(result.calls).toBeLessThan(5);
    expect(result.calls).toBeGreaterThan(0);
    const left = 5 - result.calls;
    expect(result.text).toContain(`Note: ${left} oldest requests left out to fit.`);
    expect(result.text).not.toContain('a'.repeat(6000));
    expect(result.text).toContain('e'.repeat(6000));
    // The cursor still passes the dropped calls: they are not read again.
    expect(result.cursor).toMatchObject({ modelCallId: 'call_5', no: 5 });
  });

  it('marks an interrupted call with its partial text, and keeps tool rows when it has none', () => {
    const log = new Log()
      .execution(EXEC)
      // call_1 never finished: the execution moved on to call_2.
      .prepare(EXEC, 'call_1')
      .prepare(EXEC, 'call_2')
      .finish(EXEC, 'call_2', 'Cut short reply.', { interrupted: true })
      .tool(EXEC, 'tool_2', 'list_files', { path: 'docs' })
      .prepare(EXEC, 'call_3')
      .tool(EXEC, 'tool_3', 'read_file', { path: 'docs/a.md' })
      .call(EXEC, 'call_4', 'Done.');
    // call_3 has no response at all and no partial text.
    const result = buildReviewInput(
      log.source(EXEC, null, { partialOutputs: { call_1: { text: 'Half a thought' } } }),
    );
    expect(result.calls).toBe(4);
    expect(result.text).toContain('Request 1 · model fast · interrupted\nHalf a thought');
    expect(result.text).toContain('Request 2 · model fast · interrupted\nCut short reply.');
    expect(result.text).toContain('Request 3 · model fast · no confirmed response\nTools:');
    expect(result.text).toContain('- read_file · docs/a.md · finished');
    expect(result.text).toContain('Request 4 · model fast\nDone.');
  });

  it('says when a finished response body is no longer available', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'Gone.');
    const result = buildReviewInput(log.source(EXEC, null, { readResponse: () => null }));
    expect(result.calls).toBe(1);
    expect(result.text).toContain('Request 1 · model fast\n(response text no longer available)');
    expect(result.text).not.toContain('Gone.');
  });

  it('shows name, target, status and summary per tool row and nothing from other arguments', () => {
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'Working.')
      .tool(EXEC, 'tool_1', 'read_file', { path: 'src/app.ts', token: 'sk-live-ARGSECRET' })
      .tool(
        EXEC,
        'tool_2',
        'write_file',
        { path: 'notes.md', text: 'ghp_FILESECRET' },
        {
          kind: 'failed',
          error: 'disk full',
        },
      )
      .tool(
        EXEC,
        'tool_3',
        'run_command',
        { command: 'pnpm test', env: 'API_KEY=ENVSECRET' },
        {
          kind: 'blocked',
          reason: 'not allowed in this mode',
        },
      )
      .artifact(EXEC, 'ver_1', 'Release notes\nsecond line', 'call_1')
      .tool(
        EXEC,
        'tool_4',
        'write_artifact',
        { text: 'BODYSECRET' },
        {
          kind: 'finished',
          resultRef: 'ver_1',
        },
      )
      .tool(EXEC, 'tool_5', 'search', { query: { bytes: 9, sha256: 'b'.repeat(64) } })
      .tool(
        EXEC,
        'tool_6',
        'internal_probe',
        { path: 'x' },
        { kind: 'finished' },
        {
          kind: 'runtime',
          id: 'runtime',
        },
      );
    const { text } = buildReviewInput(log.source(EXEC, null));
    expect(text).toContain(
      [
        'Tools:',
        '- read_file · src/app.ts · finished',
        '- write_file · notes.md · failed · disk full',
        '- run_command · pnpm test · blocked · not allowed in this mode',
        '- write_artifact · Release notes v2 · finished',
        '- search · finished',
      ].join('\n'),
    );
    for (const secret of ['ARGSECRET', 'FILESECRET', 'ENVSECRET', 'BODYSECRET', 'RAWUSAGESECRET'])
      expect(text).not.toContain(secret);
    expect(text).not.toContain('b'.repeat(64));
    expect(text).not.toContain('internal_probe');
  });

  it('holds a running tool call back until it settles, then reports it once', () => {
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'Answer one.')
      .tool(EXEC, 'tool_1', 'read_file', { path: 'a.ts' })
      .tool(EXEC, 'tool_2', 'read_file', { path: 'b.ts' }, { kind: 'running' });
    const first = buildReviewInput(log.source(EXEC, null));
    expect(first.text).toContain('- read_file · a.ts · finished');
    expect(first.text).not.toContain('b.ts');

    log.finishTool(EXEC, 'tool_2', { kind: 'failed', error: 'missing' });
    const second = buildReviewInput(log.source(EXEC, first.cursor));
    expect(second.calls).toBe(0);
    expect(second.text).toBe(
      'Request 1 · model fast · answer read earlier\nTools:\n- read_file · b.ts · failed · missing',
    );
    const third = buildReviewInput(log.source(EXEC, second.cursor));
    expect(third.text).toBe('');
    expect(third.cursor).toEqual(second.cursor);
  });

  it('reads only the watched execution', () => {
    const log = new Log()
      .execution(EXEC)
      .execution('exec_b')
      .call('exec_b', 'call_b1', 'Other role answer.')
      .tool('exec_b', 'tool_b1', 'read_file', { path: 'other.ts' })
      .call(EXEC, 'call_a1', 'Watched answer.')
      // Interleaved after the watched call: it must not be read as that call's tool.
      .tool('exec_b', 'tool_b2', 'read_file', { path: 'other2.ts' })
      .call('exec_b', 'call_b2', 'Other again.');
    const result = buildReviewInput(log.source(EXEC, null));
    expect(result.calls).toBe(1);
    expect(result.text).toContain('Watched answer.');
    expect(result.text).not.toContain('Other');
    expect(result.text).not.toContain('other.ts');
    expect(result.text).not.toContain('other2.ts');
    expect(result.text).not.toContain('Tools:');
    expect(result.cursor).toMatchObject({ modelCallId: 'call_a1', no: 1 });
  });

  it('names the resolved model and gives the same bytes for the same input', () => {
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'Answer.')
      .tool(EXEC, 'tool_1', 'read_file', { path: 'a.ts' });
    const run = log.run();
    const source = {
      ...log.source(EXEC, null),
      run: {
        ...run,
        modelProfiles: { fast: { modelId: 'model-x' } as unknown as ModelProfileSnapshot },
      },
    };
    const one = buildReviewInput(source);
    const two = buildReviewInput(source);
    expect(one).toEqual(two);
    expect(one.text).toBe(
      [
        'Task input:',
        'Write the release notes for version 2.',
        '',
        'Request 1 · model model-x',
        'Answer.',
        'Tools:',
        '- read_file · a.ts · finished',
      ].join('\n'),
    );
  });

  it('reads a scripted Run the way the Coordinator records it', async () => {
    const definition = linearCorral(['writer']);
    definition.roles[0]?.allowedWorkTools.push('read_document');
    const store = new InMemoryRunStore();
    const agents = new ScriptedAgentAdapter({
      turns: 1,
      script: async (_input, host) => {
        const first = await host.prepareModelRequest();
        await host.modelRequestDispatched?.(first.modelCallId);
        await host.observe({
          kind: 'model_completed',
          modelCallId: first.modelCallId,
          text: 'Reading the source.',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        await host.invokeTool({ name: 'read_document', args: { documentId: 'doc_1' } });
        const second = await host.prepareModelRequest();
        await host.modelRequestDispatched?.(second.modelCallId);
        await host.observe({
          kind: 'model_completed',
          modelCallId: second.modelCallId,
          text: 'Read it.',
          usage: { inputTokens: 1, outputTokens: 1 },
        });
        return { outcome: 'failed', error: 'no output submitted' };
      },
    });
    const transport = new InProcessTransport(
      new Coordinator({
        store,
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents,
        tools: {
          execute: async () => ({
            documentId: 'doc_1',
            title: 'Source',
            mimeType: 'text/plain',
            text: 'Immutable source text.',
          }),
        },
      }),
    );
    const { runId } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'start',
      definition,
      mode: 'mock',
    });
    if (!runId) throw new Error('run start failed');
    await waitForProjection(transport, runId, (p) =>
      Object.values(p.executions).some((e) => e.status === 'failed'),
    );
    const { projection } = await transport.getSnapshot(runId);
    const executionId = projection.executionOrder[0];
    if (!executionId) throw new Error('missing execution');
    const result = buildReviewInput({
      run: projection,
      events: store.readEvents(runId, 0),
      executionId,
      cursor: null,
      taskInput: null,
      readResponse: (ref) => store.getArtifactText(runId, ref),
    });
    expect(result.calls).toBe(2);
    expect(result.text).toMatch(/^Request 1 · model \S+\n/);
    expect(result.text).toContain('- read_document · finished');
    expect(result.text).toContain('Request 2 · model');
    expect(result.cursor).toMatchObject({ no: 2 });
  });
});
