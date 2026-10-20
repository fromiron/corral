import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { AgentStartInput, EffectiveHarnessSnapshot } from '@corral/contracts';
import {
  Coordinator,
  InProcessTransport,
  importMarkdownAgent,
  parseMarkdownAgent,
  waitForProjection,
} from '@corral/core';
import { FakeClock, linearCorral, SequentialIdFactory } from '@corral/testkit';
import {
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
  getCurrentTools,
} from '@earendil-works/pi-ai';
import { afterEach, expect, it } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { runSdkWorker } from '../src/sdk-worker.ts';
import { runWorker } from '../src/worker.ts';
import { parametersOf } from '../src/worker-tools.ts';
import { liveModels, recordingHost } from './harness.ts';

const scratch: string[] = [];
afterEach(() => {
  for (const directory of scratch.splice(0)) {
    if (
      dirname(resolve(directory)) !== resolve(tmpdir()) ||
      !basename(directory).startsWith('corral-parent-question-')
    )
      throw new Error('unexpected test directory');
    rmSync(directory, { recursive: true, force: true });
  }
});

const harness: EffectiveHarnessSnapshot = {
  binding: { profileId: 'parent_questions', revision: 1 },
  snapshotHash: 'a'.repeat(64),
  piVersion: '1.3.0',
  policyRevision: 1,
  policy: 'trusted-native',
  resources: [],
  allowedTools: [
    'write_artifact',
    'submit_result',
    'ask',
    'reply',
    'spawn_subagents',
    'await_tasks',
  ],
  tools: [],
  diagnostics: [],
};

function startInput(sdk: boolean): AgentStartInput {
  const role = linearCorral(['writer']).roles[0];
  if (!role) throw new Error('missing parent role');
  return {
    runId: 'run_parent',
    executionId: 'exec_parent',
    taskId: 'task_parent',
    nodeId: 'writer',
    attemptNo: 1,
    role: {
      ...role,
      allowedCollaborationTools: ['reply', 'submit_result'],
      ...(sdk ? { harness: harness.binding } : {}),
    },
    modelProfile: 'model-a',
    mode: 'live',
    model: { profile: 'model-a', provider: 'openai', modelId: 'faux-1', auth: 'mock' },
    depth: 0,
    round: null,
    criteriaVersionId: 'criteria_parent',
    assignment: { kind: 'scheduled' },
    capabilities: { delegateTo: [], askTo: [], replyToChildren: true },
    inputs: [
      { name: 'brief', kind: 'run_input', artifactVersionId: null, text: 'Help the child.' },
    ],
    ...(sdk ? { harness } : {}),
  };
}

function adapter(responses: FauxResponseStep[]) {
  const faux = createFauxCore({});
  faux.setResponses(responses);
  const directory = mkdtempSync(join(tmpdir(), 'corral-parent-question-'));
  scratch.push(directory);
  return new PiAgentAdapter({
    spawn: () => {
      const { host, worker } = memoryChannelPair();
      runWorker(worker, { streamFn: faux.streamSimple, resolveModel: () => faux.getModel() });
      return host;
    },
    spawnSdk: () => {
      const { host, worker } = memoryChannelPair();
      runSdkWorker(worker, {
        streamFn: faux.streamSimple,
        resolveModel: () => faux.getModel(),
        directory: mkdtempSync(join(directory, 'worker-')),
        now: () => 1000,
      });
      return host;
    },
    harness: async () => ({ bundles: [], extensions: [], skills: [], startupCommands: [] }),
    credentials: async () => null,
  });
}

const tool = (name: string, args: Record<string, unknown>) =>
  fauxAssistantMessage([fauxToolCall(name, args as Parameters<typeof fauxToolCall>[1])], {
    stopReason: 'toolUse',
  });

const sdkHost = {
  reportHarness: async () => {},
  pendingDirectives: () => [],
  beginNativeTool: async () => {},
  finishNativeTool: async () => {},
};

it('[TC-ABS-011-N] preserves the legacy question responder schema without parent-question opt-in', () => {
  const schema = parametersOf('reply', {
    delegateTo: [],
    askTo: [],
    assignment: { kind: 'question', questionId: 'question_own', body: 'Answer this.' },
  });
  expect(schema).toMatchObject({
    properties: { body: { type: 'string' }, evidenceRefs: { type: 'array' } },
    required: ['body'],
  });
  expect(schema).not.toHaveProperty('properties.questionId');
});

it.each([false, true])(
  '[TC-ABS-011-H] offers parent reply and delivers the question as agent data without contextPolicy (SDK=%s)',
  async (sdk) => {
    const proposals: { name: string; args: Record<string, unknown> }[] = [];
    let observedInbox = false;
    const runtime = adapter([
      (context) => {
        const tools = getCurrentTools(context.messages);
        expect(tools.find((entry) => entry.name === 'reply')?.parameters).toMatchObject({
          properties: { questionId: { type: 'string' } },
          required: expect.arrayContaining(['questionId']),
        });
        const serialized = JSON.stringify(context.messages);
        expect(serialized).toContain('question_child');
        expect(serialized).toContain('Which format should I use?');
        expect(serialized).toContain('agent data');
        expect(serialized).not.toContain('Instruction from the person supervising this run');
        observedInbox = true;
        return tool('reply', { questionId: 'question_child', body: 'Use a table.' });
      },
      () => tool('submit_result', { artifactVersionIds: ['artifact_parent'] }),
    ]);
    let calls = 0;
    const { host } = recordingHost({
      ...sdkHost,
      prepareModelRequest: async () => ({
        modelCallId: `call_${++calls}`,
        contextSnapshotId: `ctx_${calls}`,
        profile: 'model-a',
        maxOutputTokens: 256,
        directives: [],
        parentQuestions:
          calls === 1
            ? [
                {
                  questionId: 'question_child',
                  senderExecutionId: 'exec_child',
                  body: 'Which format should I use?',
                  artifactRefs: [],
                  deadline: '2026-10-21T00:01:00.000Z',
                },
              ]
            : [],
      }),
      authorizeTool: async (proposal) => {
        proposals.push(proposal);
        return { ok: true, toolCallId: `tool_${proposals.length}` };
      },
      executeTool: async (toolCallId) => ({
        ok: true,
        toolCallId,
        result: { questionId: 'question_child', terminal: false },
      }),
    });
    expect(await (await runtime.start(startInput(sdk), host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(observedInbox).toBe(true);
    expect(proposals.map((proposal) => proposal.name)).toEqual(['reply', 'submit_result']);
    expect(proposals[0]?.args.questionId).toBe('question_child');
  },
);

it.each([false, true])(
  '[TC-ABS-011-N] a refused child reply does not finish a question responder or change its explicit target (SDK=%s)',
  async (sdk) => {
    const answered: string[] = [];
    const runtime = adapter([
      tool('reply', { questionId: 'question_closed_child', body: 'Late answer.' }),
      tool('reply', { body: 'Answer my own question.' }),
      () => {
        throw new Error('accepted own reply must end the task');
      },
    ]);
    const start = startInput(sdk);
    start.assignment = {
      kind: 'question',
      questionId: 'question_own',
      body: 'Please answer.',
      askerExecutionId: 'exec_requester',
    };
    const { host } = recordingHost({
      ...sdkHost,
      authorizeTool: async (proposal) => {
        answered.push(String(proposal.args.questionId));
        return answered.length === 1
          ? {
              ok: false,
              error: { code: 'TARGET_TERMINAL', message: 'question_closed' },
              toolCallId: 'tool_refused',
            }
          : { ok: true, toolCallId: 'tool_own' };
      },
      // The legacy successful own-question response did not include terminal.
      executeTool: async (toolCallId) => ({
        ok: true,
        toolCallId,
        result: { questionId: 'question_own' },
      }),
    });
    expect(await (await runtime.start(start, host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(answered).toEqual(['question_closed_child', 'question_own']);
  },
);

it.each([
  { sdk: false, mode: 'parallel', parentQuestion: false },
  { sdk: true, mode: 'parallel', parentQuestion: false },
  { sdk: false, mode: 'items', parentQuestion: false },
  { sdk: true, mode: 'items', parentQuestion: false },
  { sdk: false, mode: 'parallel', parentQuestion: true },
  { sdk: true, mode: 'parallel', parentQuestion: true },
] as const)(
  '[TC-ABS-011-H] imported children ask their existing parent and resume through Coordinator (SDK=$sdk, mode=$mode, question responder=$parentQuestion)',
  async ({ sdk, mode, parentQuestion }) => {
    const definition = linearCorral([parentQuestion ? 'requester' : 'writer']);
    const requesterRole = definition.roles[0];
    if (!requesterRole) throw new Error('missing initial role');
    if (parentQuestion) {
      requesterRole.allowedCollaborationTools.push('ask');
      definition.roles.push({
        ...requesterRole,
        id: 'writer_role',
        name: 'Writer',
        prompt: 'Coordinate the child and answer the original question.',
        allowedCollaborationTools: ['reply', 'submit_result'],
      });
      definition.nodes.push({
        id: 'writer',
        type: 'agent',
        label: 'Writer',
        roleId: 'writer_role',
        invocation: 'callable',
        inputBindings: [],
        outputName: 'text',
      });
      definition.capabilityLinks.push({
        id: 'ask_writer',
        kind: 'question',
        sourceNodeId: 'requester',
        targetNodeId: 'writer',
      });
    }
    const parentRole = definition.roles.find((role) => role.id === 'writer_role');
    if (!parentRole) throw new Error('missing parent role');
    if (sdk) for (const role of definition.roles) role.harness = harness.binding;
    const imported = importMarkdownAgent({
      draft: { definition, layout: {} },
      candidate: parseMarkdownAgent(
        '---\nname: clarifier\ndescription: Ask about the output format\ntools: []\n---\nAsk your parent for the output format and continue.',
      ),
      parentNodeId: 'writer',
      modelProfile: 'model-a',
      profiles: [{ profileId: 'model-a', available: true }],
      mappings: {},
      suffix: 'question_worker',
      ...(sdk ? { parentHarness: harness } : {}),
    });
    let parentReplies = 0;
    let childResumed = false;
    const childCount = mode === 'items' ? 2 : 1;
    const respond: FauxResponseStep = (context) => {
      const tools = getCurrentTools(context.messages);
      const isRequester =
        parentQuestion && JSON.stringify(context.messages).includes('Act as requester.');
      const isChild = !isRequester && !tools.some((entry) => entry.name === 'spawn_subagents');
      const results = (name: string) =>
        context.messages.flatMap((message) =>
          message.role === 'toolResult' && message.toolName === name
            ? [
                JSON.parse(
                  message.content
                    .filter((part) => part.type === 'text')
                    .map((part) => part.text)
                    .join(''),
                ) as Record<string, unknown>,
              ]
            : [],
        );
      if (isRequester) {
        const answer = results('ask').at(-1);
        if (!answer)
          return tool('ask', {
            targetNodeId: 'writer',
            body: 'Coordinate your child, then answer.',
          });
        expect(answer).toMatchObject({
          outcome: 'answered',
          body: 'Parent finished after child.',
        });
      } else if (isChild) {
        const answer = results('ask').at(-1);
        if (!answer) return tool('ask', { targetNodeId: 'writer', body: 'Which output format?' });
        expect(answer).toMatchObject({ outcome: 'answered', body: 'Use a table.' });
        childResumed = true;
      } else {
        const spawned = results('spawn_subagents').at(-1);
        if (!spawned)
          return tool('spawn_subagents', {
            ...(mode === 'items' ? { mode: 'items' } : {}),
            tasks: Array.from({ length: childCount }, (_, index) => ({
              targetNodeId: 'import_question_worker',
              brief: `Ask then produce table ${index + 1}.`,
            })),
          });
        const awaited = results('await_tasks');
        if (!awaited.length) return tool('await_tasks', { taskIds: spawned.taskIds });
        const answered = new Set(results('reply').map((answer) => answer.questionId));
        const pending = awaited.at(-1)?.parentQuestions as { questionId: string }[] | undefined;
        const question = pending?.find((candidate) => !answered.has(candidate.questionId));
        if (question) {
          parentReplies += 1;
          return tool('reply', { questionId: question.questionId, body: 'Use a table.' });
        }
        const tasks = awaited.at(-1)?.tasks as { status: string }[] | undefined;
        if (tasks?.length !== childCount || tasks.some((task) => task.status !== 'completed'))
          return tool('await_tasks', { taskIds: spawned.taskIds });
        if (parentQuestion) return tool('reply', { body: 'Parent finished after child.' });
      }
      const written = results('write_artifact').at(-1);
      if (!written)
        return tool('write_artifact', {
          text: isChild ? '| Result |\n| Done |' : 'Child complete.',
        });
      return tool('submit_result', { artifactVersionIds: [written.artifactVersionId] });
    };
    const coordinator = new Coordinator({
      clock: new FakeClock(),
      ids: new SequentialIdFactory(),
      models: liveModels,
      agents: adapter(Array.from({ length: 40 }, () => respond)),
      ...(sdk ? { harnesses: { resolve: () => harness } } : {}),
    });
    const transport = new InProcessTransport(coordinator);
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_parent_question',
      definition: imported.definition,
      mode: 'live',
    });
    if (!runId) throw new Error(JSON.stringify(receipt.error));
    const final = await waitForProjection(transport, runId, (projection) =>
      ['succeeded', 'failed', 'cancelled'].includes(projection.status),
    );
    expect(final.status).toBe('succeeded');
    expect(parentReplies).toBe(childCount);
    expect(childResumed).toBe(true);
    expect(Object.values(final.tasks)).toHaveLength(childCount + 1 + Number(parentQuestion));
    expect(Object.values(final.executions)).toHaveLength(childCount + 1 + Number(parentQuestion));
    expect(Object.values(final.tasks).every((task) => task.status === 'completed')).toBe(true);
    expect(
      Object.values(final.questions).filter((question) => question.delivery === 'parent'),
    ).toEqual(
      Array.from({ length: childCount }, () =>
        expect.objectContaining({ body: 'Which output format?', status: 'answered' }),
      ),
    );
    if (parentQuestion)
      expect(
        Object.values(final.questions).find((question) => question.delivery !== 'parent'),
      ).toMatchObject({
        status: 'answered',
        answer: { body: 'Parent finished after child.' },
      });
  },
);

it.each([false, true])(
  '[TC-ABS-011-N] a question responder parent preserves an explicit child ID and continues until its own reply (SDK=%s)',
  async (sdk) => {
    const answered: string[] = [];
    const runtime = adapter([
      tool('reply', { questionId: 'question_child', body: 'Use a table.' }),
      tool('reply', { body: 'My own answer.' }),
      () => {
        throw new Error('own terminal reply must end the task');
      },
    ]);
    const start = startInput(sdk);
    start.assignment = {
      kind: 'question',
      questionId: 'question_own',
      body: 'Please answer after delegating.',
      askerExecutionId: 'exec_requester',
    };
    const { host } = recordingHost({
      ...sdkHost,
      authorizeTool: async (proposal) => {
        answered.push(String(proposal.args.questionId));
        return { ok: true, toolCallId: `tool_${answered.length}` };
      },
      executeTool: async (toolCallId) => ({
        ok: true,
        toolCallId,
        result: {
          questionId: answered.at(-1),
          terminal: answered.at(-1) === 'question_own',
        },
      }),
    });
    expect(await (await runtime.start(start, host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(answered).toEqual(['question_child', 'question_own']);
  },
);
