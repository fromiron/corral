import { type CorralDefinition, DEFAULT_LIMITS } from '@corral/contracts';
import { addNode, connect, emptyDraft } from '@corral/react';

// Demo templates (C-063). The default shows what the runtime is for: delegation, a question,
// a review Loop that revises once, and human approval (Spec §6). `starter` is the single
// Agent → Output Corral the demo opened with before.

export type DemoTemplateId = 'research-team' | 'starter';

export const DEMO_TEMPLATE_IDS: readonly DemoTemplateId[] = ['research-team', 'starter'];

export interface DemoTemplate {
  id: DemoTemplateId;
  definition: CorralDefinition;
  layout: {
    nodes: Record<string, { x: number; y: number; width?: number; height?: number }>;
    viewport: { x: number; y: number; zoom: number };
  };
}

/** The template a `?template=` value names; anything else opens the default team. */
export function demoTemplate(id: string | undefined): DemoTemplate {
  return id === 'starter' ? starter() : researchTeam();
}

function starter(): DemoTemplate {
  const agent = addNode(emptyDraft('public_demo', 'Demo Corral'), 'agent', { x: 80, y: 120 });
  const output = addNode(agent.draft, 'output', { x: 360, y: 120 });
  const connected = connect(output.draft, {
    source: agent.nodeId,
    sourcePort: 'out',
    target: output.nodeId,
    targetPort: 'in',
  });
  if (!connected.ok) throw new Error('Invalid demo fixture.');
  const { definition, layout, viewport } = connected.draft;
  return { id: 'starter', definition, layout: { nodes: layout, viewport } };
}

const rolePrompt = (duty: string) =>
  `${duty} Use only the task and inputs you were given, keep exact artifact versions and evidence references, and submit with submit_result. Do not hide tool failures or missing evidence.`;

/** examples/research-team.corral.json in English, without work tools the demo never calls. */
function researchTeam(): DemoTemplate {
  const definition: CorralDefinition = {
    schemaVersion: '0.1',
    id: 'public_demo_research_team',
    name: 'Research team',
    entryNodeId: 'research',
    input: {
      brief: "Compare SQLite and PostgreSQL for a small team's internal tool.",
      criteria: ['Name the source behind each main claim.', 'Cover both strengths and limits.'],
    },
    roles: [
      {
        id: 'researcher',
        name: 'Researcher',
        prompt: rolePrompt('Plan the research, split it between helpers and merge their notes.'),
        modelProfile: 'model-a',
        allowedWorkTools: ['write_artifact'],
        allowedCollaborationTools: [
          'spawn_subagents',
          'await_tasks',
          'read_artifact',
          'reply',
          'submit_result',
        ],
        outputContract: 'notes',
      },
      {
        id: 'helper',
        name: 'Research Helper',
        prompt: rolePrompt('Collect sources for the part of the brief you were handed.'),
        modelProfile: 'model-b',
        allowedWorkTools: ['write_artifact'],
        allowedCollaborationTools: ['read_artifact', 'submit_result'],
        outputContract: 'notes',
      },
      {
        id: 'writer',
        name: 'Writer',
        prompt: rolePrompt('Write the comparison from the research notes and any review.'),
        modelProfile: 'model-a',
        allowedWorkTools: ['write_artifact'],
        allowedCollaborationTools: ['ask', 'read_artifact', 'submit_result'],
        outputContract: 'draft',
      },
      {
        id: 'reviewer',
        name: 'Reviewer',
        prompt: rolePrompt('Review the exact draft you were given against the criteria.'),
        modelProfile: 'model-b',
        allowedWorkTools: ['write_artifact'],
        allowedCollaborationTools: ['read_artifact', 'submit_result'],
        outputContract: 'review',
      },
    ],
    nodes: [
      {
        id: 'research',
        type: 'agent',
        label: 'Research',
        roleId: 'researcher',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'notes',
      },
      {
        id: 'helper',
        type: 'agent',
        label: 'Research Helper',
        roleId: 'helper',
        invocation: 'callable',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'notes_part',
      },
      {
        id: 'respond',
        type: 'agent',
        label: 'Source Responder',
        roleId: 'researcher',
        invocation: 'callable',
        inputBindings: [{ kind: 'run_input', name: 'brief' }],
        outputName: 'answer_notes',
      },
      { id: 'review_loop', type: 'loop', label: 'Review loop', maxIterations: 2 },
      {
        id: 'write',
        type: 'agent',
        label: 'Writer',
        loopId: 'review_loop',
        roleId: 'writer',
        invocation: 'scheduled',
        inputBindings: [
          { kind: 'task_output', name: 'notes', sourceNodeId: 'research' },
          {
            kind: 'previous_iteration_output',
            name: 'draft',
            sourceNodeId: 'write',
            optional: true,
          },
          {
            kind: 'previous_iteration_output',
            name: 'review',
            sourceNodeId: 'review',
            optional: true,
          },
        ],
        outputName: 'draft',
      },
      {
        id: 'review',
        type: 'agent',
        label: 'Reviewer',
        loopId: 'review_loop',
        roleId: 'reviewer',
        invocation: 'scheduled',
        inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'write' }],
        outputName: 'review',
      },
      {
        id: 'review_decision',
        type: 'decision',
        label: 'Review decision',
        loopId: 'review_loop',
        mode: 'review',
        rule: 'review_verdict',
        inputBindings: [{ kind: 'task_output', name: 'review', sourceNodeId: 'review' }],
      },
      {
        id: 'approval',
        type: 'decision',
        label: 'Final approval',
        mode: 'approval',
        rule: 'human_approval',
        inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'write' }],
      },
      {
        id: 'output',
        type: 'output',
        label: 'Output',
        inputBindings: [{ kind: 'task_output', name: 'draft', sourceNodeId: 'write' }],
        requireApproval: true,
      },
    ],
    controlEdges: [
      {
        id: 'e1',
        source: 'research',
        sourcePort: 'out',
        target: 'review_loop',
        targetPort: 'enter',
      },
      { id: 'e2', source: 'review_loop', sourcePort: 'body', target: 'write', targetPort: 'in' },
      { id: 'e3', source: 'write', sourcePort: 'out', target: 'review', targetPort: 'in' },
      {
        id: 'e4',
        source: 'review',
        sourcePort: 'out',
        target: 'review_decision',
        targetPort: 'in',
      },
      {
        id: 'e5',
        source: 'review_decision',
        sourcePort: 'revise',
        target: 'review_loop',
        targetPort: 'repeat',
      },
      {
        id: 'e6',
        source: 'review_decision',
        sourcePort: 'pass',
        target: 'review_loop',
        targetPort: 'exit',
      },
      { id: 'e7', source: 'review_loop', sourcePort: 'next', target: 'approval', targetPort: 'in' },
      { id: 'e8', source: 'approval', sourcePort: 'approve', target: 'output', targetPort: 'in' },
    ],
    capabilityLinks: [
      { id: 'cap1', kind: 'delegate', sourceNodeId: 'research', targetNodeId: 'helper' },
      { id: 'cap2', kind: 'question', sourceNodeId: 'write', targetNodeId: 'respond' },
      { id: 'cap3', kind: 'delegate', sourceNodeId: 'respond', targetNodeId: 'helper' },
    ],
    limits: DEFAULT_LIMITS,
  };
  // Two rows so the whole team fits the demo canvas at 1280px: the scheduled flow on top,
  // callable helpers and the approval step below.
  return {
    id: 'research-team',
    definition,
    layout: {
      nodes: {
        research: { x: 20, y: 90 },
        review_loop: { x: 230, y: 20, width: 650, height: 210 },
        write: { x: 260, y: 90 },
        review: { x: 470, y: 90 },
        review_decision: { x: 680, y: 90 },
        helper: { x: 20, y: 320 },
        respond: { x: 260, y: 320 },
        approval: { x: 520, y: 320 },
        output: { x: 740, y: 320 },
      },
      viewport: { x: 16, y: 16, zoom: 0.75 },
    },
  };
}
