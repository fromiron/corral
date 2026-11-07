import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import seedSchema from '../../../contracts/corral-definition.schema.json' with { type: 'json' };
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import {
  CorralDefinition,
  CorralDefinitionDraft,
  HarnessOverrides,
  RoleRunOverrides,
} from '../src/index.ts';
import { generateJsonSchemas } from '../src/json-schema.ts';
import { manyNodeDefinition } from './fixtures/many-nodes.ts';
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
  it('accepts more than 64 connected nodes with unique roles in current schemas', () => {
    const definition = manyNodeDefinition();
    expect(definition.nodes).toHaveLength(66);
    expect(definition.roles).toHaveLength(65);
    expect(definition.controlEdges).toHaveLength(65);
    expect(CorralDefinition.safeParse(definition).success).toBe(true);
    expect(CorralDefinitionDraft.safeParse(definition).success).toBe(true);
    const current = new Ajv2020({ allErrors: true, strict: false }).compile(
      generateJsonSchemas()['corral-definition.schema.json'],
    );
    expect(current(definition)).toBe(true);
  });

  it('keeps item content and execution limits when a definition has many nodes', () => {
    const definition = manyNodeDefinition();
    const role = definition.roles[0];
    if (!role) throw new Error('Missing fixture role.');
    const cases = [
      { ...definition, roles: [{ ...role, prompt: '' }, ...definition.roles.slice(1)] },
      { ...definition, limits: { ...definition.limits, maxDelegationDepth: 3 } },
    ];
    for (const candidate of cases) {
      expect(CorralDefinition.safeParse(candidate).success).toBe(false);
      expect(CorralDefinitionDraft.safeParse(candidate).success).toBe(false);
    }
  });

  it('accepts settings for every authored role without weakening each setting', () => {
    const roles = manyNodeDefinition().roles;
    const harness = Object.fromEntries(
      roles.map((role) => [role.id, { profileId: 'local', revision: 1 }]),
    );
    const models = Object.fromEntries(roles.map((role) => [role.id, { modelProfile: 'model-a' }]));
    expect(HarnessOverrides.safeParse(harness).success).toBe(true);
    expect(RoleRunOverrides.safeParse(models).success).toBe(true);
    expect(
      HarnessOverrides.safeParse({ ...harness, role_0: { profileId: 'local', revision: 0 } })
        .success,
    ).toBe(false);
    expect(RoleRunOverrides.safeParse({ ...models, role_0: {} }).success).toBe(false);
  });

  it('rejects canvas coordinates mixed into the execution definition', () => {
    const result = CorralDefinition.safeParse(invalid[1]?.[1]);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('nodes.0');
  });
});
