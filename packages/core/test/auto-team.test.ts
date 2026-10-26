import {
  AUTO_TEMPLATE_VERSION,
  AUTO_TEMPLATES,
  type AutoModelChoice,
  DEFAULT_LIMITS,
  type RunEvent,
} from '@corral/contracts';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  autoDefinition,
  Coordinator,
  createAutoStarter,
  InMemoryRunStore,
  InProcessTransport,
  localAutoRoute,
  parseAutoRoute,
  planRun,
  type RouteAnswer,
  waitForProjection,
} from '../src/index.ts';

// a session without a chosen team runs in auto mode. A start model picks one of the
// built-in templates; tools, wiring and limits come from the template, and the choice is
// recorded with the run it started.

const CHOICE: AutoModelChoice = {
  modelProfile: 'model-b',
  reasoning: { mode: 'fixed', level: 'low' },
};
const WRITERS = new Set(['worker', 'writer']);

describe('auto templates', () => {
  it('explicit Auto work style binds every role and keeps missing style unchanged', () => {
    const base = {
      id: 'auto_style',
      template: 'write_review' as const,
      brief: 'Update and verify the app',
      choice: CHOICE,
      fileTools: true,
    };
    const before = autoDefinition(base);
    const harness = { profileId: 'trusted_tools', revision: 3 };
    const selected = autoDefinition({ ...base, harness, commandTools: true });
    expect(
      selected.roles.every(
        (role) => role.harness?.profileId === harness.profileId && role.harness.revision === 3,
      ),
    ).toBe(true);
    expect(before.roles.every((role) => role.harness === undefined)).toBe(true);
    expect(before.roles.every((role) => !role.allowedWorkTools.includes('run_command'))).toBe(true);
    expect(autoDefinition(base)).toEqual(before);
  });
  it('every template compiles, uses the chosen model and reasoning, and gets file tools with a working copy', () => {
    for (const template of AUTO_TEMPLATES) {
      const definition = autoDefinition({
        id: 'auto_s1',
        template,
        brief: 'Tidy the README.',
        choice: CHOICE,
        fileTools: true,
      });
      expect(planRun(definition).ok, template).toBe(true);
      expect(definition.input.brief).toBe('Tidy the README.');
      for (const role of definition.roles) {
        expect(role.modelProfile).toBe('model-b');
        expect(role.reasoning).toEqual({ mode: 'fixed', level: 'low' });
        expect(role.allowedWorkTools).toContain('read_file');
        expect(role.allowedWorkTools.includes('write_file')).toBe(WRITERS.has(role.id));
      }
      const output = definition.nodes.find((n) => n.type === 'output');
      expect(output?.type === 'output' && output.requireApproval).toBe(false);
      expect(definition.limits).toEqual(DEFAULT_LIMITS);
    }
    expect(
      autoDefinition({
        id: 'auto_s1',
        template: 'single',
        brief: 'Hi',
        choice: CHOICE,
        fileTools: true,
      }).roles,
    ).toHaveLength(1);
    expect(
      autoDefinition({
        id: 'auto_s1',
        template: 'write_review',
        brief: 'Hi',
        choice: CHOICE,
        fileTools: true,
      }).roles,
    ).toHaveLength(3);
  });

  it('no working copy means no file tools; an unknown template builds nothing; templates keep the original limits', () => {
    for (const template of AUTO_TEMPLATES) {
      const definition = autoDefinition({
        id: 'auto_s1',
        template,
        brief: 'Hi',
        choice: { modelProfile: 'model-a' },
        fileTools: false,
      });
      for (const role of definition.roles) {
        expect(role.allowedWorkTools).toEqual(['write_artifact']);
        expect(role.reasoning).toBeUndefined();
      }
    }
    expect(() =>
      autoDefinition({
        id: 'auto_s1',
        template: 'shell' as never,
        brief: 'Hi',
        choice: CHOICE,
        fileTools: true,
      }),
    ).toThrow();
    const charged = autoDefinition({
      id: 'auto_s1',
      template: 'single',
      brief: 'Hi',
      choice: CHOICE,
      fileTools: false,
    });
    expect(charged.limits).toEqual(DEFAULT_LIMITS);
  });
});

describe('reading the start model’s answer', () => {
  it('takes one JSON object naming an allowed template, fenced or not', () => {
    expect(
      parseAutoRoute('{"template":"write_review","reason":"Needs a draft and a check."}'),
    ).toEqual({ template: 'write_review', reason: 'Needs a draft and a check.' });
    expect(
      parseAutoRoute('```json\n{"template":"single","reason":"A short question."}\n```'),
    ).toEqual({
      template: 'single',
      reason: 'A short question.',
    });
    expect(localAutoRoute('Compare three help desk vendors').template).toBe(
      'research_write_review',
    );
    expect(localAutoRoute('보고서 초안을 작성해 줘').template).toBe('write_review');
    expect(localAutoRoute('What does this error mean?').template).toBe('single');
  });

  it('refuses unknown templates, extra fields, long reasons and prose', () => {
    for (const text of [
      '{"template":"shell","reason":"x"}',
      '{"template":"single","reason":"x","tools":["shell"]}',
      '{"template":"single","reason":"x","harness":{"profileId":"trusted_tools","revision":1}}',
      `{"template":"single","reason":"${'x'.repeat(201)}"}`,
      '{"template":"single"}',
      'I would pick the single agent.',
      '{"template":"single",',
    ]) {
      expect(parseAutoRoute(text), text).toBeNull();
    }
  });
});

function setup() {
  const store = new InMemoryRunStore();
  const coordinator = new Coordinator({
    store,
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents: new ScriptedAgentAdapter({ turns: 1 }),
  });
  const transport = new InProcessTransport(coordinator);
  const calls: { brief: string; choice: AutoModelChoice }[] = [];
  let answer: () => Promise<RouteAnswer> = async () => ({
    ok: true,
    text: '{"template":"write_review","reason":"A draft that needs a review."}',
    usage: { inputTokens: 120, outputTokens: 30 },
  });
  const starter = createAutoStarter({
    startRun: (request) => coordinator.startRun(request),
    previousStart: (commandId, requestHash) => {
      const result = coordinator.startResult(commandId, requestHash);
      if (!result) return null;
      const autoRoute = result.runId
        ? (coordinator.getRunSnapshot(result.runId)?.autoRoute ?? null)
        : null;
      return { ...result, autoRoute };
    },
    route: (input) => {
      calls.push({ brief: input.brief, choice: input.choice });
      return answer();
    },
  });
  return {
    coordinator,
    transport,
    starter,
    calls,
    answerWith: (next: () => Promise<RouteAnswer>) => {
      answer = next;
    },
  };
}

const request = (commandId: string) => ({
  commandId,
  brief: 'Write release notes for 0.3.',
  mode: 'mock' as const,
  choice: { modelProfile: 'model-a' },
});

async function startedEvent(s: ReturnType<typeof setup>, runId: string) {
  const events: RunEvent[] = [];
  const stop = s.coordinator.subscribe(runId, 0, (e) => events.push(e));
  await waitForProjection(s.transport, runId, (p) => p.status === 'succeeded');
  stop();
  return events.find((e) => e.type === 'run.started');
}

describe('starting an auto run', () => {
  it('one choice request picks the template; run.started records the choice and its usage', async () => {
    const s = setup();
    const result = await s.starter.start(request('cmd_auto_1'), { fileTools: false });
    expect(result.receipt.status).toBe('applied');
    expect(s.calls).toEqual([
      { brief: 'Write release notes for 0.3.', choice: { modelProfile: 'model-a' } },
    ]);
    expect(result.autoRoute).toMatchObject({
      template: 'write_review',
      templateVersion: AUTO_TEMPLATE_VERSION,
      source: 'model',
      reason: 'A draft that needs a review.',
      modelProfile: 'model-a',
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    expect(result.autoRoute?.inputHash).toMatch(/^[0-9a-f]{64}$/);
    const started = await startedEvent(s, result.runId ?? '');
    expect(started?.type === 'run.started' && started.payload.autoRoute).toEqual(result.autoRoute);
    expect(started?.type === 'run.started' && started.payload.limits.maxModelCalls).toBe(
      DEFAULT_LIMITS.maxModelCalls,
    );
    expect(s.coordinator.getRunSnapshot(result.runId ?? '')?.definition.roles).toHaveLength(3);

    // Without a start model, the local rule chooses and no model is called.
    const local = createAutoStarter({ startRun: (r) => s.coordinator.startRun(r) });
    const second = await local.start(
      { ...request('cmd_auto_2'), brief: 'What is a run?' },
      { fileTools: false },
    );
    expect(second.autoRoute).toMatchObject({ template: 'single', source: 'local', usage: null });
  });

  it('bad answers and timeouts fall back to single with the reason; the answer text is never recorded', async () => {
    const s = setup();
    const cases: [RouteAnswer, string][] = [
      [{ ok: true, text: 'Use a poem team: roses-are-red', usage: null }, 'invalid_answer'],
      [
        { ok: true, text: '{"template":"shell","reason":"roses-are-red"}', usage: null },
        'invalid_answer',
      ],
      [{ ok: false, reason: 'timeout' }, 'timeout'],
      [{ ok: false, reason: 'model_error' }, 'model_error'],
    ];
    for (const [index, [answer, fallback]] of cases.entries()) {
      s.answerWith(async () => answer);
      const result = await s.starter.start(request(`cmd_bad_${index}`), { fileTools: false });
      expect(result.autoRoute).toMatchObject({ template: 'single', source: 'fallback', fallback });
      const started = await startedEvent(s, result.runId ?? '');
      expect(JSON.stringify(started)).not.toContain('roses-are-red');
    }
  });

  it('a cancelled choice starts nothing; the same command ID chooses once and starts one run', async () => {
    const s = setup();
    const signal = { aborted: false };
    let abort = () => {};
    s.answerWith(
      () =>
        new Promise((resolve) => {
          abort = () => {
            signal.aborted = true;
            resolve({ ok: false, reason: 'model_error' });
          };
        }),
    );
    const cancelled = s.starter.start(request('cmd_cancel'), { fileTools: false, signal });
    abort();
    await expect(cancelled).rejects.toThrow();
    expect(s.coordinator.hasStartCommand('cmd_cancel')).toBe(false);

    s.calls.length = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    s.answerWith(async () => {
      await gate;
      return { ok: true, text: '{"template":"single","reason":"Short."}', usage: null };
    });
    const first = s.starter.start(request('cmd_dup'), { fileTools: false });
    const second = s.starter.start(request('cmd_dup'), { fileTools: false });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(s.calls).toHaveLength(1);
    expect(a.runId).not.toBeNull();
    expect(b.runId).toBe(a.runId);
    await waitForProjection(s.transport, a.runId ?? '', (p) => p.status === 'succeeded');

    // A resend after the answer was lost does not ask the model again.
    const again = await s.starter.start(request('cmd_dup'), { fileTools: false });
    expect(s.calls).toHaveLength(1);
    expect(again.runId).toBe(a.runId);
    expect(again.autoRoute).toEqual(a.autoRoute);
  });
});

describe('per-request reasoning', () => {
  const routeChoice = { modelProfile: 'model-a', reasoning: { mode: 'route' as const } };
  function routed(
    answerText: string,
    levels: string[] | null = ['minimal', 'low', 'medium', 'high', 'xhigh'],
  ) {
    const store = new InMemoryRunStore();
    const coordinator = new Coordinator({
      store,
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
    });
    const seen: { levels: readonly string[] | undefined }[] = [];
    const starter = createAutoStarter({
      startRun: (r) => coordinator.startRun(r),
      levels: () => levels as never,
      route: (input) => {
        seen.push({ levels: input.levels });
        return Promise.resolve({ ok: true, text: answerText, usage: null });
      },
    });
    return { coordinator, starter, seen };
  }
  const roleLevels = (s: ReturnType<typeof routed>, runId: string | null) =>
    s.coordinator
      .getRunSnapshot(runId ?? '')
      ?.definition.roles.map((r) => (r.reasoning?.mode === 'fixed' ? r.reasoning.level : null));

  it('the start model picks the level with the template; every role runs it fixed', async () => {
    expect(
      parseAutoRoute('{"template":"single","reason":"Short.","reasoning":"low"}', [
        'low',
        'medium',
        'high',
      ]),
    ).toEqual({ template: 'single', reason: 'Short.', reasoning: 'low' });
    const s = routed('{"template":"write_review","reason":"Needs care.","reasoning":"high"}');
    const result = await s.starter.start(
      { commandId: 'cmd_r1', brief: 'Draft the plan.', mode: 'mock', choice: routeChoice },
      { fileTools: false },
    );
    expect(s.seen).toEqual([{ levels: ['low', 'medium', 'high'] }]);
    expect(roleLevels(s, result.runId)).toEqual(['high', 'high', 'high']);
    expect(result.autoRoute).toMatchObject({
      template: 'write_review',
      reasoning: { mode: 'route' },
      reasoningChoice: { level: 'high', source: 'model' },
    });
  });

  it('an unsupported or missing level, a fallback template and the local rule run medium', async () => {
    for (const [text, levels, template] of [
      ['{"template":"single","reason":"x","reasoning":"xhigh"}', undefined, 'single'],
      ['{"template":"write_review","reason":"x"}', undefined, 'write_review'],
      [
        '{"template":"single","reason":"x","reasoning":"high"}',
        ['minimal', 'low', 'medium'],
        'single',
      ],
      ['not json', undefined, 'single'],
    ] as const) {
      const s = routed(text, levels ? [...levels] : undefined);
      const result = await s.starter.start(
        { commandId: 'cmd_r2', brief: 'Hi', mode: 'mock', choice: routeChoice },
        { fileTools: false },
      );
      expect(result.autoRoute?.template, text).toBe(template);
      expect(result.autoRoute?.reasoningChoice, text).toEqual({
        level: 'medium',
        source: 'fallback',
      });
      expect(new Set(roleLevels(s, result.runId))).toEqual(new Set(['medium']));
    }
    const s = routed('');
    const local = createAutoStarter({ startRun: (r) => s.coordinator.startRun(r) });
    const result = await local.start(
      { commandId: 'cmd_r3', brief: 'Hi', mode: 'mock', choice: routeChoice },
      { fileTools: false },
    );
    expect(result.autoRoute?.reasoningChoice).toEqual({ level: 'medium', source: 'local' });

    // A model without medium cannot choose per request: refused before any choice is asked.
    const strict = new Coordinator({
      store: new InMemoryRunStore(),
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({ turns: 1 }),
      models: {
        resolve: (profile) => ({
          ok: true,
          snapshot: {
            profile,
            provider: 'openai',
            modelId: 'm',
            auth: 'api_key',
            reasoning: { levels: ['low', 'high'], providerDefault: true },
          },
        }),
      },
    });
    expect(strict.startRefusal('model-a', 'live', { mode: 'route' })?.code).toBe(
      'CAPABILITY_DENIED',
    );
    expect(strict.startRefusal('model-a', 'live', { mode: 'fixed', level: 'low' })).toBeNull();
  });
});
