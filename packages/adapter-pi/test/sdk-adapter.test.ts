import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AgentHost,
  type AgentStartInput,
  canonicalJson,
  type EffectiveHarnessSnapshot,
} from '@corral/contracts';
import { resolveProfileContext } from '@corral/core';
import { Gate, linearCorral } from '@corral/testkit';
import {
  createFauxCore,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from '@earendil-works/pi-ai';
import { SettingsManager, shouldCompact } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PiAgentAdapter } from '../src/adapter.ts';
import { memoryChannelPair } from '../src/channel.ts';
import { probeMcp } from '../src/mcp-probe.ts';
import type { SdkResources } from '../src/protocol.ts';
import {
  LEGACY_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  SdkStartFrame,
  StartFrame,
} from '../src/protocol.ts';
import { runSdkWorker } from '../src/sdk-worker.ts';
import { runWorker } from '../src/worker.ts';
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
  nativeResources: Partial<SdkResources> = {},
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
  const streamed: { contextWindow: number; maxTokens: number | undefined }[] = [];
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
        streamFn: (model, context, options) => {
          streamed.push({ contextWindow: model.contextWindow, maxTokens: options?.maxTokens });
          return faux.streamSimple(model, context, options);
        },
        resolveModel: () => faux.getModel(),
        now: () => 1000,
        directory,
        workerLeaseDirectory: join(directory, 'durable-workers'),
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
      ...nativeResources,
    }),
    credentials,
    cancelGraceMs: 200,
  });
  return {
    adapter,
    host,
    calls,
    frames,
    reports,
    requests,
    credentials,
    directory,
    input: start,
    streamed,
    catalogModel: faux.getModel(),
  };
}

describe('SDK worker through the product adapter (H2)', () => {
  it('preserves generated image tool results as pixels in the next model context', async () => {
    const data =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZxkAAAAASUVORK5CYII=';
    const bytes = Buffer.from(data, 'base64');
    let imagePresent = false;
    let base64Prose = false;
    const run = runtime(
      [
        fauxAssistantMessage([fauxToolCall('read_artifact', { artifactVersionId: 'artv_image' })], {
          stopReason: 'toolUse',
        }),
        (context) => {
          for (const message of context.messages) {
            if (message.role !== 'toolResult') continue;
            imagePresent ||= message.content.some(
              (part) => part.type === 'image' && part.data === data,
            );
            base64Prose ||= message.content.some(
              (part) => part.type === 'text' && part.text.includes(data),
            );
          }
          return fauxAssistantMessage('Image inspected.');
        },
      ],
      '',
      {
        executeTool: async (toolCallId) => ({
          ok: true,
          toolCallId,
          result: {
            artifactVersionId: 'artv_image',
            images: [
              {
                kind: 'image_attachment',
                imageId: 'artv_image',
                name: 'image.png',
                mime: 'image/png',
                bytes: bytes.length,
                width: 1,
                height: 1,
                sha256: createHash('sha256').update(bytes).digest('hex'),
                data,
              },
            ],
          },
        }),
      },
    );
    run.input.role.allowedCollaborationTools = ['read_artifact'];
    if (!run.input.harness) throw new Error('missing harness');
    run.input.harness.allowedTools = ['read_artifact'];
    await (await run.adapter.start(run.input, run.host)).waitForSettlement();
    expect(imagePresent).toBe(true);
    expect(base64Prose).toBe(false);
  });

  it.each(['trusted-native', 'strict'] as const)(
    'offers shell commands only to an explicitly allowed trusted-native role (%s)',
    async (policy) => {
      let names: string[] = [];
      let transcript = '';
      const proposals: string[] = [];
      const executeTool = vi.fn(async (toolCallId: string) => ({
        ok: false as const,
        toolCallId,
        error: { code: 'CAPABILITY_DENIED' as const, message: 'launch cancelled before spawn' },
      }));
      const run = runtime(
        [
          (context) => {
            names = context.messages.flatMap((message) =>
              message.role === 'system' ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
            );
            return policy === 'trusted-native'
              ? fauxAssistantMessage(
                  [
                    fauxToolCall('run_command', {
                      command: 'echo hello',
                      cwd: '.',
                      timeoutMs: 1000,
                    }),
                  ],
                  { stopReason: 'toolUse' },
                )
              : fauxAssistantMessage('No permitted shell.');
          },
          (context) => {
            transcript = JSON.stringify(context.messages);
            return fauxAssistantMessage('Command was refused.');
          },
        ],
        '',
        {
          authorizeTool: async (proposal) => {
            proposals.push(proposal.name);
            return { ok: true, toolCallId: 'tool_command' };
          },
          executeTool,
        },
        undefined,
        undefined,
        [],
        policy === 'strict' ? { extensions: [], bundles: [] } : {},
      );
      run.input.role.allowedWorkTools = ['run_command'];
      run.input.harness!.allowedTools = ['run_command'];
      run.input.harness!.policy = policy;
      if (policy === 'strict') run.input.harness!.resources = [];
      expect(
        await (await run.adapter.start(run.input, run.host)).waitForSettlement(),
      ).toMatchObject({ outcome: 'succeeded' });
      expect(names.includes('run_command')).toBe(policy === 'trusted-native');
      expect(proposals).toEqual(policy === 'trusted-native' ? ['run_command'] : []);
      expect(executeTool).toHaveBeenCalledTimes(policy === 'trusted-native' ? 1 : 0);
      if (policy === 'trusted-native')
        expect(transcript).toContain('launch cancelled before spawn');
    },
  );
  it.each(['pi', 'hashline'] as const)(
    'pins one editing syntax while preserving independent file capabilities (%s)',
    async (editingMode) => {
      let names: string[] = [];
      const run = runtime([
        (context) => {
          names = context.messages.flatMap((message) =>
            message.role === 'system' ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
          );
          return fauxAssistantMessage('Tools inspected.');
        },
      ]);
      run.input.role.allowedWorkTools = ['read_file', 'write_file', 'delete_file', 'move_file'];
      run.input.role.editingMode = editingMode;
      run.input.harness!.allowedTools = [
        'read_file',
        'write_file',
        'delete_file',
        'move_file',
        'read',
        'edit',
        'write',
        'read_hashline',
        'edit_hashline',
      ];
      expect(
        await (await run.adapter.start(run.input, run.host)).waitForSettlement(),
      ).toMatchObject({ outcome: 'succeeded' });
      expect(names).toEqual(expect.arrayContaining(['write_file', 'delete_file', 'move_file']));
      expect(names.includes('edit')).toBe(editingMode === 'pi');
      expect(names.includes('write')).toBe(editingMode === 'pi');
      expect(names.includes('read_hashline')).toBe(editingMode === 'hashline');
      expect(names.includes('edit_hashline')).toBe(editingMode === 'hashline');
    },
  );
  it('does not advertise shell or hashline writes to a review-only execution', async () => {
    let names: string[] = [];
    const run = runtime([
      (context) => {
        names = context.messages.flatMap((message) =>
          message.role === 'system' ? (message.toolsAdded ?? []).map((tool) => tool.name) : [],
        );
        return fauxAssistantMessage('Review only.');
      },
    ]);
    run.input.role.allowedWorkTools = ['read_file', 'write_file', 'run_command'];
    run.input.role.editingMode = 'hashline';
    run.input.harness!.allowedTools = ['read_hashline', 'edit_hashline', 'run_command'];
    run.input.taskBrief = {
      version: 1,
      inputHash: hash,
      criteriaVersionId: run.input.criteriaVersionId,
      assignment: 'scheduled',
      outputContract: 'text',
      taskScope: 'review_only',
      verificationScope: 'targeted',
      canModifyFiles: false,
      limits: linearCorral(['writer']).limits,
      sourceRefs: [],
      resources: [],
    };
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(names).toContain('read_hashline');
    expect(names).not.toContain('edit_hashline');
    expect(names).not.toContain('run_command');
  });
  it('applies profile limits to Pi settings and stream models without changing the catalog', async () => {
    const spy = vi.spyOn(SettingsManager, 'inMemory');
    try {
      const run = runtime([fauxAssistantMessage('Done.')]);
      const before = run.catalogModel.contextWindow;
      run.input.model.contextPolicy = resolveProfileContext(
        { contextWindow: 64000, compaction: { reserveTokens: 0, keepRecentTokens: 0 } },
        { contextWindow: before, source: 'catalog' },
        'fixture',
        256,
      ).policy!;
      expect(
        await (await run.adapter.start(run.input, run.host)).waitForSettlement(),
      ).toMatchObject({ outcome: 'succeeded' });
      expect(run.streamed).toEqual([{ contextWindow: 64000, maxTokens: 256 }]);
      expect(run.catalogModel.contextWindow).toBe(before);
      expect(spy).toHaveBeenCalledWith(
        expect.objectContaining({
          cacheWarming: 'off',
          retry: expect.objectContaining({ enabled: false }),
          compaction: { enabled: false, reserveTokens: 0, keepRecentTokens: 0 },
        }),
      );
      const settings = SettingsManager.inMemory({
        compaction: { reserveTokens: 0, keepRecentTokens: 0 },
      }).getCompactionSettings();
      expect([63999, 64000, 64001].map((n) => shouldCompact(n, 64000, settings))).toEqual([
        false,
        false,
        true,
      ]);
    } finally {
      spy.mockRestore();
    }
  });
  it.each([true, false])(
    'a %s accepted submission ends without a confirmation request',
    async (accepted) => {
      const run = runtime(
        [
          fauxAssistantMessage(
            [fauxToolCall('submit_result', { artifactVersionIds: ['artv_1'] })],
            { stopReason: 'toolUse' },
          ),
          fauxAssistantMessage('Submission was refused.'),
        ],
        '',
        {
          executeTool: async (toolCallId) =>
            accepted
              ? { ok: true, toolCallId, result: {} }
              : { ok: false, toolCallId, error: { code: 'CAPABILITY_DENIED', message: 'refused' } },
        },
      );
      expect(
        await (await run.adapter.start(run.input, run.host)).waitForSettlement(),
      ).toMatchObject({ outcome: 'succeeded' });
      expect(run.requests).toHaveLength(accepted ? 1 : 2);
    },
  );

  // Discovery and execution launch separate real MCP processes. Their combined
  // startup, two bounded RPC phases and confirmed cleanup need an outer budget
  // greater than either individual five-second protocol deadline.
  it.each([false, true])(
    'MCP native calls preserve error results (%s)',
    async (isError) => {
      const cwd = mkdtempSync(join(tmpdir(), 'corral-mcp-copy-'));
      scratch.push(cwd);
      writeFileSync(join(cwd, 'marker.txt'), 'managed copy');
      writeFileSync(
        join(cwd, 'server.mjs'),
        `import {createInterface} from 'node:readline';import {readFileSync} from 'node:fs';const input=createInterface({input:process.stdin});input.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Read fixture',inputSchema:{type:'object',properties:{}},annotations:{readOnlyHint:true,openWorldHint:false}},{name:'forbidden',description:'Not allowed',inputSchema:{type:'object',properties:{}}},...['a-b','a_b','long_'.repeat(20)].map(name=>({name,inputSchema:{type:'object',properties:{}}}))]}:m.method==='tools/call'?{isError:${isError},content:[{type:'text',text:readFileSync('marker.txt','utf8')}]}:{};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`,
      );
      const discovered = await probeMcp({
        server: {
          id: 'docs',
          name: 'Docs',
          transport: 'stdio',
          argv: [process.execPath, 'server.mjs'],
          exposure: 'direct',
          timeoutMs: 5000,
        },
        cwd,
        leaseDirectory: join(cwd, 'probe-leases'),
        signal: new AbortController().signal,
        authorization: async () => undefined,
      });
      const allowedNames = discovered
        .filter((tool) => tool.title !== 'forbidden')
        .map((tool) => tool.name);
      expect(new Set(discovered.map((tool) => tool.name)).size).toBe(5);
      const updates: unknown[] = [],
        began: string[] = [];
      const outcomes: string[] = [];
      let sawResult = false;
      const run = runtime(
        [
          (context) => {
            expect(
              context.messages.flatMap((message) =>
                message.role === 'system'
                  ? (message.toolsAdded ?? []).map((tool) => tool.name)
                  : [],
              ),
            ).toEqual(expect.arrayContaining(allowedNames));
            expect(
              context.messages.flatMap((message) =>
                message.role === 'system'
                  ? (message.toolsAdded ?? []).map((tool) => tool.name)
                  : [],
              ),
            ).not.toContain('mcp__docs__forbidden');
            return fauxAssistantMessage([fauxToolCall('mcp__docs__echo', {})], {
              stopReason: 'toolUse',
            });
          },
          (context) => {
            sawResult = JSON.stringify(context.messages).includes('managed copy');
            expect(
              readdirSync(join(run.directory, 'durable-workers')).filter((name) =>
                name.endsWith('.json'),
              ),
            ).toHaveLength(1);
            return fauxAssistantMessage('done');
          },
        ],
        '',
        {
          mcpAuthorization: async () => undefined,
          updateHarnessTools: async (update) => {
            updates.push(update);
          },
          finishNativeTool: async (_id, outcome) => {
            outcomes.push(outcome);
          },
          beginNativeTool: async (id) => {
            began.push(id);
          },
        },
        undefined,
        undefined,
        [],
        {
          cwd,
          mcp: [
            {
              server: {
                id: 'docs',
                name: 'Docs',
                transport: 'stdio',
                argv: [process.execPath, 'server.mjs'],
                exposure: 'direct',
                timeoutMs: 5000,
              },
              fingerprint: 'a'.repeat(64),
            },
          ],
        },
      );
      run.input.harness!.allowedTools = allowedNames;
      run.input.harness!.projectTools = {
        projectId: 'p',
        revision: 1,
        hash: 'a'.repeat(64),
        checkIds: [],
        lspServerIds: [],
        mcpServerIds: ['docs'],
      };
      expect(
        await (await run.adapter.start(run.input, run.host)).waitForSettlement(),
        JSON.stringify(run.frames),
      ).toMatchObject({
        outcome: 'succeeded',
      });
      expect(sawResult).toBe(true);
      expect(readdirSync(join(run.directory, 'durable-workers'))).toEqual([]);
      expect(began).toHaveLength(1);
      expect(outcomes).toEqual([isError ? 'failed' : 'succeeded']);
      expect(JSON.stringify(updates)).toContain('extension:pi-mcp@1.3.0');
      for (const request of run.requests) {
        expect(request).toMatchObject({
          contextUsage: {
            coverage: 'request',
            completeness: 'complete',
            parts: expect.arrayContaining([
              expect.objectContaining({ category: 'mcp_tools', tokens: expect.any(Number) }),
            ]),
          },
        });
        expect(JSON.stringify(request)).not.toContain('unmeasured_tool');
      }
    },
    20000,
  );

  it('uses Pi codemode to invoke a Corral tool through the owned nested approval', async () => {
    const proposals: unknown[] = [];
    const run = runtime(
      [
        fauxAssistantMessage(
          [
            fauxToolCall('codemode', {
              code: 'const result = await tools.write_artifact({text:"codemode output"}); text(result);',
            }),
          ],
          { stopReason: 'toolUse' },
        ),
        fauxAssistantMessage('done'),
      ],
      '',
      {
        authorizeTool: async (proposal) => {
          proposals.push(proposal);
          return { ok: true, toolCallId: 'owned_' + proposals.length };
        },
      },
    );
    run.input.harness!.allowedTools = ['codemode', 'write_artifact'];
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(proposals).toEqual([
      { name: 'codemode', args: { code: expect.any(String) } },
      { name: 'write_artifact', args: { text: 'codemode output' }, parentToolCallId: 'owned_1' },
    ]);
    expect(JSON.stringify(run.reports)).toContain('extension:pi-codemode@1.3.0');
  });
  it('maps nested Pi calls to the owning Corral native call', async () => {
    const proposals: { name: string; parentToolCallId?: string }[] = [];
    const run = runtime(
      [
        fauxAssistantMessage([fauxToolCall('echo', { text: 'parent' })], { stopReason: 'toolUse' }),
        fauxAssistantMessage('done'),
      ],
      `export default pi=>{pi.registerTool({name:'echo',label:'Echo',description:'Nested call',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},execute:async(id,args,signal,update,ctx)=>{await ctx.executeTool('write_artifact',{text:'child'});return {content:[{type:'text',text:'done'}],details:{}};}});};`,
      {
        authorizeTool: async (proposal) => {
          proposals.push(proposal);
          return { ok: true, toolCallId: 'owned_' + proposals.length };
        },
      },
    );
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(proposals).toEqual([
      { name: 'echo', args: { text: 'parent' } },
      { name: 'write_artifact', args: { text: 'child' }, parentToolCallId: 'owned_1' },
    ]);
  });
  it.each(['session_start', 'before_agent_start'] as const)(
    'wraps tools registered during %s and reports them before use',
    async (event) => {
      const updates: unknown[] = [],
        began: unknown[] = [];
      const run = runtime(
        [
          fauxAssistantMessage([fauxToolCall('echo', { text: 'dynamic' })], {
            stopReason: 'toolUse',
          }),
          (context) => {
            expect(JSON.stringify(context.messages)).toContain('DYNAMIC RESULT');
            return fauxAssistantMessage('done');
          },
        ],
        `export default pi => { pi.on(${JSON.stringify(event)}, () => { pi.registerTool({name:'echo',label:'Echo',description:'Dynamic echo',parameters:{type:'object',properties:{text:{type:'string'}},required:['text']},execute:async()=>({content:[{type:'text',text:'DYNAMIC RESULT'}],details:{}})}); }); };`,
        {
          updateHarnessTools: async (update) => {
            updates.push(update);
          },
          beginNativeTool: async (...args) => {
            began.push(args);
          },
        },
      );
      expect(
        await (await run.adapter.start(run.input, run.host)).waitForSettlement(),
      ).toMatchObject({ outcome: 'succeeded' });
      expect(began).toHaveLength(1);
      if (event === 'before_agent_start') expect(updates).toHaveLength(1);
      expect(JSON.stringify([...run.reports, ...updates])).toContain('echo');
    },
  );
  it.each(['before_agent_start', 'context', 'tool_call', 'tool_result'] as const)(
    'stops after a required %s hook fails',
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
  it('exposes item delegation and carries item identity into the actual SDK prompt', async () => {
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
  it('advertises selected LSP queries only to a role with worktree read permission', async () => {
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
  it('exposes only selected registered check IDs and returns the owned report through the host', async () => {
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
  it('exposes authorized Pi coding tools and returns their standard result text', async () => {
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
  it('records extension command origins and resolves a package-qualified startup command', async () => {
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
  it('a required extension session-start error fails before any provider request', async () => {
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
  it('bridges extension dialogs and notifications without a model request during startup', async () => {
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
  it('a dialog AbortSignal reaches the host while its reply is pending', async () => {
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
  it('keeps the SDK proxy identity while dispatching the actual provider identity', async () => {
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
  it('an extension cannot strip mandatory instructions from the final context', async () => {
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

  it('automatic threshold compaction uses permits and mandatory skills remain in the following turn', async () => {
    const protectedText =
      'Coordinator state: private plan, unanswered question, exact criterion and resource hash.';
    const protectedValue = {
      version: 1 as const,
      text: protectedText,
      hash: createHash('sha256').update(canonicalJson(protectedText)).digest('hex'),
    };
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
      { protectedContext: () => protectedValue },
      { text: 'Always cite sources.', mode: 'mandatory', brief: 'Context history. '.repeat(3500) },
      128000,
    );
    run.input.model.contextPolicy = resolveProfileContext(
      { contextWindow: 65536 },
      { contextWindow: 128000, source: 'catalog' },
      'threshold',
      256,
    ).policy!;
    expect(await (await run.adapter.start(run.input, run.host)).waitForSettlement()).toMatchObject({
      outcome: 'succeeded',
    });
    expect(seen.some((request) => request.purpose === 'compaction')).toBe(true);
    expect(seen.at(-1)).toMatchObject({
      purpose: 'turn',
      text: expect.stringContaining('Always cite sources.'),
    });
    expect(seen.at(-1)?.text).toContain(protectedText);
    expect(run.credentials).toHaveBeenCalledTimes(seen.length);
    expect(run.calls.filter((call) => call.startsWith('observe'))).toHaveLength(seen.length);
  });
  it.each(['success', 'error', 'cancel'])(
    'queued manual compaction resumes at an idle boundary and preserves context on failure (mode=%s)',
    async (mode) => {
      const fail = mode === 'error';
      const entered = new Gate(),
        release = new Gate();
      let handle!: Awaited<ReturnType<PiAgentAdapter['start']>>;
      const phases: string[] = [];
      let turns = 0,
        summaryCalls = 0;
      const marker = 'Keep this precise requirement.';
      const responses: FauxResponseStep[] = Array.from({ length: 10 }, () => async (context) => {
        const purpose = (run.requests.at(-1) as { purpose: string }).purpose;
        if (purpose === 'compaction') {
          summaryCalls++;
          if (mode === 'cancel') {
            entered.open();
            await release.wait();
          }
          return fauxAssistantMessage(
            fail ? '' : 'A compact summary.',
            fail ? { stopReason: 'error', errorMessage: 'fixture summary failure' } : {},
          );
        }
        turns++;
        if (turns === 1) return fauxAssistantMessage('First response.');
        if (turns === 2) {
          handle.requestCompaction!('compact_manual');
          return fauxAssistantMessage('Second response.');
        }
        if (fail) {
          expect(JSON.stringify(context.messages)).toContain(marker);
          expect(JSON.stringify(context.messages)).toContain('First response.');
        }
        return fauxAssistantMessage(
          [fauxToolCall('submit_result', { artifactVersionIds: ['artv_fixture'] })],
          { stopReason: 'toolUse' },
        );
      });
      const run = runtime(
        responses,
        `export default pi => { let round=0; pi.on('agent_before_settle', () => { if (round++ === 0) pi.sendUserMessage('Older history. '.repeat(6000), {deliverAs:'followUp'}); }); };`,
        {
          reportCompaction: async (report) => {
            phases.push(report.phase);
          },
        },
        { text: marker, mode: 'mandatory', brief: `${marker} ${'History context. '.repeat(3500)}` },
        262144,
      );
      run.input.model.contextPolicy = resolveProfileContext(
        { contextWindow: 262144, compaction: { reserveTokens: 0, keepRecentTokens: 0 } },
        { contextWindow: 262144, source: 'catalog' },
        'fixture',
        256,
      ).policy!;
      handle = await run.adapter.start(run.input, run.host);
      if (mode === 'cancel') {
        await entered.wait();
        await handle.cancel('user cancelled');
        release.open();
      }
      expect(await handle.waitForSettlement()).toMatchObject({
        outcome: mode === 'cancel' ? 'cancelled' : 'succeeded',
      });
      expect(summaryCalls).toBeGreaterThan(0);
      expect(run.streamed.every((call) => call.maxTokens === 256)).toBe(true);
      expect(phases).toEqual(
        mode === 'cancel' ? ['started'] : ['started', fail ? 'failed' : 'completed'],
      );
      expect(turns).toBe(mode === 'cancel' ? 2 : 3);
    },
  );
  it('lists auto skills virtually and formats broker reads with Pi offset and limit behavior', async () => {
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

  it('expands an explicit skill command in Corral without exposing a local path', async () => {
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
  it('resource preparation errors never disclose a local path or body', async () => {
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
  it('refuses a binding without a resolved snapshot before spawning or looking up credentials', async () => {
    const spawn = vi.fn();
    const credentials = vi.fn();
    const adapter = new PiAgentAdapter({ spawn, credentials });
    const start = input();
    delete start.harness;
    await expect(adapter.start(start, recordingHost().host)).rejects.toThrow(/harness/i);
    expect(spawn).not.toHaveBeenCalled();
    expect(credentials).not.toHaveBeenCalled();
  });

  it('records and permits the real context for each request and retry', async () => {
    const run = runtime([
      fauxAssistantMessage('', {
        stopReason: 'error',
        errorMessage: 'HTTP 503: The service is temporarily unavailable',
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

  it('authorizes final extension arguments, then starts and settles the unmanaged effect', async () => {
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

  it('a refused permit makes no provider request', async () => {
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

  it('cancellation between permit and dispatch never contacts the provider', async () => {
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

  it('validates arguments again after extension hooks, before host authorization', async () => {
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

  it('steers an in-flight execution and reports only directives in the actual request', async () => {
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

  it('nested model calls made by an extension use their own permits and observations', async () => {
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

  it('a required extension that fails to load fails without a model request or fallback', async () => {
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

  it('a denied native tool never starts', async () => {
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

  it('cancellation ends the SDK execution and fences a late answer', async () => {
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

it('a steer absorbed by reprepare does not trigger an extra SDK turn', async () => {
  const entered = new Gate(),
    release = new Gate();
  const directive = { directiveId: 'during_prepare', text: 'Include only the accepted scope.' };
  let prepares = 0,
    requests = 0;
  const contexts: string[] = [];
  const response = (context: { messages: unknown[] }) => {
    requests++;
    contexts.push(JSON.stringify(context.messages));
    return fauxAssistantMessage('Final answer.');
  };
  const run = runtime([response, response], '', {
    pendingDirectives: () => (prepares ? [directive] : []),
    prepareModelRequest: async () => {
      if (++prepares === 1) {
        entered.open();
        await release.wait();
        throw new Error('REASONING_STALE');
      }
      return {
        modelCallId: `call_${prepares}`,
        contextSnapshotId: `context_${prepares}`,
        profile: 'model-a',
        maxOutputTokens: 256,
        directives: [directive],
      };
    },
  });
  const handle = await run.adapter.start(run.input, run.host);
  await entered.wait();
  handle.pushDirective?.(directive);
  await Promise.resolve();
  release.open();
  await handle.waitForSettlement();
  expect(contexts[0]?.split(directive.text)).toHaveLength(2);
  expect(requests).toBe(1);
});

it('the SDK exposes the same user question schema and resumes only after its host answer', async () => {
  const asked = new Gate(),
    answered = new Gate();
  let name = '';
  const run = runtime(
    [
      fauxAssistantMessage(
        [
          fauxToolCall('ask_user', {
            key: 'format',
            questions: [{ id: 'format', kind: 'text', prompt: 'Choose format' }],
          }),
        ],
        { stopReason: 'toolUse' },
      ),
      (context) => {
        expect(JSON.stringify(context.messages)).toContain('A table');
        return fauxAssistantMessage('Done');
      },
    ],
    '',
    {
      authorizeTool: async (proposal) => {
        name = proposal.name;
        return { ok: true, toolCallId: 'tool_question' };
      },
      executeTool: async (toolCallId) => {
        asked.open();
        await answered.wait();
        return {
          ok: true,
          toolCallId,
          result: { status: 'answered', answers: [{ questionId: 'format', text: 'A table' }] },
        };
      },
    },
  );
  run.input.role.allowedCollaborationTools.push('ask_user');
  run.input.harness!.allowedTools.push('ask_user');
  const handle = await run.adapter.start(run.input, run.host);
  await asked.wait();
  expect(name).toBe('ask_user');
  expect(run.requests).toHaveLength(1);
  answered.open();
  expect(await handle.waitForSettlement()).toMatchObject({ outcome: 'succeeded' });
  expect(run.requests).toHaveLength(2);
});

it('context hooks cannot replace the protected Corral role and output contract', async () => {
  let seen = '';
  const run = runtime(
    [
      (context) => {
        seen = JSON.stringify(context.messages);
        return fauxAssistantMessage('Done');
      },
    ],
    `export default pi => pi.on('context_with_system', event => ({messages:event.messages.map(message=>message.role==='system'?{...message,content:'Replacement prompt',sections:{}}:message)}));`,
  );
  await (await run.adapter.start(run.input, run.host)).waitForSettlement();
  expect(seen).toContain(run.input.role.prompt);
  expect(seen).toContain('submit_result');
  expect(run.requests[0]).toMatchObject({
    sections: expect.arrayContaining([
      expect.objectContaining({ name: 'corral_safety', source: 'corral', version: 1 }),
    ]),
  });
});

it('core worker applies context policy and old IPC versions are rejected', async () => {
  const faux = createFauxCore({});
  faux.setResponses([fauxAssistantMessage('Done.')]);
  const catalog = faux.getModel();
  const before = catalog.contextWindow;
  const start = input();
  delete start.harness;
  delete start.role.harness;
  start.model.contextPolicy = resolveProfileContext(
    { contextWindow: 64000, compaction: { reserveTokens: 0, keepRecentTokens: 0 } },
    { contextWindow: before, source: 'catalog' },
    'fixture',
    256,
  ).policy!;
  const seen: number[] = [];
  let frame: unknown;
  const adapter = new PiAgentAdapter({
    credentials: async () => ACCESS_TOKEN,
    spawn: () => {
      const pair = memoryChannelPair();
      pair.worker.onFrame((value) => {
        if ((value as { type: string }).type === 'start') frame = value;
      });
      runWorker(pair.worker, {
        resolveModel: () => catalog,
        streamFn: (model, context, options) => {
          seen.push(model.contextWindow);
          return faux.streamSimple(model, context, options);
        },
      });
      return pair.host;
    },
  });
  const { host } = recordingHost();
  expect(await (await adapter.start(start, host)).waitForSettlement()).toMatchObject({
    outcome: 'succeeded',
  });
  expect(seen).toEqual([64000]);
  expect(catalog.contextWindow).toBe(before);
  expect(frame).toMatchObject({
    protocolVersion: LEGACY_PROTOCOL_VERSION,
    model: { contextWindow: 64000 },
  });
  expect(frame).toHaveProperty('compaction', { reserveTokens: 0, keepRecentTokens: 0 });
  expect(StartFrame.safeParse({ ...(frame as object), protocolVersion: 3 }).success).toBe(false);
  expect(SdkStartFrame.safeParse({ ...(frame as object), protocolVersion: 4 }).success).toBe(false);
  expect(PROTOCOL_VERSION).not.toBe(LEGACY_PROTOCOL_VERSION);
});

it('compaction preserves the summary without reinserting the original large input', async () => {
  const original = 'ORIGINAL_ATTACHMENT_AUDIT '.repeat(3500);
  let summaries = 0;
  const seen: { purpose: string; original: boolean; chars: number; summary: boolean }[] = [];
  const responses: FauxResponseStep[] = Array.from({ length: 20 }, () => (context) => {
    const serialized = JSON.stringify(context.messages);
    seen.push({
      purpose: (run.requests.at(-1) as { purpose: string }).purpose,
      original: serialized.includes(original),
      chars: serialized.length,
      summary: serialized.includes('AUDIT_SHORT_SUMMARY'),
    });
    return fauxAssistantMessage(
      (run.requests.at(-1) as { purpose: string }).purpose === 'compaction'
        ? `AUDIT_SHORT_SUMMARY_${++summaries}`
        : 'REGULAR_ANSWER',
    );
  });
  const run = runtime(
    responses,
    `export default pi => { let round=0; pi.on('agent_before_settle', ()=>{ if(round<4) pi.sendUserMessage(round++<3?'LATER_MESSAGE_AUDIT '.repeat(5000):'Continue briefly.',{deliverAs:'followUp'}); }); };`,
    {},
    undefined,
    128000,
  );
  run.input.inputs[0]!.text = original;
  run.input.model.contextPolicy = resolveProfileContext(
    { contextWindow: 65536, compaction: { reserveTokens: 16384, keepRecentTokens: 0 } },
    { contextWindow: 128000, source: 'catalog' },
    'audit',
    256,
  ).policy!;
  const settled = await (await run.adapter.start(run.input, run.host)).waitForSettlement();
  expect(settled, JSON.stringify({ seen, reports: run.reports })).toMatchObject({
    outcome: 'succeeded',
  });
  const first = seen.findIndex((r) => r.purpose === 'compaction');
  expect(first).toBeGreaterThanOrEqual(0);
  const next = seen.slice(first + 1).find((r) => r.purpose === 'turn');
  expect(next?.original).toBe(false);
  expect(next?.summary).toBe(true);
  expect(seen.filter((r) => r.purpose === 'compaction')).toHaveLength(2);
  expect(seen.filter((r) => r.purpose === 'compaction')[1]?.summary).toBe(true);
});

it.each([false, true])(
  'Core manual compaction applies only the current revision (changed=%s)',
  async (changed) => {
    const gate = new Gate();
    const started = new Gate();
    const start = input();
    delete start.harness;
    delete start.role.harness;
    start.inputs[0]!.text = 'ORIGINAL_FIRST_PROMPT '.repeat(1000);
    const image =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZxkAAAAASUVORK5CYII=';
    start.images = [
      {
        kind: 'image_attachment',
        imageId: 'image_core',
        name: 'pixel.png',
        mime: 'image/png',
        bytes: Buffer.from(image, 'base64').length,
        sha256: createHash('sha256').update(Buffer.from(image, 'base64')).digest('hex'),
        width: 1,
        height: 1,
        data: image,
      },
    ];
    start.model.contextPolicy = resolveProfileContext(
      { contextWindow: 64000, compaction: { reserveTokens: 0, keepRecentTokens: 0 } },
      { contextWindow: 64000, source: 'catalog' },
      'fixture',
      256,
    ).policy!;
    const faux = createFauxCore({});
    let currentState = 'CURRENT_REQUIRED_STATE';
    const reports: { phase: string }[] = [];
    const checkpoints: unknown[] = [];
    const failures: unknown[] = [];
    const seen: string[] = [];
    faux.setResponses([
      async () => {
        started.open();
        await gate.wait();
        return fauxAssistantMessage([fauxToolCall('write_artifact', { text: 'Draft' })], {
          stopReason: 'toolUse',
        });
      },
      {
        ...fauxAssistantMessage(''),
        stopReason: 'error',
        errorMessage: JSON.stringify({
          code: 'RATE_LIMIT',
          status: 429,
          retryAfterMs: 0,
          requestId: null,
        }),
      },
      () => {
        if (changed) currentState = 'CHANGED_REQUIRED_STATE';
        return fauxAssistantMessage(
          'Current goal and remaining work, with the existing evidence references.',
        );
      },
      (context) => {
        seen.push(JSON.stringify(context));
        return fauxAssistantMessage('Done.');
      },
    ]);
    const adapter = new PiAgentAdapter({
      credentials: async () => ACCESS_TOKEN,
      spawn: () => {
        const pair = memoryChannelPair();
        pair.host.onFrame((value) => {
          if ((value as { type?: string }).type === 'settled') failures.push(value);
        });
        runWorker(pair.worker, {
          resolveModel: () => faux.getModel(),
          streamFn: faux.streamSimple,
        });
        return pair.host;
      },
    });
    const { host } = recordingHost({
      checkpointContext: async (value) => {
        checkpoints.push(value);
        return null;
      },
      protectedContext: () => ({
        version: 1,
        text: currentState,
        hash: createHash('sha256').update(canonicalJson(currentState)).digest('hex'),
      }),
      reportCompaction: async (report) => {
        reports.push(report);
      },
    });
    const handle = await adapter.start(start, host);
    await started.wait();
    const supported = typeof handle.requestCompaction === 'function';
    handle.requestCompaction?.('manual_core');
    gate.open();
    const outcome = await handle.waitForSettlement();
    expect(supported).toBe(true);
    expect(outcome.error, JSON.stringify({ reports, failures })).toBeUndefined();
    expect(outcome.outcome).toBe('succeeded');
    expect(reports.map((report) => report.phase)).toEqual([
      'started',
      changed ? 'failed' : 'completed',
    ]);
    expect(seen[0]?.includes('compacted-summary')).toBe(!changed);
    expect(seen[0]?.includes('ORIGINAL_FIRST_PROMPT')).toBe(changed);
    expect(seen[0]).toContain(image);
    expect(seen[0]).toContain(currentState);
    expect(JSON.stringify(checkpoints.at(-1))).toContain('Done.');
  },
);

it('SDK compacts an oversized first user message before its first task request', async () => {
  const original = 'ORIGINAL_FIRST_MESSAGE '.repeat(4200);
  const seen: { purpose: string; original: boolean; summary: boolean }[] = [];
  const responses: FauxResponseStep[] = Array.from({ length: 6 }, () => (context) => {
    const text = JSON.stringify(context.messages);
    const purpose = (run.requests.at(-1) as { purpose: string }).purpose;
    seen.push({
      purpose,
      original: text.includes(original),
      summary: text.includes('FIRST_SUMMARY'),
    });
    return fauxAssistantMessage(
      purpose === 'compaction'
        ? 'FIRST_SUMMARY preserve required task identifiers.'
        : 'Task answer.',
    );
  });
  const run = runtime(
    responses,
    `export default pi=>{let sent=false;pi.on('agent_before_settle',()=>{if(!sent){sent=true;pi.sendUserMessage('Continue briefly.',{deliverAs:'followUp'});}});};`,
    {},
    undefined,
    32768,
  );
  run.input.inputs[0]!.text = original;
  run.input.model.contextPolicy = resolveProfileContext(
    { contextWindow: 32768 },
    { contextWindow: 32768, source: 'catalog' },
    'first-message',
    256,
  ).policy!;
  await (await run.adapter.start(run.input, run.host)).waitForSettlement();
  expect(seen[0]).toMatchObject({ purpose: 'compaction', original: true });
  expect(seen.filter((r) => r.purpose === 'turn').length).toBeGreaterThan(0);
  expect(seen.filter((r) => r.purpose === 'turn').every((r) => !r.original && r.summary)).toBe(
    true,
  );
});

it.each([true, false])(
  'SDK provider overflow uses one validated Corral compaction (valid=%s)',
  async (valid) => {
    const seen: string[] = [];
    const responses: FauxResponseStep[] = Array.from({ length: 5 }, () => () => {
      const purpose = (run.requests.at(-1) as { purpose: string }).purpose;
      seen.push(purpose);
      if (seen.length === 1)
        return {
          ...fauxAssistantMessage(''),
          stopReason: 'error',
          errorMessage: JSON.stringify({
            code: 'CONTEXT_OVERFLOW',
            status: 400,
            retryAfterMs: null,
            requestId: null,
          }),
        };
      if (purpose === 'compaction')
        return {
          ...fauxAssistantMessage('OVERFLOW_SUMMARY required goal.'),
          ...(!valid ? { stopReason: 'length' as const } : {}),
        };
      return fauxAssistantMessage('Completed synthetic answer.');
    });
    const run = runtime(responses);
    run.input.inputs[0]!.text = 'Reference context. '.repeat(1000);
    await (await run.adapter.start(run.input, run.host)).waitForSettlement();
    expect(seen).toEqual(valid ? ['turn', 'compaction', 'retry'] : ['turn', 'compaction']);
  },
);

it('explicitly selecting an already mandatory skill does not inject its body twice', async () => {
  let text = '';
  const body = 'MANDATORY_SOURCE_BODY_73';
  const run = runtime(
    [
      (context) => {
        text = JSON.stringify(context.messages);
        return fauxAssistantMessage('Done.');
      },
    ],
    '',
    {},
    { text: body, mode: 'mandatory', brief: '/skill:writing Summarize simply.' },
  );
  await (await run.adapter.start(run.input, run.host)).waitForSettlement();
  expect(text.split(body)).toHaveLength(2);
  expect(text).toContain('Summarize simply.');
});
