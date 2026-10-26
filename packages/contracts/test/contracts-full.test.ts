import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { describe, expect, it } from 'vitest';
import commandSeed from '../../../contracts/command.schema.json' with { type: 'json' };
import definitionSeed from '../../../contracts/corral-definition.schema.json' with { type: 'json' };
import eventCatalog from '../../../contracts/event-catalog.json' with { type: 'json' };
import envelopeSeed from '../../../contracts/event-envelope.schema.json' with { type: 'json' };
import reviewSeed from '../../../contracts/review.schema.json' with { type: 'json' };
import commands from '../../../examples/commands.json' with { type: 'json' };
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import reviewPass from '../../../examples/review-pass.json' with { type: 'json' };
import reviewRevise from '../../../examples/review-revise.json' with { type: 'json' };
import generatedCommand from '../generated/command.schema.json' with { type: 'json' };
import generatedDefinition from '../generated/corral-definition.schema.json' with { type: 'json' };
import generatedReview from '../generated/review.schema.json' with { type: 'json' };
import generatedEvent from '../generated/run-event.schema.json' with { type: 'json' };
import {
  CorralDefinition,
  generateJsonSchemas,
  ReviewArtifact,
  RUN_EVENT_TYPES,
  RunCommand,
  RunEvent,
} from '../src/index.ts';
import minimal from './fixtures/minimal.corral.json' with { type: 'json' };

function compiler() {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats.default(ajv);
  return ajv;
}
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const mutate = (base: unknown, change: (doc: any) => void) => {
  const doc = clone(base) as any;
  change(doc);
  return doc;
};

/** Seed schema, generated schema and Zod must give the same verdict for every fixture. */
function expectParity(
  seed: object | null,
  generated: object,
  zod: { safeParse(v: unknown): { success: boolean } },
  cases: [string, unknown, boolean][],
) {
  const seedCheck = seed ? compiler().compile(seed) : null;
  const generatedCheck = compiler().compile(generated);
  for (const [name, doc, valid] of cases) {
    if (seedCheck) expect(seedCheck(doc), `seed: ${name}`).toBe(valid);
    expect(generatedCheck(doc), `generated: ${name}`).toBe(valid);
    expect(zod.safeParse(doc).success, `zod: ${name}`).toBe(valid);
  }
}

describe('command contract', () => {
  const patch = commands.find((c) => c.type === 'patch') as object;
  it('accepts every example command and rejects malformed ones in all three forms', () => {
    expectParity(commandSeed, generatedCommand, RunCommand, [
      ...commands.map((c): [string, unknown, boolean] => [c.commandId, c, true]),
      [
        'patch without expectedControlRevision',
        mutate(patch, (c) => delete c.expectedControlRevision),
        false,
      ],
      [
        'permission expansion through patch',
        mutate(patch, (c) => (c.payload.allowedTools = ['shell'])),
        false,
      ],
      [
        'node_future with nothing to change',
        mutate(patch, (c) => delete c.payload.modelProfile),
        false,
      ],
      [
        'run_limits with no changes',
        { ...clone(patch), payload: { kind: 'run_limits', changes: {} } },
        false,
      ],
      ['unknown command type', mutate(commands[0], (c) => (c.type = 'shell')), false],
      [
        'cancel with an unknown scope',
        mutate(commands[7], (c) => (c.payload.scope = { kind: 'node', nodeId: 'x' })),
        false,
      ],
      [
        'approval decision outside the enum',
        mutate(commands[8], (c) => (c.payload.decision = 'maybe')),
        false,
      ],
    ]);
  });
});

describe('review artifact contract', () => {
  it('a revise verdict without issues is not a valid review', () => {
    expectParity(reviewSeed, generatedReview, ReviewArtifact, [
      ['review-pass', reviewPass, true],
      ['review-revise', reviewRevise, true],
      ['revise without issues', mutate(reviewRevise, (r) => (r.issues = [])), false],
      ['unknown verdict', mutate(reviewPass, (r) => (r.verdict = 'approve')), false],
      ['extra field', mutate(reviewPass, (r) => (r.score = 10)), false],
    ]);
  });
});

describe('definition contract (generated schema)', () => {
  it('agrees with the seed schema and Zod', () => {
    expectParity(definitionSeed, generatedDefinition, CorralDefinition, [
      ['research team', researchTeam, true],
      ['minimal', minimal, true],
      ['unknown node type', mutate(minimal, (d) => (d.nodes[0].type = 'shell')), false],
      ['delegation depth 3', mutate(minimal, (d) => (d.limits.maxDelegationDepth = 3)), false],
    ]);
  });
});

describe('event contract', () => {
  it('defines a payload schema for exactly the event catalog', () => {
    const catalog = eventCatalog.map((e) => e.type).sort();
    expect([...RUN_EVENT_TYPES].sort()).toEqual(catalog);
  });

  it('every typed event is a valid seed envelope, and payloads are checked per type', () => {
    const envelope = compiler().compile(envelopeSeed);
    const generated = compiler().compile(generatedEvent);
    const base = {
      schemaVersion: '0.1',
      eventId: 'evt_0001',
      runId: 'run_0001',
      runSeq: 1,
      recordedAt: '2026-10-15T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'coordinator' },
      causedByEventIds: [],
    };
    const samples = [
      {
        type: 'run.interrupted',
        payload: { previousStatus: 'running', backendSessionId: 'proc_1' },
      },
      {
        type: 'cancel.requested',
        payload: {
          scope: { kind: 'execution', executionId: 'exec_1' },
          fenceSeq: 9,
          reason: 'user',
        },
      },
      {
        type: 'limit.reached',
        payload: { limitKind: 'model_calls', used: 40, reserved: 0, max: 40 },
      },
      {
        type: 'review.recorded',
        payload: {
          reviewVersionId: 'artv_2',
          targetVersionId: 'artv_1',
          criteriaVersionId: 'criteria_1',
          verdict: 'revise',
          issues: reviewRevise.issues,
        },
      },
    ];
    for (const sample of samples) {
      const event = { ...base, ...sample };
      expect(RunEvent.safeParse(event).success, sample.type).toBe(true);
      expect(envelope(event), sample.type).toBe(true);
      expect(generated(event), sample.type).toBe(true);
      const wrong = { ...event, payload: { ...event.payload, unexpected: true } };
      expect(RunEvent.safeParse(wrong).success, `${sample.type} extra field`).toBe(false);
      expect(generated(wrong), `${sample.type} extra field (generated)`).toBe(false);
    }
  });
});

describe('codegen', () => {
  it('generated JSON Schema files are up to date with the Zod source', () => {
    const fresh = generateJsonSchemas();
    expect(fresh['command.schema.json']).toEqual(generatedCommand);
    expect(fresh['corral-definition.schema.json']).toEqual(generatedDefinition);
    expect(fresh['run-event.schema.json']).toEqual(generatedEvent);
    expect(fresh['review.schema.json']).toEqual(generatedReview);
  });
});
