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
  countsForReview,
  REVIEW_ANSWER_MAX_LENGTH,
  REVIEW_INPUT_MAX_LENGTH,
  REVIEW_SHORT_ANSWER_LENGTH,
  REVIEW_TASK_MAX_LENGTH,
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
  redactCredentialsAndPaths,
  waitForProjection,
} from '../src/index.ts';

// The advisor's review input (docs/specs/features/advisor.md, 계약): what the watched execution
// produced after the advisor's cursor, built from the Run's public record only.

type Actor = RunEvent['actor'];
const AGENT: Actor = { kind: 'agent', id: 'agent' };
type ToolEnd =
  | { kind: 'finished'; resultRef?: string }
  | { kind: 'failed'; error: string }
  | { kind: 'blocked'; reason: string }
  | { kind: 'running' };

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

  get lastSeq(): number {
    return this.seq;
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

  runEnds(): this {
    return this.push('run.state_changed', { from: 'running', to: 'cancelled', reasonCode: 'x' });
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

  record(modelCallId: string, purpose: 'turn' | 'compaction' | 'retry' | 'extension'): this {
    return this.push('model.request_recorded', { modelCallId, purpose });
  }

  /** As the Coordinator records it: a whole response has a ref; a cut or failed one has none. */
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
    end: ToolEnd = { kind: 'finished' },
    actor: Actor = AGENT,
  ): this {
    this.push('tool.requested', { executionId, toolCallId, name, validatedArgs: args }, actor);
    if (end.kind === 'blocked')
      return this.push('tool.blocked', { executionId, toolCallId, reason: end.reason });
    this.push('effect.admitted', {
      effectId: `eff_${toolCallId}`,
      kind: 'tool',
      scope: executionId,
      epoch: 1,
      modelCallId: null,
    });
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

  cancelEffect(toolCallId: string): this {
    return this.push('effect.settled', { effectId: `eff_${toolCallId}`, outcome: 'cancelled' });
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
      run: extra.run ?? this.run(),
      events: this.events,
      executionId,
      cursor,
      taskInput: 'Write the release notes for version 2.',
      readResponse: (ref) => this.responses.get(ref) ?? null,
      ...extra,
    };
  }
}

/**
 * The projection of a large log, filled in place: reducing thousands of events one by one copies
 * the growing records each time and takes seconds, which is the fixture's cost, not the input's.
 */
function fastRun(log: Log): RunProjection {
  const run = new Log().execution(EXEC).run();
  const execution = run.executions[EXEC] as RunProjection['executions'][string];
  for (const event of log.events) {
    if (event.type === 'model.request_prepared') {
      const { modelCallId, executionId, contextSnapshotId, profile } = event.payload;
      run.modelCalls[modelCallId] = {
        modelCallId,
        executionId,
        contextSnapshotId,
        profile,
        configRevision: 0,
        directiveIds: [],
        inputArtifactVersionIds: [],
        finished: false,
        usage: null,
        rawUsage: null,
        certainty: null,
        responseRef: null,
      };
      execution.modelCallIds.push(modelCallId);
    } else if (event.type === 'model.finished') {
      const call = run.modelCalls[event.payload.modelCallId];
      if (call) Object.assign(call, { finished: true, responseRef: event.payload.responseRef });
    } else if (event.type === 'tool.requested') {
      const { toolCallId, executionId, name } = event.payload;
      run.toolCalls[toolCallId] = {
        toolCallId,
        executionId,
        name,
        status: 'requested',
        reason: null,
      };
    } else if (event.type === 'tool.finished') {
      const call = run.toolCalls[event.payload.toolCallId];
      if (call)
        Object.assign(call, {
          phase: event.payload.error ? 'failed' : 'finished',
          reason: event.payload.error,
          resultRef: event.payload.resultRef,
        });
    }
  }
  return run;
}

const EXEC = 'exec_a';
const HEAD = 'Request 1 · model fast';

/** One call with one tool row, and the tool row's text. */
function oneTool(args: Record<string, unknown>, end: ToolEnd = { kind: 'finished' }) {
  const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'Working.');
  log.tool(EXEC, 'tool_1', 'probe', args, end);
  const text = buildReviewInput(log.source(EXEC, null, { taskInput: null })).text;
  return text.split('\n').find((line) => line.startsWith('- probe')) ?? '';
}

describe('buildReviewInput: reading and the cursor', () => {
  it('returns nothing and keeps the cursor when nothing new was finished', () => {
    const log = new Log().execution(EXEC).prepare(EXEC, 'call_1');
    const first = buildReviewInput(log.source(EXEC, null));
    expect(first).toEqual({ text: '', cursor: null, calls: 0, trimmed: 0, dropped: 0 });

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
    expect(first.cursor).toEqual({ modelCallId: 'call_2', seq: log.lastSeq });
    expect(first.text).toContain('Answer one.');
    expect(first.text).toContain('Answer two.');

    log.call(EXEC, 'call_3', 'Answer three.');
    const second = buildReviewInput(log.source(EXEC, first.cursor));
    expect(second.calls).toBe(1);
    expect(second.cursor).toEqual({ modelCallId: 'call_3', seq: log.lastSeq });
    expect(second.text).toBe('Request 3 · model fast\nAnswer three.');
  });

  it('reads a cursor of another execution as no cursor, from the start', () => {
    const log = new Log()
      .execution(EXEC)
      .execution('exec_b')
      .call('exec_b', 'call_b1', 'Other.')
      .call(EXEC, 'call_1', 'Answer one.')
      .call(EXEC, 'call_2', 'Answer two.');
    const result = buildReviewInput(log.source(EXEC, { modelCallId: 'call_b1', seq: log.lastSeq }));
    expect(result.calls).toBe(2);
    expect(result.text.startsWith('Task input:')).toBe(true);
    expect(result.text).toContain('Answer one.');
  });

  it('starts the first review with the task input and leaves it out later', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'Answer one.');
    const first = buildReviewInput(log.source(EXEC, null));
    expect(first.text.startsWith('Task input:\nWrite the release notes for version 2.')).toBe(true);
    log.call(EXEC, 'call_2', 'Answer two.');
    const second = buildReviewInput(log.source(EXEC, first.cursor));
    expect(second.text).not.toContain('Task input');
  });

  it('leaves out a blank task input', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'Answer one.');
    const { text } = buildReviewInput(log.source(EXEC, null, { taskInput: '  \n ' }));
    expect(text).toBe(`${HEAD}\nAnswer one.`);
  });

  it('reads nothing of an unknown execution', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'Answer one.');
    expect(buildReviewInput(log.source('exec_missing', null)).text).toBe('');
  });

  it('reads only the watched execution', () => {
    const log = new Log()
      .execution(EXEC)
      .execution('exec_b')
      .call('exec_b', 'call_b1', 'Other role answer.')
      .tool('exec_b', 'tool_b1', 'read_file', { path: 'other.ts' })
      .call(EXEC, 'call_a1', 'Watched answer.')
      .prepare('exec_b', 'call_b2')
      .tool('exec_b', 'tool_b2', 'read_file', { path: 'other2.ts' })
      .tool(EXEC, 'tool_a1', 'read_file', { path: 'mine.ts' })
      .finish('exec_b', 'call_b2', 'Other again.');
    const result = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(result.calls).toBe(1);
    expect(result.text).toBe(
      `Request 1 · model fast\nWatched answer.\nTools:\n- read_file · mine.ts · finished`,
    );
    expect(result.cursor).toMatchObject({ modelCallId: 'call_a1' });
  });

  it('ignores tool calls before the first model call', () => {
    const log = new Log().execution(EXEC).tool(EXEC, 'tool_0', 'read_file', { path: 'early.ts' });
    expect(buildReviewInput(log.source(EXEC, null)).text).toBe('');
  });

  it('holds a running tool call back until it settles, then reports it once', () => {
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'Answer one.')
      .tool(EXEC, 'tool_1', 'read_file', { path: 'a.ts' })
      .tool(EXEC, 'tool_2', 'read_file', { path: 'b.ts' }, { kind: 'running' })
      .tool(EXEC, 'tool_3', 'read_file', { path: 'c.ts' });
    const first = buildReviewInput(log.source(EXEC, null));
    expect(first.text).toContain('- read_file · a.ts · finished');
    // The held row and every row after it wait.
    expect(first.text).not.toContain('b.ts');
    expect(first.text).not.toContain('c.ts');

    log.finishTool(EXEC, 'tool_2', { kind: 'failed', error: 'missing' });
    const second = buildReviewInput(log.source(EXEC, first.cursor));
    expect(second.calls).toBe(0);
    expect(second.text).toBe(
      `${HEAD} · answer read earlier\nTools:\n- read_file · b.ts · failed · missing\n- read_file · c.ts · finished`,
    );
    const third = buildReviewInput(log.source(EXEC, second.cursor));
    expect(third.text).toBe('');
    expect(third.cursor).toEqual(second.cursor);
  });

  it('holds the rows of a call not yet read', () => {
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'Answer one.')
      .prepare(EXEC, 'call_2')
      .tool(EXEC, 'tool_2', 'read_file', { path: 'late.ts' });
    const first = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(first.text).toBe(`${HEAD}\nAnswer one.`);
    log.finish(EXEC, 'call_2', 'Answer two.');
    const second = buildReviewInput(log.source(EXEC, first.cursor));
    expect(second.text).toBe(
      'Request 2 · model fast\nAnswer two.\nTools:\n- read_file · late.ts · finished',
    );
  });

  it('does not read again the row at the cursor sequence', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'Answer one.');
    const seq = log.lastSeq + 1;
    log.tool(EXEC, 'tool_1', 'read_file', { path: 'a.ts' });
    const result = buildReviewInput(log.source(EXEC, { modelCallId: 'call_1', seq }));
    expect(result.text).toBe('');
  });
});

describe('buildReviewInput: calls without a confirmed response', () => {
  it('marks an interrupted call and adds the text it received', () => {
    const log = new Log()
      .execution(EXEC)
      .prepare(EXEC, 'call_1')
      .finish(EXEC, 'call_1', null, { interrupted: true })
      .tool(EXEC, 'tool_1', 'list_files', { path: 'docs' });
    const result = buildReviewInput(
      log.source(EXEC, null, { taskInput: null, partialOutputs: { call_1: { text: 'Half a' } } }),
    );
    expect(result.calls).toBe(1);
    expect(result.text).toBe(
      `${HEAD} · interrupted · no confirmed response\nHalf a\nTools:\n- list_files · docs · finished`,
    );
  });

  it('marks a failed call, with its partial text or without it', () => {
    const log = new Log()
      .execution(EXEC)
      .prepare(EXEC, 'call_1')
      .finish(EXEC, 'call_1', null)
      .prepare(EXEC, 'call_2')
      .finish(EXEC, 'call_2', null)
      .tool(EXEC, 'tool_2', 'read_file', { path: 'a.md' });
    const result = buildReviewInput(
      log.source(EXEC, null, {
        taskInput: null,
        partialOutputs: { call_1: { text: 'Got so far' } },
      }),
    );
    expect(result.calls).toBe(2);
    expect(result.text).toBe(
      [
        `${HEAD} · no confirmed response\nGot so far`,
        'Request 2 · model fast · no confirmed response\nTools:\n- read_file · a.md · finished',
      ].join('\n\n'),
    );
  });

  it('closes an unfinished call when a later call follows it', () => {
    const log = new Log().execution(EXEC).prepare(EXEC, 'call_1').call(EXEC, 'call_2', 'Done.');
    const { text } = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(text).toBe(`${HEAD} · no confirmed response\n\nRequest 2 · model fast\nDone.`);
  });

  it('says when a finished response body is no longer available, or was empty', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'Gone.').call(EXEC, 'call_2', '');
    const result = buildReviewInput(
      log.source(EXEC, null, {
        taskInput: null,
        readResponse: (ref) => (ref === 'response_call_1' ? null : ''),
      }),
    );
    expect(result.text).toBe(
      `${HEAD}\n(response text no longer available)\n\nRequest 2 · model fast\n(empty response)`,
    );
  });
});

describe('buildReviewInput: after the watched execution or the Run ends', () => {
  it('closes the open call when the execution ends, and shows unfinished and cancelled tools', () => {
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'Answer one.')
      .tool(EXEC, 'tool_1', 'read_file', { path: 'a.ts' }, { kind: 'running' })
      .tool(EXEC, 'tool_2', 'read_file', { path: 'b.ts' }, { kind: 'running' })
      .cancelEffect('tool_2')
      .prepare(EXEC, 'call_2');
    expect(buildReviewInput(log.source(EXEC, null, { taskInput: null })).text).toBe(
      `${HEAD}\nAnswer one.`,
    );
    log.state(EXEC, 'active', 'failed');
    const { text } = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(text).toBe(
      [
        `${HEAD}\nAnswer one.\nTools:\n- read_file · a.ts · unfinished\n- read_file · b.ts · cancelled`,
        'Request 2 · model fast · no confirmed response',
      ].join('\n\n'),
    );
  });

  it('closes the open call when the Run ends', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'One.').prepare(EXEC, 'call_2');
    expect(buildReviewInput(log.source(EXEC, null)).calls).toBe(1);
    log.runEnds();
    const result = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(result.calls).toBe(2);
    expect(result.text).toContain('Request 2 · model fast · no confirmed response');
  });
});

describe('buildReviewInput: compaction and extension calls', () => {
  it('reads neither, counts neither, and passes them with the cursor', () => {
    const log = new Log()
      .execution(EXEC)
      .prepare(EXEC, 'call_1')
      .record('call_1', 'turn')
      .finish(EXEC, 'call_1', 'Answer one.')
      .tool(EXEC, 'tool_1', 'read_file', { path: 'a.ts' })
      .prepare(EXEC, 'call_2')
      .record('call_2', 'compaction')
      .finish(EXEC, 'call_2', 'SUMMARY OF EVERYTHING')
      .tool(EXEC, 'tool_2', 'read_file', { path: 'b.ts' })
      .prepare(EXEC, 'call_3')
      .record('call_3', 'retry')
      .finish(EXEC, 'call_3', 'Answer three.')
      .prepare(EXEC, 'call_4')
      .record('call_4', 'extension')
      .finish(EXEC, 'call_4', 'EXTENSION TEXT');
    const result = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(result.calls).toBe(2);
    expect(result.text).toBe(
      [
        `${HEAD}\nAnswer one.\nTools:\n- read_file · a.ts · finished\n- read_file · b.ts · finished`,
        'Request 3 · model fast\nAnswer three.',
      ].join('\n\n'),
    );
    expect(result.cursor).toMatchObject({ modelCallId: 'call_4' });
    expect(countsForReview(log.events, 'call_1')).toBe(true);
    expect(countsForReview(log.events, 'call_2')).toBe(false);
    expect(countsForReview(log.events, 'call_3')).toBe(true);
    expect(countsForReview(log.events, 'call_4')).toBe(false);
    expect(countsForReview(log.events, 'call_unrecorded')).toBe(true);
  });

  it('passes a new compaction call with an empty text', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'One.');
    const first = buildReviewInput(log.source(EXEC, null));
    log.prepare(EXEC, 'call_2').record('call_2', 'compaction').finish(EXEC, 'call_2', 'Summary');
    const second = buildReviewInput(log.source(EXEC, first.cursor));
    expect(second.text).toBe('');
    expect(second.calls).toBe(0);
    expect(second.cursor).toMatchObject({ modelCallId: 'call_2' });
  });
});

describe('buildReviewInput: tool rows', () => {
  it('shows name, target, status and summary and nothing from other arguments', () => {
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'Working.')
      .tool(EXEC, 'tool_1', 'read_file', { path: 'src/app.ts', token: 'sk-live-ARGSECRET' })
      .tool(
        EXEC,
        'tool_2',
        'write_file',
        { path: 'notes.md', text: 'ghp_FILESECRET' },
        { kind: 'failed', error: 'disk full' },
      )
      .tool(
        EXEC,
        'tool_3',
        'run_command',
        { command: 'pnpm test', env: 'API_KEY=ENVSECRET' },
        { kind: 'blocked', reason: 'not allowed in this mode' },
      )
      .artifact(EXEC, 'ver_1', 'Release notes\nsecond line', 'call_1')
      .tool(
        EXEC,
        'tool_4',
        'write_artifact',
        { text: 'BODYSECRET' },
        { kind: 'finished', resultRef: 'ver_1' },
      )
      .tool(EXEC, 'tool_5', 'read_artifact', { artifactVersionId: 'ver_1' })
      .tool(EXEC, 'tool_6', 'search', { query: { bytes: 9, sha256: 'b'.repeat(64) } })
      .tool(
        EXEC,
        'tool_7',
        'internal_probe',
        { path: 'x' },
        { kind: 'finished' },
        { kind: 'runtime', id: 'runtime' },
      );
    const { text } = buildReviewInput(log.source(EXEC, null));
    expect(text).toContain(
      [
        'Tools:',
        '- read_file · src/app.ts · finished',
        '- write_file · notes.md · failed · disk full',
        '- run_command · pnpm test · blocked · not allowed in this mode',
        '- write_artifact · Release notes v2 · finished',
        '- read_artifact · Release notes v2 · finished',
        '- search · finished',
      ].join('\n'),
    );
    for (const secret of ['ARGSECRET', 'FILESECRET', 'ENVSECRET', 'BODYSECRET', 'RAWUSAGESECRET'])
      expect(text).not.toContain(secret);
    expect(text).not.toContain('b'.repeat(64));
    expect(text).not.toContain('internal_probe');
  });

  it('reads no other key when none of the known ones is there', () => {
    expect(oneTool({ token: 'abc', env: 'X=1' })).toBe('- probe · finished');
  });

  it('takes the first known key, skipping blank ones', () => {
    expect(oneTool({ command: 'pnpm build', path: 'src/a.ts' })).toBe(
      '- probe · src/a.ts · finished',
    );
    expect(oneTool({ path: '   ', command: 'pnpm build' })).toBe('- probe · pnpm build · finished');
  });

  it('puts a long or multi-line target on one line of at most 200 characters', () => {
    expect(oneTool({ path: 'a\n  b\tc' })).toBe('- probe · a b c · finished');
    const long = oneTool({ path: 'p'.repeat(300) });
    expect(long).toBe(`- probe · ${'p'.repeat(199)}… · finished`);
  });

  it('leaves out a blank summary', () => {
    expect(oneTool({ path: 'a.ts' }, { kind: 'blocked', reason: '   ' })).toBe(
      '- probe · a.ts · blocked',
    );
  });

  it('masks credentials and paths in targets and summaries, not in answers or the task', () => {
    const roots = ['/home/u/proj'];
    const log = new Log()
      .execution(EXEC)
      .call(EXEC, 'call_1', 'I read /etc/hosts and sk-ANSWERKEY12345.')
      .tool(EXEC, 'tool_1', 'run_command', {
        command: 'curl -H "Authorization: Bearer abcdef123456" https://x.test',
      })
      .tool(EXEC, 'tool_2', 'run_command', { command: 'deploy --key sk-abcdefghijkl' })
      .tool(EXEC, 'tool_3', 'run_command', { command: 'GITHUB_TOKEN=ghp123 pnpm release' })
      .tool(EXEC, 'tool_4', 'fetch', { url: 'https://api.x.test/v1?api_key=k123&q=1' })
      .tool(EXEC, 'tool_5', 'read_file', { path: '/home/u/proj/src/a.ts' })
      .tool(
        EXEC,
        'tool_6',
        'read_file',
        { path: 'src/b.ts' },
        {
          kind: 'failed',
          error: 'ENOENT: /var/lib/secret/b.ts',
        },
      );
    const { text } = buildReviewInput(
      log.source(EXEC, null, { taskInput: 'Use /home/u/proj only.', workspaceRoots: roots }),
    );
    expect(text).toContain('Task input:\nUse /home/u/proj only.');
    expect(text).toContain('I read /etc/hosts and sk-ANSWERKEY12345.');
    expect(text).toContain('Bearer [redacted]');
    expect(text).toContain('- run_command · deploy --key [redacted] · finished');
    expect(text).toContain('- run_command · [credential redacted] pnpm release · finished');
    expect(text).toContain('[credential redacted]');
    expect(text).toContain('- read_file · [workspace]/src/a.ts · finished');
    expect(text).toContain('- read_file · src/b.ts · failed · ENOENT: [path]');
    for (const secret of ['abcdef123456', 'sk-abcdefghijkl', 'ghp123', 'k123', '/var/lib'])
      expect(text).not.toContain(secret);
    expect(redactCredentialsAndPaths('/home/u/proj/x and /opt/y', roots)).toBe(
      '[workspace]/x and [path]',
    );
  });
});

describe('buildReviewInput: limits', () => {
  it('keeps an answer of exactly 6,000 and cuts one longer with a marker', () => {
    expect(REVIEW_ANSWER_MAX_LENGTH).toBe(6000);
    const exact = new Log().execution(EXEC).call(EXEC, 'call_1', 'x'.repeat(6000));
    expect(buildReviewInput(exact.source(EXEC, null, { taskInput: null })).text).toBe(
      `${HEAD}\n${'x'.repeat(6000)}`,
    );
    const over = new Log().execution(EXEC).call(EXEC, 'call_1', 'x'.repeat(6001));
    expect(buildReviewInput(over.source(EXEC, null, { taskInput: null })).text).toBe(
      `${HEAD}\n${'x'.repeat(6000)}\n[... 1 more character left out]`,
    );
    const far = new Log().execution(EXEC).call(EXEC, 'call_1', 'x'.repeat(7234));
    expect(buildReviewInput(far.source(EXEC, null, { taskInput: null })).text).toContain(
      '\n[... 1234 more characters left out]',
    );
  });

  it('never cuts a surrogate pair in half', () => {
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', `${'a'.repeat(5999)}😀tail`);
    const { text } = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(text).toBe(`${HEAD}\n${'a'.repeat(5999)}\n[... 6 more characters left out]`);
  });

  it('caps the task input at 6,000', () => {
    expect(REVIEW_TASK_MAX_LENGTH).toBe(6000);
    const log = new Log().execution(EXEC).call(EXEC, 'call_1', 'One.');
    const { text } = buildReviewInput(log.source(EXEC, null, { taskInput: 't'.repeat(7000) }));
    expect(
      text.startsWith(`Task input:\n${'t'.repeat(6000)}\n[... 1000 more characters left out]\n\n`),
    ).toBe(true);
  });

  it('keeps a text of exactly 24,000 whole and starts reducing at 24,001', () => {
    expect(REVIEW_INPUT_MAX_LENGTH).toBe(24000);
    // Three 6,000 answers and a fourth sized so the whole text is exactly the total.
    const build = (last: number) => {
      const log = new Log().execution(EXEC);
      for (let call = 1; call <= 3; call++) log.call(EXEC, `call_${call}`, 'x'.repeat(6000));
      log.call(EXEC, 'call_4', 'y'.repeat(last));
      return buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    };
    const exact = build(5902);
    expect(exact.text.length).toBe(24000);
    expect(exact.text).not.toContain('Note:');
    const over = build(5903);
    expect(over.text.length).toBeLessThanOrEqual(24000);
    expect(over.text.startsWith('Note: 1 answer shortened to 500 characters to fit.')).toBe(true);
    expect(over.text).toContain(`Request 1 · model fast\n${'x'.repeat(500)}\n[... 5500 more`);
    expect(over.text).toContain(`${'x'.repeat(6000)}\n\nRequest 4`);
  });

  it('leaves out the oldest tool summaries first, only as many as needed', () => {
    const log = new Log().execution(EXEC);
    for (let call = 1; call <= 4; call++) {
      log.call(EXEC, `call_${call}`, `${call}`.repeat(5000));
      for (let tool = 1; tool <= 6; tool++)
        log.tool(
          EXEC,
          `tool_${call}_${tool}`,
          'read_file',
          { path: `src/${call}/${tool}.ts` },
          { kind: 'failed', error: `summary-${call}-${tool} ${'e'.repeat(150)}` },
        );
    }
    const result = buildReviewInput(log.source(EXEC, null));
    expect(result.text.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX_LENGTH);
    expect(result.text.length).toBeGreaterThan(REVIEW_INPUT_MAX_LENGTH - 200);
    expect(result.calls).toBe(4);
    expect(result.dropped).toBe(0);
    expect(result.trimmed).toBeGreaterThan(1);
    expect(result.trimmed).toBeLessThan(24);
    expect(
      result.text.startsWith(`Note: ${result.trimmed} tool summaries left out to fit.\n\n`),
    ).toBe(true);
    expect(result.text).not.toContain('summary-1-1');
    expect(result.text).toContain('summary-4-6');
    expect(result.text).toContain('- read_file · src/1/1.ts · failed\n');
    expect(result.text).toContain('4'.repeat(5000));
    expect(result.text).toContain('1'.repeat(5000));
  });

  it('says one summary in the singular', () => {
    const log = new Log().execution(EXEC);
    for (let call = 1; call <= 3; call++) log.call(EXEC, `call_${call}`, 'x'.repeat(6000));
    log.call(EXEC, 'call_4', 'y'.repeat(5770));
    // A blank reason is no summary: there is nothing to leave out, so it is not counted.
    log.tool(EXEC, 'tool_0', 'read_file', { path: 'z.ts' }, { kind: 'blocked', reason: '  ' });
    log.tool(
      EXEC,
      'tool_1',
      'read_file',
      { path: 'a.ts' },
      { kind: 'failed', error: 'e'.repeat(150) },
    );
    const result = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(result.trimmed).toBe(1);
    expect(result.text.startsWith('Note: 1 tool summary left out to fit.\n\n')).toBe(true);
  });

  it('keeps every call when the task and answers alone are over: answers are shortened', () => {
    const repro1 = new Log().execution(EXEC);
    for (let call = 1; call <= 3; call++) repro1.call(EXEC, `call_${call}`, `${call}`.repeat(6000));
    const one = buildReviewInput(repro1.source(EXEC, null, { taskInput: 't'.repeat(6000) }));
    expect(one.dropped).toBe(0);
    expect(one.calls).toBe(3);
    expect(one.text.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX_LENGTH);
    expect(one.text).toContain('3'.repeat(6000));

    for (const count of [4, 6]) {
      const log = new Log().execution(EXEC);
      for (let call = 1; call <= count; call++) log.call(EXEC, `call_${call}`, 'z'.repeat(6000));
      const result = buildReviewInput(log.source(EXEC, null));
      expect(result.dropped).toBe(0);
      expect(result.calls).toBe(count);
      expect(result.text.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX_LENGTH);
      for (let call = 1; call <= count; call++)
        expect(result.text).toContain(`Request ${call} · model fast\nzzz`);
      expect(result.text).toMatch(/^Note: \d answers? shortened to 500 characters to fit\./);
      expect(result.text.endsWith('z'.repeat(6000))).toBe(true);
    }
    expect(REVIEW_SHORT_ANSWER_LENGTH).toBe(500);
  });

  it('turns the oldest tool lists into a count before leaving out any call', () => {
    const log = new Log().execution(EXEC);
    for (let call = 1; call <= 3; call++) {
      log.call(EXEC, `call_${call}`, 'x'.repeat(400));
      for (let tool = 1; tool <= 120; tool++)
        log.tool(EXEC, `tool_${call}_${tool}`, 'read_file', {
          path: `src/${call}/${'f'.repeat(40)}${tool}.ts`,
        });
    }
    const result = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(result.dropped).toBe(0);
    expect(result.text.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX_LENGTH);
    expect(result.text).toMatch(/^Note: \d tool lists? reduced to a count to fit\./);
    expect(result.text).toContain(`Request 1 · model fast\n${'x'.repeat(400)}\nTools: 120 calls`);
    expect(result.text).toContain('src/3/');
  });

  it('leaves out whole oldest calls only when the rest cannot fit fully reduced', () => {
    const log = new Log().execution(EXEC);
    for (let call = 1; call <= 70; call++) {
      log.call(EXEC, `call_${call}`, 'q'.repeat(600));
      log.tool(EXEC, `tool_${call}`, 'read_file', { path: `f${call}.ts` });
    }
    const result = buildReviewInput(log.source(EXEC, null, { taskInput: null }));
    expect(result.dropped).toBeGreaterThan(0);
    expect(result.calls).toBe(70 - result.dropped);
    expect(result.text.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX_LENGTH);
    // One more call would not have fitted.
    expect(result.text.length).toBeGreaterThan(REVIEW_INPUT_MAX_LENGTH - 700);
    expect(result.text).toContain(`Note: ${result.dropped} oldest requests left out to fit.`);
    expect(result.text).not.toContain(`Request ${result.dropped} · `);
    expect(result.text).toContain(`Request ${result.dropped + 1} · `);
    // The newest call keeps its rows.
    expect(result.text).toContain('Request 70 · model fast\n');
    expect(result.text).toContain('- read_file · f70.ts · finished');
    expect(result.cursor).toMatchObject({ modelCallId: 'call_70' });
  });

  it('fits a large review quickly', () => {
    const log = new Log().execution(EXEC);
    let tools = 0;
    for (let call = 1; call <= 120; call++) {
      log.call(EXEC, `call_${call}`, 'w'.repeat(3000));
      for (let tool = 0; tool < 25; tool++, tools++)
        log.tool(
          EXEC,
          `tool_${call}_${tool}`,
          'read_file',
          { path: `src/${tool}.ts` },
          { kind: 'failed', error: `error ${tools} ${'e'.repeat(100)}` },
        );
    }
    expect(log.events.length).toBeGreaterThan(9000);
    const source = log.source(EXEC, null, { run: fastRun(log) });
    const started = Date.now();
    const result = buildReviewInput(source);
    const elapsed = Date.now() - started;
    expect(result.text.length).toBeLessThanOrEqual(REVIEW_INPUT_MAX_LENGTH);
    expect(result.trimmed).toBeGreaterThan(1000);
    expect(elapsed).toBeLessThan(1000);
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
});

describe('buildReviewInput on a Coordinator Run', () => {
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
    expect(result.cursor?.modelCallId).toBe(projection.executions[executionId]?.modelCallIds[1]);
  });
});
