import { CorralDefinition } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import researchLayout from '../../../examples/research-team.layout.json' with { type: 'json' };
import minimal from '../../contracts/test/fixtures/minimal.corral.json' with { type: 'json' };
import { definitionHash } from '../src/index.ts';

const parse = (doc: unknown) => CorralDefinition.parse(doc);
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Same data with every object's keys inserted in reverse order. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).reverse();
    return Object.fromEntries(entries.map(([key, item]) => [key, reverseKeys(item)]));
  }
  return value;
}

describe('definitionHash', () => {
  it('matches an independent JCS + SHA-256 implementation (Python json, sorted keys)', () => {
    expect(definitionHash(parse(minimal))).toBe(
      'c88cafe442e7c85ce8ea54b627f728efbd96d8672009ca3ab6f7b1f9ba0150c1',
    );
    expect(definitionHash(parse(researchTeam))).toBe(
      'f205cf04c3656c2baede01ab6cbc2158830fa73a2a4a3e68f5f8f4eb515492b1',
    );
  });

  it('[TC-CAN-002-H] ignores key order and layout moves, but changes with the prompt', () => {
    const definition = parse(researchTeam);
    const reordered = parse(reverseKeys(definition));
    const layout = clone(researchLayout);
    const before = definitionHash(definition);
    layout.nodes.research.x += 240;
    layout.viewport.zoom = 1.25;

    expect(definitionHash(reordered)).toBe(before);
    expect(definitionHash(definition)).toBe(before);

    const edited = clone(definition);
    const role = edited.roles[0];
    if (!role) throw new Error('fixture has no role');
    role.prompt += ' Use primary sources only.';
    expect(definitionHash(edited)).not.toBe(before);
  });
});
