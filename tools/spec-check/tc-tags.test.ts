import { describe, expect, it } from 'vitest';
import { checkTcTags, extractTcTags } from './tc-tags.ts';

describe('extractTcTags', () => {
  it('finds requirement and race scenario tags in test titles', () => {
    const source = `
      it('[TC-CAN-002-H] layout move keeps hash', () => {});
      test('[TC-RACE-07] snapshot/subscribe handoff', () => {});
      it('[TC-REF-003-F] rejects a missing reference', () => {});
      it('[TC-REF-006-D] duplicate request uses its receipt', () => {});
      it('untagged helper test', () => {});
    `;
    expect(extractTcTags(source)).toEqual([
      'TC-CAN-002-H',
      'TC-RACE-07',
      'TC-REF-003-F',
      'TC-REF-006-D',
    ]);
  });

  it('ignores ID-like text that is not a bracketed tag', () => {
    expect(extractTcTags('// see TC-CAN-002-H for details')).toEqual([]);
  });
});

describe('checkTcTags', () => {
  const catalog = new Set(['TC-CAN-002-H', 'TC-RACE-07']);

  it('accepts tags that exist in the catalog and reports covered scenarios', () => {
    const result = checkTcTags(
      [
        { file: 'a.test.ts', tags: ['TC-CAN-002-H'] },
        { file: 'b.test.ts', tags: ['TC-CAN-002-H', 'TC-RACE-07'] },
      ],
      catalog,
    );
    expect(result.errors).toEqual([]);
    expect(result.covered).toEqual(['TC-CAN-002-H', 'TC-RACE-07']);
  });

  it('rejects a tag that is not in the test catalog', () => {
    const result = checkTcTags([{ file: 'a.test.ts', tags: ['TC-CAN-999-H'] }], catalog);
    expect(result.errors).toEqual(['a.test.ts: unknown test scenario TC-CAN-999-H']);
  });
});
