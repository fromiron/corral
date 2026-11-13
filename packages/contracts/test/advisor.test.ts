import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  AgentRole,
  advisorReview,
  CorralDefinition,
  CorralNode,
  isWorkAgent,
  ObserverAgentNode,
  RunCommand,
  RunEvent,
} from '../src/index.ts';
import { generateJsonSchemas } from '../src/json-schema.ts';
import minimal from './fixtures/minimal.corral.json' with { type: 'json' };

// The advisor contract (docs/specs/features/advisor.md "계약", team-graph.md's Agent row,
// api-contract.md's `submit_advice` and `advice.*`).

const schemas = generateJsonSchemas();
const ajv = new Ajv2020({ allErrors: true, strict: false });
const definitionJson = ajv.compile(schemas['corral-definition.schema.json']);
const commandJson = ajv.compile(schemas['command.schema.json']);
const eventJson = ajv.compile(schemas['run-event.schema.json']);

const observer = {
  id: 'advisor',
  type: 'agent',
  label: 'Advisor',
  roleId: 'writer_role',
  invocation: 'observer',
  outputName: 'notes',
};

const withAdvisor = (node: Record<string, unknown>) => ({
  ...minimal,
  nodes: [...minimal.nodes, node],
  capabilityLinks: [
    { id: 'watch', kind: 'advise', sourceNodeId: 'advisor', targetNodeId: 'writer' },
  ],
});

describe('advisor nodes', () => {
  it('an advisor without review settings reviews every 3 requests, at most 8 per review', () => {
    const node = ObserverAgentNode.parse(observer);
    expect(node.review).toBeUndefined();
    expect(advisorReview(node)).toEqual({ interval: 3, maxRequestsPerReview: 8 });
    expect(advisorReview({ ...node, review: { interval: 5, maxRequestsPerReview: 2 } })).toEqual({
      interval: 5,
      maxRequestsPerReview: 2,
    });
  });

  it('a definition with an advisor and an advise link round-trips', () => {
    const doc = withAdvisor({ ...observer, review: { interval: 1, maxRequestsPerReview: 1 } });
    const parsed = CorralDefinition.parse(doc);
    expect(parsed).toEqual(doc);
    expect(definitionJson(doc)).toBe(true);
    expect(parsed.nodes.filter(isWorkAgent).map((n) => n.id)).toEqual(['writer']);
  });

  it.each([
    ['an interval of 0', { review: { interval: 0, maxRequestsPerReview: 8 } }],
    ['a request cap of 0', { review: { interval: 3, maxRequestsPerReview: 0 } }],
    ['a fractional interval', { review: { interval: 1.5, maxRequestsPerReview: 8 } }],
    ['input bindings', { inputBindings: [] }],
    ['a retry', { retry: { maxAttempts: 1 } }],
  ])('refuses an advisor with %s', (_name, change) => {
    const doc = withAdvisor({ ...observer, ...change });
    expect(CorralNode.safeParse({ ...observer, ...change }).success).toBe(false);
    expect(CorralDefinition.safeParse(doc).success).toBe(false);
    expect(definitionJson(doc)).toBe(false);
  });

  it.each(['scheduled', 'callable'])('refuses review settings on a %s Agent', (invocation) => {
    const node = {
      ...minimal.nodes[0],
      invocation,
      review: { interval: 3, maxRequestsPerReview: 8 },
    };
    expect(CorralNode.safeParse(node).success).toBe(false);
    const { review: _review, ...plain } = node;
    expect(CorralNode.safeParse(plain).success).toBe(true);
  });

  it('a role may hold the advise tool', () => {
    const role = {
      ...minimal.roles[0],
      allowedWorkTools: ['read_file'],
      allowedCollaborationTools: ['read_artifact', 'advise'],
    };
    expect(AgentRole.safeParse(role).success).toBe(true);
  });
});

describe('submit_advice', () => {
  const command = (note: string, severity = 'concern') => ({
    schemaVersion: '0.1',
    commandId: 'cmd_advice',
    runId: 'run_0001',
    type: 'submit_advice',
    payload: {
      observerExecutionId: 'exec_advisor',
      attemptNo: 1,
      targetExecutionId: 'exec_writer',
      severity,
      note,
    },
  });

  it.each(['nit', 'concern', 'blocker'])('round-trips a %s', (severity) => {
    const doc = command('Check the cited figure against the source.', severity);
    expect(RunCommand.parse(doc)).toEqual(doc);
    expect(commandJson(doc)).toBe(true);
  });

  it('takes a note of 1 to 1,000 characters', () => {
    for (const length of [1, 1000]) {
      expect(RunCommand.safeParse(command('a'.repeat(length))).success).toBe(true);
      expect(commandJson(command('a'.repeat(length)))).toBe(true);
    }
    for (const length of [0, 1001]) {
      expect(RunCommand.safeParse(command('a'.repeat(length))).success).toBe(false);
      expect(commandJson(command('a'.repeat(length)))).toBe(false);
    }
  });

  it('refuses another severity and a missing attempt', () => {
    expect(RunCommand.safeParse(command('Check it.', 'warning')).success).toBe(false);
    const doc = command('Check it.') as { payload: Record<string, unknown> };
    delete doc.payload.attemptNo;
    expect(RunCommand.safeParse(doc).success).toBe(false);
  });
});

describe('advice events', () => {
  const event = (type: string, payload: Record<string, unknown>) => ({
    schemaVersion: '0.1',
    eventId: 'evt_0001',
    runId: 'run_0001',
    runSeq: 7,
    recordedAt: '2026-10-15T00:00:00.000Z',
    type,
    actor: { kind: 'runtime', id: 'coordinator' },
    executionId: 'exec_advisor',
    commandId: 'cmd_advice',
    causedByEventIds: [],
    payload,
  });
  const ends = { observerExecutionId: 'exec_advisor', targetExecutionId: 'exec_writer' };

  it.each([
    ['next_request', 'concern', { directiveId: 'dir_0001' }],
    ['interrupt', 'blocker', { directiveId: 'dir_0001' }],
    ['preserve', 'concern', { note: 'The second source is a blog.' }],
  ])('round-trips an admitted advice delivered as %s', (delivery, severity, directive) => {
    const doc = event('advice.admitted', {
      adviceId: 'adv_0001',
      ...ends,
      severity,
      delivery,
      ...directive,
    });
    expect(RunEvent.parse(doc)).toEqual(doc);
    expect(eventJson(doc)).toBe(true);
  });

  it('a delivered advice names its directive; a preserved one carries its note instead', () => {
    // Both the zod contract and the published JSON Schema hold the rule.
    const admitted = (delivery: string, fields: Record<string, unknown>) => {
      const doc = event('advice.admitted', {
        adviceId: 'adv_0001',
        ...ends,
        severity: 'concern',
        delivery,
        ...fields,
      });
      const parsed = RunEvent.safeParse(doc).success;
      expect(eventJson(doc)).toBe(parsed);
      return parsed;
    };
    const note = 'The second source is a blog.';
    expect(admitted('next_request', {})).toBe(false);
    expect(admitted('next_request', { directiveId: 'dir_0001', note })).toBe(false);
    expect(admitted('preserve', { directiveId: 'dir_0001', note })).toBe(false);
    expect(admitted('preserve', {})).toBe(false);
    expect(admitted('preserve', { note: '' })).toBe(false);
    expect(admitted('preserve', { note: 'x'.repeat(1001) })).toBe(false);
    expect(admitted('preserve', { note })).toBe(true);
  });

  it.each(['noise', 'duplicate', 'over_budget', 'target_terminal'])(
    'round-trips an advice suppressed as %s',
    (reason) => {
      const doc = event('advice.suppressed', { ...ends, severity: 'nit', reason });
      expect(RunEvent.parse(doc)).toEqual(doc);
      expect(eventJson(doc)).toBe(true);
    },
  );

  it('a suppressed advice never carries its text', () => {
    const doc = event('advice.suppressed', {
      ...ends,
      severity: 'nit',
      reason: 'noise',
      note: 'LGTM',
    });
    expect(RunEvent.safeParse(doc).success).toBe(false);
    expect(eventJson(doc)).toBe(false);
  });

  it('directives still come only from the person or an advice', () => {
    const directive = (origin: string) =>
      RunEvent.safeParse(
        event('directive.accepted', {
          directiveId: 'dir_0001',
          targetExecutionId: 'exec_writer',
          text: 'Check the figure.',
          delivery: 'next_request',
          origin,
        }),
      ).success;
    expect(directive('advice')).toBe(true);
    expect(directive('system')).toBe(false);
  });
});
