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
      'c88cafe442e7c85ce8ea54b627f728efbd96d8672009ca3ab6f7b1f9ba0150c1',
    );
    // The example before its reviewer took the criteria input (#20), frozen.
    expect(definitionHash(parse(researchTeamBefore))).toBe(
      '6ffe5923ea40cc955dab1734111a052988e265b6fde0b2e443c145d708ea2f85',
    );
    expect(definitionHash(parse(researchTeam))).toBe(
      '0e28c765214ceb02f6b6f5165a865a35bb442a3ee483696a661e09c5d7729c97',
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
