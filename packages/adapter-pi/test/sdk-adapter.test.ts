import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  type AgentStartInput,
  canonicalJson,
  type EffectiveHarnessSnapshot,
} from '@corral/contracts';
import { Gate, linearCorral } from '@corral/testkit';
import {
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { runSdkWorker } from '../src/sdk-worker.ts';
import { ACCESS_TOKEN, recordingHost } from './harness.ts';

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});
const hash = 'a'.repeat(64);
const snapshot: EffectiveHarnessSnapshot = {
  binding: { profileId: 'writing', revision: 1 },
  snapshotHash: hash,
  piVersion: '1.3.0',
  policyRevision: 1,
  policy: 'trusted-native',
  resources: [{ hash, name: 'fixture', version: '1.0.0', kind: 'extension', required: true }],
  allowedTools: ['echo', 'write_artifact', 'submit_result'],
  tools: [],
  diagnostics: [],
};
function input(): AgentStartInput {
  const role = linearCorral(['writer']).roles[0]!;
  return {
    runId: 'run_1',
    executionId: 'exec_1',
    taskId: 'task_1',
    nodeId: 'writer',
    attemptNo: 1,
    role: { ...role, harness: snapshot.binding },
    harness: snapshot,
    modelProfile: 'model-a',
    mode: 'live',
    model: { profile: 'model-a', provider: 'openai', modelId: 'faux-1', auth: 'oauth' },
    depth: 0,
    round: null,
    criteriaVersionId: 'criteria_1',
    assignment: { kind: 'scheduled' },
    capabilities: { delegateTo: [], askTo: [] },
    inputs: [{ name: 'brief', kind: 'run_input', artifactVersionId: null, text: 'Private brief.' }],
  };
}

function runtime(
  responses: FauxResponseStep[],
  extension = '',
  overrides: Partial<AgentHost> = {},
  skill?: { text: string; mode: 'auto' | 'explicit' | 'mandatory'; brief?: string },
  contextWindow?: number,
  startupCommands: string[] = [],
) {
  const directory = mkdtempSync(join(tmpdir(), 'corral-sdk-test-'));
  scratch.push(directory);
  const path = join(directory, 'fixture.ts');
  const content = extension || 'export default () => {}';
  writeFileSync(path, content);
  const files = [
    {
      path: 'fixture.ts',
      hash: createHash('sha256').update(content).digest('hex'),
      bytes: Buffer.byteLength(content),
    },
  ];
  if (skill) {
    writeFileSync(join(directory, 'SKILL.md'), skill.text);
    files.push({
      path: 'SKILL.md',
      hash: createHash('sha256').update(skill.text).digest('hex'),
      bytes: Buffer.byteLength(skill.text),
    });
  }
  const resourceHash = createHash('sha256').update(canonicalJson(files)).digest('hex');
  const start = input();
  start.harness = {
    ...snapshot,
    resources: [{ ...snapshot.resources[0]!, hash: resourceHash, entry: 'fixture.ts' }],
  };
  if (skill) {
    start.harness.allowedTools = [...start.harness.allowedTools, 'read'];
    start.harness.resources.push({
      hash: resourceHash,
      name: 'fixture',
      version: '1.0.0',
      kind: 'skill',
      entry: 'SKILL.md',
      required: true,
      skillName: 'writing',
      skillMode: skill.mode,
    });
    if (skill.brief) start.inputs[0]!.text = skill.brief;
  }
  const faux = createFauxCore(contextWindow ? { models: [{ id: 'faux-1', contextWindow }] } : {});
  faux.setResponses(responses);
  const frames: unknown[] = [];
  const reports: unknown[] = [];
  const requests: unknown[] = [];
  const { host, calls } = recordingHost({
    reportHarness: async (report) => {
      reports.push(report);
    },
    pendingDirectives: () => [],
    prepareModelRequest: async (record) => {
      requests.push(record);
      calls.push('prepare');
      return {
        modelCallId: `call_${requests.length}`,
        contextSnapshotId: `ctx_${requests.length}`,
        profile: 'model-a',
        maxOutputTokens: 256,
        directives: [],
      };
    },
    beginNativeTool: async () => {},
    finishNativeTool: async () => {},
    ...overrides,
  });
  const credentials = vi.fn(async () => ACCESS_TOKEN);
  const adapter = new PiAgentAdapter({
    spawn: () => {
      throw new Error('SDK must not start the core worker');
    },
    spawnSdk: () => {
      const pair = memoryChannelPair();
      pair.host.onFrame((frame) => frames.push(frame));
      runSdkWorker(pair.worker, {
        streamFn: faux.streamSimple,
        resolveModel: () => faux.getModel(),
        now: () => 1000,
        directory,
      });
      return pair.host;
    },
    harness: async () => ({
      extensions: [{ path, hash: resourceHash, source: 'extension:fixture@1.0.0' }],
      bundles: [{ root: directory, hash: resourceHash, files }],
      skills: skill
        ? [
            {
              name: 'writing',
              description: 'Writing with sources.',
              hash: resourceHash,
              entry: 'SKILL.md',
              mode: skill.mode,
              content:
                skill.mode === 'mandatory' || skill.brief?.startsWith('/skill:') ? skill.text : '',
            },
          ]
        : [],
      startupCommands,
    }),
    credentials,
    cancelGraceMs: 200,
  });
  return { adapter, host, calls, frames, reports, requests, credentials, directory, input: start };
}

describe('SDK worker through the product adapter (H2)', () => {
  it.each(['before_agent_start', 'context', 'tool_call', 'tool_result'] as const)(
    '[TC-HAR-006-N] stops after a required %s hook fails',
    async (event) => {
      const executeTool = vi.fn(async (toolCallId: string) => ({
        ok: true as const,
        toolCallId,
        result: { artifactVersionId: 'version_one' },
      }));
      const run = runtime(
        [
          fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'draft' })], {
            stopReason: 'toolUse',
          }),
          fauxAssistantMessage('Finished.'),
        ],
        `export default pi => { pi.on(${JSON.stringify(event)}, () => { throw new Error('private hook failure'); }); };`,
        { executeTool },
      );
      expect(
        await (await run.adapter.start(run.input, run.host)).waitForSettlement(),
      ).toMatchObject({ outcome: 'failed' });
      expect(executeTool).toHaveBeenCalledTimes(event === 'tool_result' ? 1 : 0);
      expect(run.credentials.mock.calls.length).toBeLessThanOrEqual(
        event === 'tool_call' || event === 'tool_result' ? 1 : 0,
      );
      expect(JSON.stringify(run.frames)).not.toContain('private hook failure');
    },
  );
  it('[TC-HAR-015-H] exposes item delegation and carries item identity into the actual SDK prompt', async () => {
    const proposals: unknown[] = [];
    const run = runtime(
      [
        (context) => {
          const tools = context.messages.flatMap((message) =>
            message.role === 'system' ? (message.toolsAdded ?? []) : [],
          );
          expect(
            JSON.stringify(tools.find((tool) => tool.name === 'spawn_subagents')?.parameters),
          ).toContain('items');
          expect(JSON.stringify(context.messages)).toContain('isolated item 2 of 3');
          return fauxAssistantMessage(
            [
              fauxToolCall('spawn_subagents', {
                tasks: [{ targetNodeId: 'helper', brief: 'this item only' }],
              }),
            ],
            { stopReason: 'toolUse' },
          );
        },
        fauxAssistantMessage('Finished.'),
      ],
      '',
      {
        authorizeTool: async (proposal) => {
          proposals.push(proposal);
          return { ok: true, toolCallId: 'tool_item' };
        },
      },
    );
    run.input.item = { batchId: 'batch_one', index: 2, total: 3 };
    run.input.harness!.allowedTools = ['spawn_subagents'];
    run.input.role.allowedCollaborationTools = ['spawn_subagents'];
    run.input.capabilities.delegateTo = [{ nodeId: 'helper', label: 'Helper' }];
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(proposals).toHaveLength(1);
  });
  it('[TC-HAR-010-H] advertises selected LSP queries only to a role with worktree read permission', async () => {
    for (const readable of [false, true]) {
      const executeTool = vi.fn(async (toolCallId: string) => ({
        ok: true as const,
        toolCallId,
        result: { result: { kind: 'locations', locations: [{ path: 'src/other.ts' }] } },
      }));
      const run = runtime(
        [
          (context) => {
            const tool = context.messages
              .flatMap((message) => (message.role === 'system' ? (message.toolsAdded ?? []) : []))
              .find((tool) => tool.name === 'lsp_query');
            expect(!!tool).toBe(readable);
            if (!readable) return fauxAssistantMessage('No file access.');
            expect(JSON.stringify(tool?.parameters)).toContain('typescript');
            return fauxAssistantMessage(
              [
                fauxToolCall('lsp_query', {
                  serverId: 'typescript',
                  operation: 'definition',
                  path: 'src/main.ts',
                  position: { line: 0, character: 1 },
                }),
              ],
              { stopReason: 'toolUse' },
            );
          },
          (context) => {
            expect(JSON.stringify(context.messages)).toContain('src/other.ts');
            return fauxAssistantMessage('Found the definition.');
          },
        ],
        '',
        { executeTool },
      );
      if (!run.input.harness) throw new Error('missing harness');
      run.input.harness.allowedTools = ['lsp_query'];
      run.input.harness.projectTools = {
        projectId: 'default',
        revision: 1,
        hash,
        checkIds: [],
        lspServerIds: ['typescript'],
      };
      run.input.role.allowedWorkTools = readable ? ['read_file'] : [];
      expect(
        await (await run.adapter.start(run.input, run.host)).waitForSettlement(),
      ).toMatchObject({ outcome: 'succeeded' });
      expect(executeTool).toHaveBeenCalledTimes(readable ? 1 : 0);
    }
  });
  it('[TC-HAR-012-H] exposes only selected registered check IDs and returns the owned report through the host', async () => {
    const proposals: { name: string; args: Record<string, unknown> }[] = [];
    const run = runtime(
      [
        (context) => {
          const tools = context.messages.flatMap((message) =>
            message.role === 'system' ? (message.toolsAdded ?? []) : [],
          );
          expect(tools.some((tool) => tool.name === 'run_check')).toBe(true);
          return fauxAssistantMessage([fauxToolCall('run_check', { commandId: 'types' })], {
            stopReason: 'toolUse',
          });
        },
        (context) => {
          expect(JSON.stringify(context.messages)).toContain('inconclusive');
          return fauxAssistantMessage('Check could not prove a pass.');
        },
      ],
      '',
      {
        authorizeTool: async (proposal) => {
          proposals.push(proposal);
          return { ok: true, toolCallId: 'tool_check' };
        },
        executeTool: async (toolCallId) => ({
          ok: true,
          toolCallId,
          result: { state: 'completed', verdict: 'inconclusive', stale: true },
        }),
      },
    );
    if (!run.input.harness) throw new Error('missing harness');
    run.input.harness.allowedTools = ['run_check'];
    run.input.harness.projectTools = {
      projectId: 'default',
      revision: 1,
      hash: 'c'.repeat(64),
      checkIds: ['types'],
      lspServerIds: [],
    };
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(proposals).toEqual([{ name: 'run_check', args: { commandId: 'types' } }]);
    expect(run.reports).toContainEqual(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'run_check', source: 'corral', sideEffect: 'external' }),
        ]),
      }),
    );
  });
  it('[TC-HAR-010-H] exposes authorized Pi coding tools and returns their standard result text', async () => {
    const proposals: { name: string; args: Record<string, unknown> }[] = [];
    const run = runtime(
      [
        (context) => {
          expect(
            context.messages.flatMap((message) =>
              message.role === 'system' ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
            ),
          ).toEqual(expect.arrayContaining(['edit', 'write']));
          return fauxAssistantMessage(
            [fauxToolCall('edit', { path: 'a.txt', edits: [{ oldText: 'one', newText: 'two' }] })],
            { stopReason: 'toolUse' },
          );
        },
        (context) => {
          expect(JSON.stringify(context.messages)).toContain(
            'Successfully replaced 1 block(s) in a.txt.',
          );
          return fauxAssistantMessage(
            [fauxToolCall('write', { path: 'new.txt', content: 'new' })],
            { stopReason: 'toolUse' },
          );
        },
        (context) => {
          expect(JSON.stringify(context.messages)).toContain('Successfully wrote to new.txt');
          return fauxAssistantMessage('Done.');
        },
      ],
      '',
      {
        authorizeTool: async (proposal) => {
          proposals.push(proposal);
          return { ok: true, toolCallId: `tool_${proposals.length}` };
        },
        executeTool: async (toolCallId) => ({
          ok: true,
          toolCallId,
          result:
            toolCallId === 'tool_1'
              ? {
                  piResult: {
                    content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.txt.' }],
                    details: { diff: 'diff', patch: 'patch', firstChangedLine: 1 },
                  },
                }
              : {},
        }),
      },
    );
    run.input.role.allowedWorkTools = ['read_file', 'write_file'];
    run.input.harness!.allowedTools = ['edit', 'write'];
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(proposals.map((proposal) => proposal.name)).toEqual(['edit', 'write']);
    expect(run.reports).toContainEqual(
      expect.objectContaining({
        tools: expect.arrayContaining([
          expect.objectContaining({ name: 'edit', source: 'corral', sideEffect: 'workspace' }),
        ]),
      }),
    );
  });
  it('[TC-HAR-007-H] records extension command origins and resolves a package-qualified startup command', async () => {
    let seen = '';
    const run = runtime(
      [
        (context) => {
          seen = JSON.stringify(context.messages);
          return fauxAssistantMessage('Done.');
        },
      ],
      `export default pi => { let mode='off'; pi.registerCommand('pause',{description:'Fixture mode',handler:async args=>{mode=args;}}); pi.on('before_agent_start', event=>{event.systemPromptOptions.sections.fixture='Fixture mode: '+mode;}); };`,
      {},
      undefined,
      undefined,
      ['/fixture:pause ultra'],
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(seen).toContain('Fixture mode: ultra');
    expect(run.reports).toContainEqual(
      expect.objectContaining({
        commands: [
          {
            name: 'pause',
            invocation: 'pause',
            alias: 'fixture:pause',
            source: 'extension:fixture@1.0.0',
            description: 'Fixture mode',
            condition: 'startup',
          },
        ],
      }),
    );
    expect(JSON.stringify(run.reports)).not.toContain(run.directory);
  });
  it('[TC-HAR-006-N] a required extension session-start error fails before any provider request', async () => {
    const run = runtime(
      [fauxAssistantMessage('Must not run.')],
      `export default pi => pi.on('session_start',()=>{ throw new Error('private startup detail'); });`,
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'failed',
    });
    expect(run.requests).toHaveLength(0);
    expect(run.reports).toContainEqual({
      ok: false,
      snapshotHash: hash,
      code: 'extension_load_failed',
    });
  });
  it('[TC-HAR-007-H] bridges extension dialogs and notifications without a model request during startup', async () => {
    const requests: unknown[] = [];
    const notices: unknown[] = [];
    const run = runtime(
      [fauxAssistantMessage('Done.')],
      `export default pi => pi.on('session_start', async (_e,ctx)=>{
      const yes=await ctx.ui.confirm('Continue?', 'Read only.', {timeout:500});
      const option=await ctx.ui.select('Mode', ['One','Two']);
      const name=await ctx.ui.input('Name','Example');
      if(!yes || option!=='Two' || name!=='Writer') throw new Error('wrong UI reply');
      ctx.ui.notify('Ready.'); ctx.ui.setStatus('fixture','Enabled'); ctx.ui.setWidget('unsupported', ['x']);
    });`,
      {
        requestExtensionUi: async (request) => {
          requests.push(request);
          return {
            status: 'answered',
            value: request.kind === 'confirm' ? true : request.kind === 'select' ? 'Two' : 'Writer',
          };
        },
        notifyExtensionUi: async (notice) => {
          notices.push(notice);
        },
      },
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(requests).toMatchObject([
      { kind: 'confirm', timeoutMs: 500 },
      { kind: 'select' },
      { kind: 'input' },
    ]);
    expect(notices).toMatchObject([
      { kind: 'notify', text: 'Ready.' },
      { kind: 'status', key: 'fixture', text: 'Enabled' },
      { kind: 'unsupported' },
    ]);
    expect(run.requests).toHaveLength(1);
  });
  it('[TC-HAR-007-N] a dialog AbortSignal reaches the host while its reply is pending', async () => {
    const cancelled = vi.fn();
    const run = runtime(
      [fauxAssistantMessage('Done.')],
      `export default pi => pi.on('session_start', async (_e,ctx)=>{
      const abort=new AbortController(); const result=ctx.ui.confirm('Continue?','',{signal:abort.signal}); abort.abort();
      if(await result) throw new Error('cancelled request approved');
    });`,
      {
        requestExtensionUi: (_request, cancellation) =>
          new Promise((resolve) => {
            const close = () => {
              cancelled();
              resolve({ status: 'cancelled' });
            };
            if (cancellation?.aborted) close();
            else cancellation?.onCancel(close);
          }),
      },
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it('[TC-HAR-001-H] keeps the SDK proxy identity while dispatching the actual provider identity', async () => {
    let seen = '';
    let originMatches = false;
    const run = runtime(
      [
        fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft' })], {
          stopReason: 'toolUse',
        }),
        (context, _options, _state, model) => {
          seen = JSON.stringify(context.messages);
          originMatches =
            context.messages.find((message) => message.role === 'assistant')?.provider ===
            model.provider;
          return fauxAssistantMessage('Done.');
        },
      ],
      `export default pi => pi.on('context_with_system', event => { const assistant=event.messages.find(message=>message.role==='assistant'); return assistant?{messages:event.messages.map(message=>message.role==='system'?{...message,sections:{...message.sections,sdk_identity:'SDK provider: '+assistant.provider}}:message)}:undefined; });`,
    );
    await (await run.adapter.start(run.input, run.host)).waitForSettlement();
    expect(seen).toContain('SDK provider: corral');
    expect(originMatches).toBe(true);
  });
  it('[TC-HAR-005-N] an extension cannot strip mandatory instructions from the final context', async () => {
    let seen = '';
    const run = runtime(
      [
        (context) => {
          seen = JSON.stringify(context.messages);
          return fauxAssistantMessage('Done.');
        },
      ],
      `export default pi => pi.on('context_with_system', event => ({messages:event.messages.map(message=>message.role==='system'?{...message,sections:{...message.sections,skill_writing:null}}:message)}));`,
      {},
      { text: 'Always cite sources.', mode: 'mandatory' },
    );
    await (await run.adapter.start(run.input, run.host)).waitForSettlement();
    expect(seen).toContain('Always cite sources.');
  });

  it('[TC-HAR-001-H] automatic threshold compaction uses permits and mandatory skills remain in the following turn', async () => {
    const seen: { purpose: string; text: string }[] = [];
    const responses: FauxResponseStep[] = Array.from({ length: 8 }, () => (context) => {
      seen.push({
        purpose: (run.requests.at(-1) as { purpose: string }).purpose,
        text: JSON.stringify(context.messages),
      });
      return fauxAssistantMessage('A short summary or answer.');
    });
    const run = runtime(
      responses,
      `export default pi => { let round=0; pi.on('agent_before_settle', ()=>{ if(round<3){ pi.sendUserMessage(round++<2?'Context history. '.repeat(3500):'Continue briefly.',{deliverAs:'followUp'}); } }); };`,
      {},
      { text: 'Always cite sources.', mode: 'mandatory', brief: 'Context history. '.repeat(3500) },
      65536,
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(seen.some((request) => request.purpose === 'compaction')).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      purpose: 'turn',
      text: expect.stringContaining('Always cite sources.'),
    });
    expect(run.credentials).toHaveBeenCalledTimes(seen.length);
    expect(run.calls.filter((call) => call.startsWith('observe'))).toHaveLength(seen.length);
  });
  it('[TC-HAR-005-H] lists auto skills virtually and formats broker reads with Pi offset and limit behavior', async () => {
    let observed = '';
    const run = runtime(
      [
        (context) => {
          expect(JSON.stringify(context.messages)).toContain('skills/writing/SKILL.md');
          return fauxAssistantMessage(
            [fauxToolCall('read', { path: 'skills/writing/SKILL.md', offset: 2, limit: 1 })],
            { stopReason: 'toolUse' },
          );
        },
        (context) => {
          const result = context.messages.filter((message) => message.role === 'toolResult').at(-1);
          observed = JSON.stringify(result?.content);
          return fauxAssistantMessage('Done.');
        },
      ],
      '',
      {
        executeTool: async (toolCallId) => ({
          ok: true,
          toolCallId,
          result: {
            path: 'skills/writing/SKILL.md',
            text: 'one\ntwo\nthree',
            sha256: 'c'.repeat(64),
          },
        }),
      },
      { text: 'one\ntwo\nthree', mode: 'auto' },
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(observed).toContain('two');
    expect(observed).not.toContain('one');
    expect(observed).not.toContain('three');
  });

  it('[TC-HAR-005-H] expands an explicit skill command in Corral without exposing a local path', async () => {
    let seen = '';
    const run = runtime(
      [
        (context) => {
          seen = JSON.stringify(context.messages);
          return fauxAssistantMessage('Done.');
        },
      ],
      '',
      {},
      { text: 'Use verified evidence.', mode: 'explicit', brief: '/skill:writing Write a note.' },
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(seen).toContain('Use verified evidence.');
    expect(seen).toContain('Write a note.');
    expect(seen).not.toContain(run.directory);
    expect(seen).not.toContain('/skill:writing');
  });
  it('[TC-HAR-003-N] resource preparation errors never disclose a local path or body', async () => {
    const run = runtime([]);
    const spawn = vi.fn();
    const adapter = new PiAgentAdapter({
      spawn,
      spawnSdk: spawn,
      harness: async () => {
        throw new Error('/private/path: private body');
      },
      credentials: async () => null,
    });
    await expect(adapter.start(run.input, run.host)).rejects.toThrow(
      'harness resources could not be prepared',
    );
    expect(spawn).not.toHaveBeenCalled();
  });
  it('[TC-HAR-009-N] refuses a binding without a resolved snapshot before spawning or looking up credentials', async () => {
    const spawn = vi.fn();
    const credentials = vi.fn();
    const adapter = new PiAgentAdapter({ spawn, credentials });
    const start = input();
    delete start.harness;
    await expect(adapter.start(start, recordingHost().host)).rejects.toThrow(/harness/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });

  it('[TC-HAR-001-H] [TC-HAR-003-H] records and permits the real context for each request and retry', async () => {
    const run = runtime([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'The service is temporarily unavailable',
      }),
      fauxAssistantMessage('Recovered.'),
    ]);
    const handle = await run.adapter.start(run.input, run.host);
    expect(await handle.waitForSettlement()).toMatchObject({ outcome: 'succeeded' });
    expect(run.credentials).toHaveBeenCalledTimes(2);
    expect(run.requests).toMatchObject([
      { purpose: 'turn', directiveIds: [] },
      { purpose: 'retry', directiveIds: [] },
    ]);
    expect(run.calls.filter((c) => c.startsWith('observe'))).toEqual([
      'observe call_1',
      'observe call_2',
    ]);
    expect(run.reports).toMatchObject([{ ok: true, snapshotHash: hash }]);
    for (const request of run.requests)
      expect(request).toMatchObject({
        contextHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        contextBytes: expect.any(Number),
      });
    expect(JSON.stringify(run.requests)).not.toContain('Private brief.');
    expect(JSON.stringify(run.requests)).not.toContain(run.directory);
    expect(JSON.stringify(run.frames)).not.toContain(ACCESS_TOKEN);
  });

  it('[TC-HAR-002-H] authorizes final extension arguments, then starts and settles the unmanaged effect', async () => {
    const order: string[] = [];
    const run = runtime(
      [
        fauxAssistantMessage([fauxToolCall('echo', { text: 'before' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Done.'),
      ],
      `export default pi => {
      pi.registerTool({name:'echo',label:'Echo',description:'Echo text',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},annotations:{readOnlyHint:true,openWorldHint:false},execute:async (_id,args) => ({content:[{type:'text',text:args.text}],details:{}})});
      pi.on('tool_call', event => { if(event.toolName==='echo') event.input.text='after'; });
    }`,
      {
        authorizeTool: async (proposal) => {
          expect(proposal.args).toEqual({ text: 'after' });
          order.push('authorized');
          return { ok: true, toolCallId: 'tool_1' };
        },
        beginNativeTool: async (_id, argsHash) => {
          expect(argsHash).toMatch(/^[a-f0-9]{64}$/);
          order.push('started');
        },
        finishNativeTool: async (_id, outcome) => {
          expect(outcome).toBe('succeeded');
          order.push('finished');
        },
      },
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(order).toEqual(['authorized', 'started', 'finished']);
  });

  it('[TC-HAR-001-N] a refused permit makes no provider request', async () => {
    let dispatched = 0;
    const run = runtime(
      [
        () => {
          dispatched++;
          return fauxAssistantMessage('Must not run');
        },
      ],
      '',
      {
        prepareModelRequest: async () => {
          throw new Error('budget exhausted');
        },
      },
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'failed',
    });
    expect(dispatched).toBe(0);
    expect(run.credentials).not.toHaveBeenCalled();
  });

  it('[TC-HAR-001-N] cancellation between permit and dispatch never contacts the provider', async () => {
    let dispatched = 0;
    const run = runtime(
      [
        () => {
          dispatched++;
          return fauxAssistantMessage('Must not run');
        },
      ],
      '',
      {
        modelRequestDispatched: async () => {
          throw new Error('scope cancelled');
        },
      },
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'failed',
    });
    expect(dispatched).toBe(0);
    expect(run.calls.filter((c) => c.startsWith('observe'))).toEqual(['observe call_1']);
  });

  it('[TC-HAR-002-N] validates arguments again after extension hooks, before host authorization', async () => {
    const authorize = vi.fn(async () => ({ ok: true as const, toolCallId: 'tool_1' }));
    const run = runtime(
      [
        fauxAssistantMessage([fauxToolCall('echo', { text: 'before' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Rejected.'),
      ],
      `export default pi => {
      pi.registerTool({name:'echo',label:'Echo',description:'Echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},execute:async () => ({content:[],details:{}})});
      pi.on('tool_call', event => { event.input.text={invalid:true}; });
    }`,
      { authorizeTool: authorize },
    );
    await (await run.adapter.start(run.input, run.host)).waitForSettlement();
    expect(authorize).not.toHaveBeenCalled();
  });

  it('[TC-HAR-003-H] steers an in-flight execution and reports only directives in the actual request', async () => {
    const entered = new Gate();
    const release = new Gate();
    const run = runtime([
      async () => {
        entered.open();
        await release.wait();
        return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft' })], {
          stopReason: 'toolUse',
        });
      },
      fauxAssistantMessage('Done.'),
    ]);
    const handle = await run.adapter.start(run.input, run.host);
    await entered.wait();
    handle.pushDirective!({ directiveId: 'directive_1', text: 'Keep sources.' });
    release.open();
    await handle.waitForSettlement();
    expect(run.requests).toMatchObject([{ directiveIds: [] }, { directiveIds: ['directive_1'] }]);
  });

  it('[TC-HAR-001-H] nested model calls made by an extension use their own permits and observations', async () => {
    const run = runtime(
      [
        fauxAssistantMessage([fauxToolCall('echo', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Nested answer.'),
        fauxAssistantMessage('Done.'),
      ],
      `export default pi => pi.registerTool({name:'echo',label:'Echo',description:'Nested request',parameters:{type:'object',properties:{}},execute:async (_id,_args,_signal,_update,ctx) => {
      const answer=await ctx.modelRegistry.streamSimple(ctx.modelRegistry.find('corral','faux-1'),{messages:[{role:'user',content:'Nested',timestamp:0}]}).result();
      return {content:answer.content.filter(c=>c.type==='text'),details:{}};
    }});`,
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(run.requests).toMatchObject([
      { purpose: 'turn' },
      { purpose: 'extension' },
      { purpose: 'turn' },
    ]);
    expect(run.credentials).toHaveBeenCalledTimes(3);
    expect(run.calls.filter((c) => c.startsWith('observe'))).toEqual([
      'observe call_1',
      'observe call_2',
      'observe call_3',
    ]);
  });

  it('[TC-HAR-006-N] a required extension that fails to load fails without a model request or fallback', async () => {
    const run = runtime(
      [fauxAssistantMessage('Must not run')],
      'throw new Error("private path/body");',
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'failed',
    });
    expect(run.credentials).not.toHaveBeenCalled();
    expect(run.reports).toMatchObject([{ ok: false, code: 'extension_load_failed' }]);
    expect(JSON.stringify(run.reports)).not.toContain('private path/body');
  });

  it('[TC-HAR-002-N] a denied native tool never starts', async () => {
    const begin = vi.fn();
    const run = runtime(
      [
        fauxAssistantMessage([fauxToolCall('echo', {})], { stopReason: 'toolUse' }),
        fauxAssistantMessage('Denied.'),
      ],
      `export default pi => pi.registerTool({name:'echo',label:'Echo',description:'Echo',parameters:{type:'object',properties:{}},execute:async () => { throw new Error('must not execute'); }});`,
      {
        authorizeTool: async () => ({
          ok: false,
          toolCallId: 'tool_no',
          error: { code: 'CAPABILITY_DENIED', message: 'denied' },
        }),
        beginNativeTool: begin,
      },
    );
    await (await run.adapter.start(run.input, run.host)).waitForSettlement();
    expect(begin).not.toHaveBeenCalled();
  });

  it('[TC-HAR-006-H] cancellation ends the SDK execution and fences a late answer', async () => {
    const gate = new Gate();
    const entered = new Gate();
    const run = runtime([
      async () => {
        entered.open();
        await gate.wait();
        return fauxAssistantMessage('Late');
      },
    ]);
    const handle = await run.adapter.start(run.input, run.host);
    await entered.wait();
    await handle.cancel('user cancelled');
    gate.open();
    expect(await handle.waitForSettlement()).toMatchObject({ outcome: 'cancelled' });
  });
});
