import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import seedSchema from '../../../contracts/corral-definition.schema.json' with { type: 'json' };
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import { CorralDefinition } from '../src/index.ts';
import minimal from './fixtures/minimal.corral.json' with { type: 'json' };

const seed = new Ajv2020({ allErrors: true, strict: false }).compile(seedSchema);

type Json = Record<string, unknown>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function mutate(base: Json, change: (doc: Json & { [k: string]: any }) => void): Json {
  const doc = clone(base) as Json & { [k: string]: any };
  change(doc);
  return doc;
}

const valid: [string, unknown][] = [
  ['examples/research-team.corral.json', researchTeam],
  ['minimal Agent→Output', minimal],
];

const invalid: [string, Json][] = [
  ['unknown node type', mutate(minimal, (d) => (d.nodes[0].type = 'shell'))],
  ['canvas coordinates inside the definition', mutate(minimal, (d) => (d.nodes[0].x = 120))],
  ['delegation depth 3', mutate(minimal, (d) => (d.limits.maxDelegationDepth = 3))],
  ['role without prompt', mutate(minimal, (d) => delete d.roles[0].prompt)],
  ['identifier starting with a digit', mutate(minimal, (d) => (d.entryNodeId = '1writer'))],
  ['unsupported schema version', mutate(minimal, (d) => (d.schemaVersion = '0.2'))],
  ['output without input binding', mutate(minimal, (d) => (d.nodes[1].inputBindings = []))],
  ['unknown top-level field', mutate(minimal, (d) => (d.layout = {}))],
  ['shell as a work tool', mutate(minimal, (d) => d.roles[0].allowedWorkTools.push('shell'))],
];

describe('CorralDefinition schema parity with the seed JSON Schema', () => {
  it.each(valid)('accepts %s in both', (_name, doc) => {
    expect(seed(doc)).toBe(true);
    expect(CorralDefinition.safeParse(doc).success).toBe(true);
  });

  it.each(invalid)('rejects %s in both', (_name, doc) => {
    expect(seed(doc)).toBe(false);
    expect(CorralDefinition.safeParse(doc).success).toBe(false);
  });
});

describe('CorralDefinition', () => {
  it('[TC-CAN-002-N] rejects canvas coordinates mixed into the execution definition', () => {
    const result = CorralDefinition.safeParse(invalid[1]?.[1]);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('nodes.0');
  });
});
