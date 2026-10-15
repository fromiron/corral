import type { AgentStartInput, RequestPermit } from '@corral/contracts';
import { compileDefinition } from '@corral/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDemoReply } from './script.ts';
import { demoTemplate } from './templates.ts';

const HANGUL = /[ㄱ-ㆎ가-힣]/;

describe('demo templates', () => {
  it('[TC-DEV-005-H] the default research team compiles and shows delegation, a question, a review Loop and approval', () => {
    const template = demoTemplate(undefined);
    expect(template.id).toBe('research-team');
    const { definition, layout } = template;
    const compiled = compileDefinition(definition);
    expect(compiled.ok).toBe(true);
    expect(definition.capabilityLinks.map((l) => l.kind).sort()).toEqual([
      'delegate',
      'delegate',
      'question',
    ]);
    expect(definition.nodes.filter((n) => n.type === 'loop')).toHaveLength(1);
    expect(definition.nodes.some((n) => n.type === 'decision' && n.mode === 'approval')).toBe(true);
    expect(definition.nodes.some((n) => n.type === 'output' && n.requireApproval)).toBe(true);
    for (const node of definition.nodes) expect(layout.nodes[node.id]).toBeDefined();
    // The UI has one English locale, so the demo speaks it too.
    expect(JSON.stringify(definition)).not.toMatch(HANGUL);
  });

  it('[TC-DEV-005-H] the starter template keeps the single Agent → Output demo', () => {
    const { id, definition } = demoTemplate('starter');
    expect(id).toBe('starter');
    expect(definition.name).toBe('Demo Corral');
    expect(definition.nodes.map((n) => n.type)).toEqual(['agent', 'output']);
    expect(compileDefinition(definition).ok).toBe(true);
  });

  it('[TC-DEV-005-N] an unknown template name opens the default template', () => {
    expect(demoTemplate('bogus').id).toBe('research-team');
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

  it('[TC-DEV-005-H] say they are simulated and use the brief', () => {
    const text = demoReply(2, startInput('research'), permit(), []);
    expect(text).toMatch(/simulated/i);
    expect(text).toContain('Compare two tools.');
  });

  it('[TC-DEV-005-H] write collaboration results as prose, not raw tool notes', () => {
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

  it('[TC-DEV-005-H] a responder answers in its only request', () => {
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

  it('[TC-DEV-005-H] a revised draft answers the review it was given', () => {
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

  it('[TC-DEV-005-N] shows a directive from the request it was delivered in, and only for that execution', () => {
    const input = startInput('write', { round: 2, executionId: 'exec_0007' });
    const directive = { directiveId: 'dir_0001', text: 'Lead with the cost difference.' };
    expect(demoReply(1, input, permit(), [])).not.toContain(directive.text);
    expect(demoReply(2, input, permit([directive]), [])).toContain(directive.text);
    // Delivered once, it stays in that execution's context for later requests ...
    expect(demoReply(3, input, permit(), [])).toContain(directive.text);
    // ... but another execution of the same node never saw it.
    const other = startInput('write', { round: 1, executionId: 'exec_0004' });
    expect(demoReply(2, other, permit(), [])).not.toContain(directive.text);
  });
});
