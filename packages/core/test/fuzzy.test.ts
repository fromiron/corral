import { describe, expect, it } from 'vitest';
import { fuzzyScore, rankFuzzy } from '../src/fuzzy.ts';

// one ranking for `@` references, server path search and the command palette.

describe('fuzzy match', () => {
  it('matches letters in order, in any case, and refuses anything else', () => {
    expect(fuzzyScore('rdm', 'README.md')).not.toBeNull();
    expect(fuzzyScore('RDM', 'readme.md')).not.toBeNull();
    expect(fuzzyScore('mdr', 'README.md')).toBeNull();
    expect(fuzzyScore('x', 'README.md')).toBeNull();
  });

  it('accepts an empty query for everything with the same score', () => {
    expect(fuzzyScore('', 'a')).toBe(fuzzyScore('', 'src/deep/path.ts'));
  });

  it('prefers the file name over the folders above it', () => {
    const ranked = rankFuzzy(
      'session',
      ['src/session/util.ts', 'src/pages/SessionPage.tsx'],
      (x) => x,
    );
    expect(ranked[0]).toBe('src/pages/SessionPage.tsx');
  });

  it('prefers a run of letters and a word start over scattered letters', () => {
    const ranked = rankFuzzy('page', ['src/p/a/g/e.ts', 'src/SessionPage.tsx'], (x) => x);
    expect(ranked[0]).toBe('src/SessionPage.tsx');
  });

  it('prefers shorter paths when the matches are otherwise equal', () => {
    const ranked = rankFuzzy('app', ['apps/server/src/app.ts', 'src/app.ts'], (x) => x);
    expect(ranked[0]).toBe('src/app.ts');
  });

  it('matches several words separately, each in order', () => {
    expect(fuzzyScore('server app', 'apps/server/src/app.ts')).not.toBeNull();
    expect(fuzzyScore('server zzz', 'apps/server/src/app.ts')).toBeNull();
  });

  it('keeps the input order for ties and limits the result', () => {
    expect(rankFuzzy('', ['b', 'a', 'c'], (x) => x, 2)).toEqual(['b', 'a']);
  });
});
