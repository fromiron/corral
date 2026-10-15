import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../src/index.ts';

// RFC 8785 (JSON Canonicalization Scheme) behaviour that definitionHash relies on (ADR-015).
describe('canonicalJson', () => {
  it('sorts object keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: [3, { z: 1, a: 2 }], a: null })).toBe(
      '{"a":null,"b":[3,{"a":2,"z":1}]}',
    );
  });

  it('sorts keys by UTF-16 code units (RFC 8785 §3.2.3 example)', () => {
    const input = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    // Read keys from the text: Object.keys() would list integer-like keys first.
    const keys = [...canonicalJson(input).matchAll(/"((?:[^"\\]|\\.)*)":/g)].map(
      (match) => JSON.parse(`"${match[1]}"`) as string,
    );
    expect(keys).toEqual(['\r', '1', '\u0080', 'ö', '€', '😀', 'דּ']);
  });

  it('serializes numbers like ECMAScript (RFC 8785 §3.2.2.3)', () => {
    expect(canonicalJson([1e21, 1e-7, 0.000001, -0, 333333333.3333333, 4.5])).toBe(
      '[1e+21,1e-7,0.000001,0,333333333.3333333,4.5]',
    );
  });

  it('escapes strings like JSON.stringify and keeps non-ASCII text as is', () => {
    expect(canonicalJson({ text: '조사\n"quote" ' })).toBe('{"text":"조사\\n\\"quote\\" "}');
  });

  it.each([
    ['a Date', new Date(0)],
    ['a Map', new Map()],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['a function', () => 1],
    ['a bigint', 1n],
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalJson({ value })).toThrow(TypeError);
  });
});
