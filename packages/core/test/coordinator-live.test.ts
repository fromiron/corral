import type {
  AgentAdapter,
  AgentHandle,
  AgentHost,
  AgentStartInput,
  RunEvent,
  StreamFrame,
} from '@corral/contracts';
import {
  FakeClock,
  Gate,
  linearCorral,
  ScriptedAgentAdapter,
  SequentialIdFactory,
} from '@corral/testkit';
import { describe, expect, it } from 'vitest';
import {
  Coordinator,
  type CoordinatorDeps,
  InProcessTransport,
  type ModelResolver,
  type RunProjection,
  waitForProjection,
} from '../src/index.ts';

const settled = (p: RunProjection) => ['succeeded', 'failed', 'cancelled'].includes(p.status);

/** An agent driven step by step by the test through the host it was given. */
class ManualAgent implements AgentAdapter {
  host: AgentHost | null = null;
  input: AgentStartInput | null = null;
  private readonly done = new Gate();
  private outcome: 'succeeded' | 'failed' = 'succeeded';
  readonly started = new Gate();

  async start(input: AgentStartInput, host: AgentHost): Promise<AgentHandle> {
    this.input = input;
    this.host = host;
    this.started.open();
    return {
      cancel: async () => {},
      waitForSettlement: async () => {
        await this.done.wait();
        return { outcome: this.outcome };
      },
    };
  }

  finish(outcome: 'succeeded' | 'failed' = 'succeeded') {
    this.outcome = outcome;
    this.done.open();
  }
}

function setup(agents: AgentAdapter, extra: Partial<CoordinatorDeps> = {}) {
  const coordinator = new Coordinator({
    clock: new FakeClock(),
    ids: new SequentialIdFactory(),
    agents,
    ...extra,
  });
  return new InProcessTransport(coordinator);
}

async function runOnce(transport: InProcessTransport, mode: 'mock' | 'live' = 'mock') {
  return transport.startRun({
    schemaVersion: '0.1',
    commandId: 'cmd_start',
    definition: linearCorral(['writer']),
    mode,
  });
}

function collect(transport: InProcessTransport, runId: string) {
  const events: RunEvent[] = [];
  const frames: StreamFrame[] = [];
  transport.subscribe(runId, 0, {
    onEvent: (e) => events.push(e),
    onFrame: (f) => frames.push(f),
  });
  return { events, frames };
}

describe('tool authorization and execution', () => {
  it('a blocked tool never starts', async () => {
    const agent = new ManualAgent();
    const transport = setup(agent);
    const { runId } = await runOnce(transport);
    const { events } = collect(transport, runId ?? '');
    await agent.started.wait();
    const host = agent.host as AgentHost;

    const blocked = await host.authorizeTool({ name: 'shell_exec', args: { command: 'rm -rf /' } });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    const forced = await host.executeTool(blocked.toolCallId);
    expect(forced.ok).toBe(false);
    agent.finish('failed');
    await waitForProjection(transport, runId ?? '', settled);
    await Promise.resolve();

    const forTool = events.filter(
      (e) =>
        e.type.startsWith('tool.') &&
        (e.payload as { toolCallId?: string }).toolCallId === blocked.toolCallId,
    );
    expect(forTool.map((e) => e.type)).toEqual(['tool.requested', 'tool.blocked']);
  });

  it('an allowed tool is requested, allowed, started and finished, once', async () => {
    const agent = new ManualAgent();
    const transport = setup(agent);
    const { runId } = await runOnce(transport);
    const { events } = collect(transport, runId ?? '');
    await agent.started.wait();
    const host = agent.host as AgentHost;

    const allowed = await host.authorizeTool({ name: 'write_artifact', args: { text: 'Draft.' } });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    // Authorized but not yet run: nothing has started.
    await Promise.resolve();
    expect(events.some((e) => e.type === 'tool.started')).toBe(false);

    const result = await host.executeTool(allowed.toolCallId);
    expect(result.ok).toBe(true);
    const again = await host.executeTool(allowed.toolCallId);
    expect(again.ok).toBe(false);
    agent.finish('failed');
    await waitForProjection(transport, runId ?? '', settled);
    await Promise.resolve();

    const lifecycle = events
      .filter((e) => (e.payload as { toolCallId?: string }).toolCallId === allowed.toolCallId)
      .map((e) => e.type);
    expect(lifecycle).toEqual(['tool.requested', 'tool.allowed', 'tool.started', 'tool.finished']);
    expect(events.filter((e) => e.type === 'artifact.version_created')).toHaveLength(1);
  });
});

describe('text stream frames', () => {
  it('reaches live subscribers but is never stored as an event', async () => {
    const agent = new ManualAgent();
    const transport = setup(agent);
    const { runId } = await runOnce(transport);
    const live = collect(transport, runId ?? '');
    await agent.started.wait();
    const host = agent.host as AgentHost;
    const permit = await host.prepareModelRequest();
    host.streamText?.({ modelCallId: permit.modelCallId, chunkIndex: 0, text: 'Hel' });
    host.streamText?.({ modelCallId: permit.modelCallId, chunkIndex: 1, text: 'lo' });
    // A frame for a call this execution does not own is dropped.
    host.streamText?.({ modelCallId: 'call_foreign', chunkIndex: 0, text: 'x' });
    await Promise.resolve();
    expect(live.frames.map((f) => f.text)).toEqual(['Hel', 'lo']);
    expect(live.frames.every((f) => f.runId === runId)).toBe(true);

    const late = collect(transport, runId ?? '');
    agent.finish('failed');
    await waitForProjection(transport, runId ?? '', settled);
    await Promise.resolve();
    expect(late.frames).toEqual([]);
    expect(late.events.some((e) => JSON.stringify(e).includes('Hel'))).toBe(false);
  });
});

describe('model profiles per run mode', () => {
  it('later executions use the Run model snapshot, while explicit model patches pin their own resolution', async () => {
    for (const patch of [false, true]) {
      let modelId = 'initial';
      const entered = new Gate(),
        release = new Gate();
      const seen: AgentStartInput[] = [];
      const coordinator = new Coordinator({
        clock: new FakeClock(),
        ids: new SequentialIdFactory(),
        models: {
          resolve: (profile) => ({
            ok: true,
            snapshot: { profile, provider: 'openai', modelId, auth: 'api_key' },
          }),
        },
        agents: new ScriptedAgentAdapter({
          turns: 1,
          beforeReply: async (_turn, input) => {
            seen.push(input);
            if (input.nodeId === 'first') {
              entered.open();
              await release.wait();
            }
          },
        }),
      });
      const transport = new InProcessTransport(coordinator);
      const { runId } = coordinator.startRun({
        schemaVersion: '0.1',
        commandId: 'start',
        definition: linearCorral(['first', 'second']),
        mode: 'live',
      });
      if (!runId) throw new Error('run did not start');
      await entered.wait();
      modelId = 'at_patch';
      if (patch)
        expect(
          coordinator.submit({
            schemaVersion: '0.1',
            commandId: 'patch_model',
            runId,
            type: 'patch',
            expectedControlRevision: coordinator.getSnapshot(runId).projection.controlRevision,
            payload: { kind: 'node_future', nodeId: 'second', modelProfile: 'model-a' },
          }).status,
        ).toBe('applied');
      modelId = 'changed_after_snapshot';
      release.open();
      await waitForProjection(transport, runId, settled);
      expect(seen.find((input) => input.nodeId === 'second')?.model.modelId).toBe(
        patch ? 'at_patch' : 'initial',
      );
    }
  });
  const resolver: ModelResolver = {
    resolve: (profile, mode) =>
      mode === 'mock'
        ? { ok: true, snapshot: { profile, provider: null, modelId: null, auth: 'mock' } }
        : profile === 'model-a'
          ? {
              ok: true,
              snapshot: { profile, provider: 'openai', modelId: 'gpt-test', auth: 'oauth' },
            }
          : { ok: false, code: 'CAPABILITY_DENIED', reason: `sign in for ${profile}` },
  };

  it('refuses a live run when this runtime has no live models', async () => {
    const transport = setup(new ScriptedAgentAdapter({ turns: 1 }));
    const { runId, receipt } = await runOnce(transport, 'live');
    expect(runId).toBeNull();
    expect(receipt.error?.code).toBe('COMMAND_NOT_SUPPORTED');
  });

  it('pins the resolved model in run.started and hands it to the agent', async () => {
    const agent = new ManualAgent();
    const transport = setup(agent, { models: resolver });
    const { runId } = await runOnce(transport, 'live');
    const { events } = collect(transport, runId ?? '');
    await agent.started.wait();
    expect(agent.input?.mode).toBe('live');
    expect(agent.input?.model).toEqual({
      profile: 'model-a',
      provider: 'openai',
      modelId: 'gpt-test',
      auth: 'oauth',
    });
    agent.finish('failed');
    await waitForProjection(transport, runId ?? '', settled);
    await Promise.resolve();
    const started = events.find((e) => e.type === 'run.started');
    expect(started?.type === 'run.started' && started.payload.modelProfiles).toEqual([
      { profile: 'model-a', provider: 'openai', modelId: 'gpt-test', auth: 'oauth' },
    ]);
  });

  it('names the profile that cannot run live, and starts nothing', async () => {
    const definition = linearCorral(['writer']);
    for (const role of definition.roles) role.modelProfile = 'model-b';
    const agent = new ManualAgent();
    const transport = setup(agent, { models: resolver });
    const { runId, receipt } = await transport.startRun({
      schemaVersion: '0.1',
      commandId: 'cmd_b',
      definition,
      mode: 'live',
    });
    expect(runId).toBeNull();
    expect(receipt.error).toEqual({
      code: 'CAPABILITY_DENIED',
      message: 'model-b: sign in for model-b',
    });
    expect(agent.input).toBeNull();
  });
});
