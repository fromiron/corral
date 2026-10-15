import type {
  AgentHost,
  AgentObservation,
  AgentStartInput,
  RequestPermit,
  TextDelta,
  ToolAuthorization,
  ToolOutcome,
  ToolProposal,
} from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { Gate, ScriptedAgentAdapter } from '../src/index.ts';

const input: AgentStartInput = {
  runId: 'run_0001',
  executionId: 'exec_0001',
  taskId: 'task_0001',
  nodeId: 'writer',
  attemptNo: 1,
  modelProfile: 'model-a',
  mode: 'mock',
  model: { profile: 'model-a', provider: null, modelId: null, auth: 'mock' },
  depth: 0,
  round: null,
  criteriaVersionId: 'crit_0001',
  assignment: { kind: 'scheduled' },
  capabilities: { delegateTo: [], askTo: [] },
  role: {
    id: 'writer_role',
    name: 'Writer',
    prompt: 'Write.',
    modelProfile: 'model-a',
    allowedWorkTools: ['write_artifact'],
    allowedCollaborationTools: ['submit_result'],
    outputContract: 'text',
  },
  inputs: [{ name: 'notes', kind: 'task_output', artifactVersionId: 'artv_0001', text: 'Notes.' }],
};

class RecordingHost implements AgentHost {
  calls: string[] = [];
  permits: RequestPermit[] = [];
  observations: AgentObservation[] = [];
  directivesPerRequest: { directiveId: string; text: string }[][] = [];
  denyTool: string | null = null;
  private n = 0;

  async prepareModelRequest(): Promise<RequestPermit> {
    this.n += 1;
    this.calls.push('prepare');
    const permit: RequestPermit = {
      modelCallId: `call_000${this.n}`,
      contextSnapshotId: `ctx_000${this.n}`,
      profile: 'model-a',
      maxOutputTokens: 4096,
      directives: this.directivesPerRequest[this.n - 1] ?? [],
    };
    this.permits.push(permit);
    return permit;
  }

  async invokeTool(proposal: ToolProposal): Promise<ToolOutcome> {
    this.calls.push(`tool:${proposal.name}`);
    if (proposal.name === this.denyTool) {
      return { ok: false, toolCallId: 'tc_1', error: { code: 'CAPABILITY_DENIED', message: 'no' } };
    }
    if (proposal.name === 'write_artifact') {
      return { ok: true, toolCallId: 'tc_1', result: { artifactVersionId: 'artv_0009' } };
    }
    return { ok: true, toolCallId: 'tc_2', result: {} };
  }

  async authorizeTool(proposal: ToolProposal): Promise<ToolAuthorization> {
    this.calls.push(`authorize:${proposal.name}`);
    return { ok: true, toolCallId: 'tc_1' };
  }

  async executeTool(toolCallId: string): Promise<ToolOutcome> {
    this.calls.push(`execute:${toolCallId}`);
    return { ok: true, toolCallId, result: {} };
  }

  async observe(observation: AgentObservation): Promise<void> {
    this.calls.push('observe');
    this.observations.push(observation);
  }

  streamText(delta: TextDelta): void {
    this.calls.push(`stream:${delta.chunkIndex}`);
  }
}

describe('ScriptedAgentAdapter', () => {
  it('runs each turn through the host, then writes and submits the final text', async () => {
    const host = new RecordingHost();
    const handle = await new ScriptedAgentAdapter({ turns: 2 }).start(input, host);
    await expect(handle.waitForSettlement()).resolves.toEqual({ outcome: 'succeeded' });
    expect(host.calls).toEqual([
      'prepare',
      'stream:0',
      'stream:1',
      'stream:2',
      'observe',
      'prepare',
      'stream:0',
      'stream:1',
      'stream:2',
      'observe',
      'tool:write_artifact',
      'tool:submit_result',
    ]);
  });

  it('reflects the delivered directives and input versions in its reply', async () => {
    const host = new RecordingHost();
    host.directivesPerRequest = [[], [{ directiveId: 'dir_0001', text: 'Primary sources only.' }]];
    const handle = await new ScriptedAgentAdapter({ turns: 2 }).start(input, host);
    await handle.waitForSettlement();
    const [first, second] = host.observations;
    expect(first?.text).toContain('artv_0001');
    expect(first?.text).not.toContain('dir_0001');
    expect(second?.text).toContain('dir_0001');
    expect(second?.text).toContain('Primary sources only.');
  });

  it('stops at the next step after cancel and settles as cancelled', async () => {
    const host = new RecordingHost();
    const gate = new Gate();
    const handle = await new ScriptedAgentAdapter({
      turns: 2,
      beforeReply: () => gate.wait(),
    }).start(input, host);
    while (gate.waiting === 0) await Promise.resolve();
    await handle.cancel('user cancelled');
    gate.open();
    await expect(handle.waitForSettlement()).resolves.toEqual({ outcome: 'cancelled' });
    expect(host.calls).toEqual(['prepare']);
  });

  it('settles as failed when the host refuses a tool', async () => {
    const host = new RecordingHost();
    host.denyTool = 'write_artifact';
    const handle = await new ScriptedAgentAdapter({ turns: 1 }).start(input, host);
    const settlement = await handle.waitForSettlement();
    expect(settlement.outcome).toBe('failed');
    expect(settlement.error).toContain('CAPABILITY_DENIED');
  });
});
