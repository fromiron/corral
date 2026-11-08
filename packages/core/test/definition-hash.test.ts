import { CorralDefinition } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import researchTeam from '../../../examples/research-team.corral.json' with { type: 'json' };
import minimal from '../../contracts/test/fixtures/minimal.corral.json' with { type: 'json' };
import { definitionHash } from '../src/index.ts';
import researchTeamBefore from './fixtures/research-team.before-criteria-input.corral.json' with {
  type: 'json',
};

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
      '709e5d78a5a5fe8f1e6d5c41b1385bfd6b9f589d808425a432cfcc1367793bc9',
    );
    // The example before its reviewer took the criteria input (#20), frozen.
    expect(definitionHash(parse(researchTeamBefore))).toBe(
      'e791e6ee7d2f933ea17a78bbbec3ae96185da731b9c5b1fa5f7cb11b6e468d88',
    );
    expect(definitionHash(parse(researchTeam))).toBe(
      '5f825805d5d5e8e3c754d5b7fc66d829a0195739c12cdee61e70de9f3032a8d0',
    );
  });

  it('ignores key order, but changes with the prompt', () => {
    const definition = parse(researchTeam);
    const reordered = parse(reverseKeys(definition));
    const before = definitionHash(definition);

    expect(definitionHash(reordered)).toBe(before);
    expect(definitionHash(definition)).toBe(before);

    const edited = clone(definition);
    const role = edited.roles[0];
    if (!role) throw new Error('fixture has no role');
    role.prompt += ' Use primary sources only.';
    expect(definitionHash(edited)).not.toBe(before);
  });
});
