import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  type AgentStartInput,
  type CorralDefinition,
  type RequestPermit,
  type RunEvent,
  WorkPlan,
} from '@corral/contracts';
import {
  autoDefinition,
  Coordinator,
  compileDefinition,
  InProcessTransport,
  waitForProjection,
} from '@corral/core';
import { FakeClock, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { beforeEach, describe, expect, it } from 'vitest';
import en from '../../../../packages/react/src/messages/en.json' with { type: 'json' };
import ko from '../../../../packages/react/src/messages/ko.json' with { type: 'json' };
import {
  createDemoReply,
  DEMO_TURNS,
  demoPlansFor,
  demoPlanUpdate,
  publishDemoPlan,
} from './script.ts';
import { demoTemplate } from './templates.ts';
import { approvalResearchTeam } from './testing/approval-team.ts';

const HANGUL = /[ㄱ-ㆎ가-힣]/;

/** A Run of `definition` with the demo's simulated agents, without their delays. */
async function demoRun(definition: CorralDefinition) {
  const transport = new InProcessTransport(
    new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      agents: new ScriptedAgentAdapter({
        turns: DEMO_TURNS,
        reply: createDemoReply(),
        appendNotes: false,
      }),
    }),
  );
  const { runId, receipt } = await transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_template_run',
    definition,
    mode: 'mock',
  });
  if (!runId) throw new Error(JSON.stringify(receipt.error));
  const events: RunEvent[] = [];
  transport.subscribe(runId, 0, { onEvent: (event) => events.push(event) });
  /** The next point where the run ended or waits for a person. */
  const settled = () =>
    waitForProjection(transport, runId, (run) =>
      ['succeeded', 'failed', 'cancelled', 'awaiting_user'].includes(run.status),
    );
  return { transport, runId, events, settled };
}

describe('demo templates', () => {
  it('the default research team compiles and shows delegation, a question and a review Loop, and asks for no approval', () => {
    const template = demoTemplate(undefined);
    expect(template.id).toBe('research-team');
    const { definition } = template;
    const compiled = compileDefinition(definition);
    expect(compiled.ok).toBe(true);
    // No warnings either: the reviewer gets the criteria text (#20).
    expect(compiled.diagnostics).toEqual([]);
    expect(definition.capabilityLinks.map((l) => l.kind).sort()).toEqual([
      'delegate',
      'delegate',
      'question',
    ]);
    expect(definition.nodes.filter((n) => n.type === 'loop')).toHaveLength(1);
    // Outputs are the agents' evidence, not the person's homework: nothing waits for an approval.
    expect(definition.nodes.some((n) => n.type === 'decision' && n.mode === 'approval')).toBe(
      false,
    );
    expect(definition.nodes.find((n) => n.type === 'output')).toMatchObject({
      requireApproval: false,
    });
    // The review Loop leads straight to the Output.
    expect(definition.controlEdges).toContainEqual(
      expect.objectContaining({
        source: 'review_loop',
        sourcePort: 'next',
        target: 'output',
        targetPort: 'in',
      }),
    );
    // The UI has one English locale, so the demo speaks it too.
    expect(JSON.stringify(definition)).not.toMatch(HANGUL);
  });

  it('a run of the research team with simulated agents succeeds without waiting for a person', async () => {
    const { events, settled } = await demoRun(demoTemplate('research-team').definition);
    const run = await settled();
    expect(run.status).toBe('succeeded');
    expect(Object.keys(run.approvals)).toEqual([]);
    expect(events.some((event) => event.type === 'approval.requested')).toBe(false);
    expect(
      events.some(
        (event) => event.type === 'run.state_changed' && event.payload.to === 'awaiting_user',
      ),
    ).toBe(false);
    // It still revises once through its review Loop and has a result.
    expect(Object.values(run.reviews).map((review) => review.verdict)).toEqual(['revise', 'pass']);
    expect(run.output?.artifactVersionIds).toHaveLength(1);
  });

  it('the research team’s card and the demo guide do not tell the person to approve the result', () => {
    for (const [messages, approve] of [
      [en, /approv/i],
      [ko, /승인/],
    ] as const) {
      expect(messages.Workspace.template['research-team'].body).not.toMatch(approve);
      expect(messages.Demo.guide.steps.finish).not.toMatch(approve);
    }
  });

  it('the starter template keeps the single Agent → Output demo', () => {
    const { id, definition } = demoTemplate('starter');
    expect(id).toBe('starter');
    expect(definition.name).toBe('Demo Corral');
    expect(definition.nodes.map((n) => n.type)).toEqual(['agent', 'output']);
    expect(compileDefinition(definition).ok).toBe(true);
  });

  it('an unknown template name opens the default template', () => {
    expect(demoTemplate('bogus').id).toBe('research-team');
  });
});

describe('the research team with approvals, for tests of approvals', () => {
  it('is the shipped team with an approval Decision after its Loop and an Output that requires approval, nothing else', () => {
    const shipped = demoTemplate('research-team').definition;
    const fixture = approvalResearchTeam().definition;
    expect(compileDefinition(fixture).ok).toBe(true);
    expect(fixture.nodes.find((n) => n.id === 'approval')).toMatchObject({
      type: 'decision',
      mode: 'approval',
      rule: 'human_approval',
    });
    expect(fixture.nodes.find((n) => n.type === 'output')).toMatchObject({
      requireApproval: true,
    });
    expect(fixture.controlEdges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: 'review_loop', sourcePort: 'next', target: 'approval' }),
        expect.objectContaining({ source: 'approval', sourcePort: 'approve', target: 'output' }),
      ]),
    );
    // Taking the two approvals out again gives the shipped team exactly.
    expect({
      ...fixture,
      nodes: fixture.nodes
        .filter((n) => n.id !== 'approval')
        .map((n) => (n.type === 'output' ? { ...n, requireApproval: false } : n)),
      controlEdges: fixture.controlEdges
        .filter((e) => e.source !== 'approval')
        .map((e) => (e.target === 'approval' ? { ...e, target: 'output' } : e)),
    }).toEqual(shipped);
    // A workspace copy gets its own id, like a template copy.
    expect(approvalResearchTeam('approval_team').definition).toMatchObject({
      id: 'approval_team',
      name: 'Research team',
    });
  });

  it('a run of it waits for the decision, then for the final output', async () => {
    const { transport, runId, settled } = await demoRun(approvalResearchTeam().definition);
    const approve = async (kind: string) => {
      const run = await settled();
      const approval = Object.values(run.approvals).find((a) => a.status === 'pending');
      expect(run.status).toBe('awaiting_user');
      expect(approval?.kind).toBe(kind);
      const receipt = await transport.sendCommand({
        schemaVersion: '0.1',
        commandId: `cmd_approve_${kind}`,
        runId,
        type: 'resolve_approval',
        expectedControlRevision: run.controlRevision,
        payload: {
          approvalId: approval?.approvalId ?? 'missing',
          decision: 'approve',
          subjectVersionId: approval?.subjectVersionIds[0] ?? 'missing',
        },
      });
      expect(receipt.status).toBe('applied');
      // The approval is committed before the next wait reads the run again.
      await waitForProjection(
        transport,
        runId,
        (p) => p.approvals[approval?.approvalId ?? '']?.status !== 'pending',
      );
    };
    await approve('user_action');
    await approve('final_output');
    expect((await settled()).status).toBe('succeeded');
  });

  it('is never imported by the product', () => {
    const src = join(import.meta.dirname, '..');
    const sources = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return sources(path);
        return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
      });
    const importers = sources(src)
      .filter((path) => !path.includes(`${join('demo', 'testing')}`))
      .filter((path) => /testing\/approval-team/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(src, path));
    expect(importers).toEqual([]);
  });
});

const permit = (directives: RequestPermit['directives'] = []): RequestPermit => ({
  modelCallId: 'call_0001',
  contextSnapshotId: 'ctx_0001',
  profile: 'model-a',
  maxOutputTokens: 4096,
  directives,
});

function startInput(nodeId: string, overrides: Partial<AgentStartInput> = {}): AgentStartInput {
  const { definition } = demoTemplate('research-team');
  const node = definition.nodes.find((n) => n.id === nodeId);
  if (node?.type !== 'agent') throw new Error(`no agent ${nodeId}`);
  const role = definition.roles.find((r) => r.id === node.roleId);
  if (!role) throw new Error(`no role for ${nodeId}`);
  return {
    runId: 'run_0001',
    executionId: 'exec_0001',
    taskId: 'task_0001',
    nodeId,
    attemptNo: 1,
    role,
    modelProfile: role.modelProfile,
    mode: 'mock',
    model: { profile: role.modelProfile, provider: null, modelId: null, auth: 'mock' },
    depth: 0,
    round: null,
    criteriaVersionId: 'crit_0001',
    assignment: { kind: 'scheduled' },
    capabilities: { delegateTo: [], askTo: [] },
    inputs: [
      { name: 'brief', kind: 'run_input', artifactVersionId: null, text: 'Compare two tools.' },
    ],
    ...overrides,
  };
}

describe('demo replies', () => {
  let demoReply = createDemoReply();
  beforeEach(() => {
    demoReply = createDemoReply();
  });

  it('say they are simulated and use the brief', () => {
    const text = demoReply(2, startInput('research'), permit(), []);
    expect(text).toMatch(/simulated/i);
    expect(text).toContain('Compare two tools.');
  });

  it('write collaboration results as prose, not raw tool notes', () => {
    const text = demoReply(2, startInput('write', { round: 1 }), permit(), [
      'answer: The vendor documentation supports the main claim.',
    ]);
    expect(text).toContain('The vendor documentation supports the main claim.');
    expect(text).not.toMatch(/^answer:/m);
    const research = demoReply(2, startInput('research'), permit(), [
      'read artv_0003',
      'read artv_0004',
    ]);
    expect(research).not.toMatch(/^read artv_/m);
    expect(research).toContain('artv_0003');
  });

  it('a responder answers in its only request', () => {
    // The adapter gives a question one request, so that request carries the answer.
    const text = demoReply(
      1,
      startInput('respond', {
        assignment: {
          kind: 'question',
          questionId: 'q_0001',
          body: 'Which source supports the main claim?',
          askerExecutionId: 'exec_0004',
        },
      }),
      permit(),
      ['answers q_0001'],
    );
    expect(text).toContain('request 1 of 1');
    expect(text).toContain('Which source supports the main claim?');
    expect(text).toContain('official documentation');
    expect(text).not.toContain('planning the answer');
  });

  it('a revised draft answers the review it was given', () => {
    const first = demoReply(2, startInput('write', { round: 1 }), permit(), []);
    const second = demoReply(
      2,
      startInput('write', {
        round: 2,
        inputs: [
          { name: 'notes', kind: 'task_output', artifactVersionId: 'artv_0005', text: 'Notes.' },
          {
            name: 'review',
            kind: 'previous_iteration_output',
            artifactVersionId: 'artv_0008',
            text: '{"verdict":"revise"}',
          },
        ],
      }),
      permit(),
      [],
    );
    expect(second).not.toBe(first);
    expect(second).toContain('artv_0008');
  });

  it('shows a directive from the request it was delivered in, and only for that execution', () => {
    const input = startInput('write', { round: 2, executionId: 'exec_0007' });
    const directive = {
      directiveId: 'dir_0001',
      text: 'Lead with the cost difference.',
      origin: 'user' as const,
    };
    expect(demoReply(1, input, permit(), [])).not.toContain(directive.text);
    expect(demoReply(2, input, permit([directive]), [])).toContain(directive.text);
    // Delivered once, it stays in that execution's context for later requests ...
    expect(demoReply(3, input, permit(), [])).toContain(directive.text);
    // ... but another execution of the same node never saw it.
    const other = startInput('write', { round: 1, executionId: 'exec_0004' });
    expect(demoReply(2, other, permit(), [])).not.toContain(directive.text);
  });

  it.each(['agent_1_role', 'explainer_role'])(
    'a %s demo reply preserves the request without diagnostics or recursive prior results',
    (roleId) => {
      const prior = 'role prompt: diagnostic prompt\nmodel profile: model-a\nEarlier artifact body';
      const raw = `Explain this result.\n\nStart from this earlier version:\n(draft v1 from run run_1)\n\n${prior}`;
      const input = withRole('write', roleId, {
        inputs: [{ name: 'brief', kind: 'run_input', artifactVersionId: null, text: raw }],
      });
      const text = demoReply(2, input, permit(), ['raw tool diagnostics']);
      expect(text).toContain('Explain this result.');
      expect(text).toMatch(/simulated/i);
      expect(text).toContain('No model was called.');
      expect(text).not.toContain('role prompt:');
      expect(text).not.toContain('model profile:');
      expect(text).not.toContain(input.role.prompt);
      expect(text).not.toContain('Start from this earlier version');
      expect(text).not.toContain('Earlier artifact body');
      expect(text).not.toContain('raw tool diagnostics');
      expect(input.inputs[0]?.text).toBe(raw);
    },
  );

  it('a session worker answers the request without diagnostics or the previous artifact', () => {
    const prior = 'role prompt: secret\nmodel profile: model-a\nbrief: first run body';
    const brief = `한 문장으로 안녕이라고 답해줘.\n\nStart from this earlier version:\n(draft v1 from run run_1)\n\n${prior}`;
    const input = withRole('write', 'worker', {
      modelProfile: 'model-a',
      inputs: [{ name: 'brief', kind: 'run_input', artifactVersionId: null, text: brief }],
    });
    input.role = { ...input.role, prompt: 'Do what the request asks, directly and completely.' };
    const text = demoReply(2, input, permit(), []);
    expect(text).toContain('한 문장으로 안녕이라고 답해줘.');
    expect(text).not.toContain('role prompt:');
    expect(text).not.toContain('model profile:');
    expect(text).not.toContain('Start from this earlier version');
    expect(text).not.toContain('first run body');
    expect(text).not.toContain('Do what the request asks');
  });

  it('a session planner answers the request without a settings echo', () => {
    const input = withRole('write', 'planner', {
      inputs: [
        {
          name: 'brief',
          kind: 'run_input',
          artifactVersionId: null,
          text: '계획을 세워 줘.\n\nStart from this earlier version:\n(draft v1 from run run_1)\n\nrole prompt: secret',
        },
      ],
    });
    const text = demoReply(2, input, permit(), []);
    expect(text).toContain('계획을 세워 줘.');
    expect(text).not.toContain('role prompt:');
    expect(text).not.toContain('Start from this earlier version');
  });

  it('team research keeps its structured answer without recursively quoting an earlier result', () => {
    const input = startInput('research', {
      inputs: [
        {
          name: 'brief',
          kind: 'run_input',
          artifactVersionId: null,
          text: 'Compare two tools.\n\nStart from this earlier version:\n(draft v1 from run run_1)\n\nrole prompt: diagnostic prompt\nEarlier artifact body',
        },
      ],
    });
    const text = demoReply(2, input, permit(), []);
    expect(text).toContain('## Research notes');
    expect(text).toContain('Brief: Compare two tools.');
    expect(text).not.toContain('Start from this earlier version');
    expect(text).not.toContain('Earlier artifact body');
    expect(text).not.toContain('role prompt:');
    expect(input.inputs[0]?.text).toContain('Earlier artifact body');
  });

  it('a short request does not publish a plan, and a staged request does through update_plan', async () => {
    const short = withRole('write', 'worker', {
      inputs: [{ name: 'brief', kind: 'run_input', artifactVersionId: null, text: '안녕' }],
    });
    short.role = { ...short.role, allowedCollaborationTools: ['update_plan', 'submit_result'] };
    expect(demoPlansFor(short)).toBe(false);
    const staged = withRole('write', 'worker', {
      inputs: [
        {
          name: 'brief',
          kind: 'run_input',
          artifactVersionId: null,
          text: '단계별로 채팅 레이아웃을 고쳐 줘.',
        },
      ],
    });
    staged.role = { ...staged.role, allowedCollaborationTools: ['update_plan', 'submit_result'] };
    expect(demoPlansFor(staged)).toBe(true);
    const calls: unknown[] = [];
    await publishDemoPlan(
      staged,
      {
        invokeTool: async (call) => {
          calls.push(call.args);
          return { ok: true };
        },
      },
      async () => {},
    );
    expect(calls).toHaveLength(8);
    expect(
      demoPlanUpdate(0, staged.criteriaVersionId).items.filter(
        (item) => item.status === 'completed',
      ),
    ).toHaveLength(0);
    expect(
      demoPlanUpdate(2, staged.criteriaVersionId).items.filter(
        (item) => item.status === 'completed',
      ),
    ).toHaveLength(2);
    expect((calls[2] as { expectedRevision: number }).expectedRevision).toBe(2);
    expect(calls[7]).toMatchObject({
      expectedRevision: 7,
      items: Array.from({ length: 7 }, () => ({ status: 'completed' })),
    });
    expect(
      demoPlanUpdate(7, staged.criteriaVersionId).items.every((item) =>
        item.title.startsWith('예시'),
      ),
    ).toBe(true);
  });

  it('a rejected plan update stops the sequence without waiting or publishing later revisions', async () => {
    const input = withRole('write', 'worker');
    const calls: number[] = [];
    const waits: number[] = [];
    await publishDemoPlan(
      input,
      {
        invokeTool: async (call) => {
          calls.push(call.args.expectedRevision);
          return { ok: call.args.expectedRevision === 0 };
        },
      },
      async (ms) => {
        waits.push(ms);
      },
    );
    expect(calls).toEqual([0, 1]);
    expect(waits).toHaveLength(1);
  });

  it.each([
    { brief: '안녕', completed: [] },
    { brief: '단계별로 채팅 레이아웃을 고쳐 줘.', completed: [0, 1, 2, 3, 4, 5, 6, 7] },
  ])(
    'the Coordinator persists the actual demo plan sequence for "$brief"',
    async ({ brief, completed }) => {
      const beforeReply: { status: string; completed: number }[] = [];
      const coordinator = new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        agents: new ScriptedAgentAdapter({
          turns: 2,
          reply: createDemoReply(),
          appendNotes: false,
          script: async (input, host) => {
            if (demoPlansFor(input)) await publishDemoPlan(input, host, async () => {});
            return null;
          },
          beforeReply: async (_turn, input) => {
            const projection = coordinator.getSnapshot(input.runId).projection;
            const ref = Object.values(projection.workPlans ?? {})[0];
            const plan = ref
              ? WorkPlan.parse(
                  JSON.parse(coordinator.getArtifactText(input.runId, ref.bodyRef) ?? 'null'),
                )
              : null;
            beforeReply.push({
              status: projection.status,
              completed: plan?.items.filter((item) => item.status === 'completed').length ?? 0,
            });
          },
        }),
      });
      const transport = new InProcessTransport(coordinator);
      const started = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'cmd_demo_plan',
        definition: autoDefinition({
          id: 'demo_auto',
          template: 'single',
          brief,
          choice: { modelProfile: 'model-a' },
          fileTools: false,
        }),
        mode: 'mock',
      });
      expect(started.receipt.status).toBe('applied');
      if (!started.runId) throw new Error('Demo run was not created');
      const runId = started.runId;
      const events: RunEvent[] = [];
      const plans: WorkPlan[] = [];
      const stop = transport.subscribe(runId, 0, {
        onEvent: (event) => {
          events.push(event);
          if (event.type === 'work_plan.updated')
            plans.push(
              WorkPlan.parse(
                JSON.parse(coordinator.getArtifactText(runId, event.payload.bodyRef) ?? 'null'),
              ),
            );
        },
      });
      try {
        const projection = await waitForProjection(transport, runId, (run) =>
          ['succeeded', 'failed', 'cancelled'].includes(run.status),
        );
        expect(projection.status).toBe('succeeded');
        const updates = events.filter((event) => event.type === 'work_plan.updated');
        // Plan payloads are consumed while their owner runs; completed Runs retain the
        // sequence/revision metadata, not a body archive of each intermediate plan.
        for (const event of updates)
          expect(coordinator.getArtifactText(runId, event.payload.bodyRef)).toBeNull();
        expect(
          plans.map((plan) => plan.items.filter((item) => item.status === 'completed').length),
        ).toEqual(completed);
        expect(updates.map((event) => event.payload.revision)).toEqual(
          completed.map((step) => step + 1),
        );
        expect(beforeReply).toEqual([
          { status: 'running', completed: completed.length ? 7 : 0 },
          { status: 'running', completed: completed.length ? 7 : 0 },
        ]);
        const output = coordinator.getArtifactText(
          runId,
          projection.output?.artifactVersionIds[0] ?? '',
        );
        expect(output).toContain('No model was called.');
      } finally {
        stop();
      }
    },
  );

  it('a session worker shows a directive from the delivery turn onward', () => {
    const input = withRole('write', 'worker', { executionId: 'exec_worker' });
    const directive = {
      directiveId: 'dir_0009',
      text: 'Keyboard instructions reach the next request.',
      origin: 'user' as const,
    };
    expect(demoReply(1, input, permit(), [])).not.toContain(directive.text);
    expect(demoReply(2, input, permit([directive]), [])).toContain(directive.text);
    expect(demoReply(3, input, permit(), [])).toContain(directive.text);
  });
});

function withRole(
  nodeId: string,
  roleId: string,
  overrides: Partial<AgentStartInput> = {},
): AgentStartInput {
  const input = startInput(nodeId, overrides);
  return {
    ...input,
    role: {
      ...input.role,
      id: roleId,
      name: roleId === 'worker' ? 'Assistant' : input.role.name,
    },
  };
}
