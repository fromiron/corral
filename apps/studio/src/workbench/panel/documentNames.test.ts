import { describe, expect, it } from 'vitest';
import { documentTabNames } from './documentNames.ts';

const copy = (path: string) => ({ kind: 'document' as const, source: 'copy' as const, path });
const original = (path: string) => ({
  kind: 'document' as const,
  source: 'original' as const,
  path,
});
const names = (...tabs: Parameters<typeof documentTabNames>[0]) => [
  ...documentTabNames(tabs).values(),
];

describe("a 문서 tab's name", () => {
  it('is the file name while no other 문서 tab has it', () => {
    expect(names(copy('src/a.ts'), copy('src/b.ts'))).toEqual(['a.ts', 'b.ts']);
  });

  it('adds the nearest parent folder that tells apart files of one name', () => {
    expect(names(copy('packages/api/src/index.ts'), copy('packages/web/src/index.ts'))).toEqual([
      'index.ts — api',
      'index.ts — web',
    ]);
    expect(names(copy('api/index.ts'), copy('web/index.ts'))).toEqual([
      'index.ts — api',
      'index.ts — web',
    ]);
  });

  it('takes the one folder that tells a file apart from every other of its name', () => {
    expect(names(copy('a/x/index.ts'), copy('b/x/index.ts'), copy('c/y/index.ts'))).toEqual([
      'index.ts — a',
      'index.ts — b',
      'index.ts — y',
    ]);
  });

  it('keeps a file at the root unmarked beside one in a folder', () => {
    expect(names(copy('index.ts'), copy('api/index.ts'))).toEqual(['index.ts', 'index.ts — api']);
  });

  it('leaves a copy and a source-folder file of one path the same name: the mark tells them apart (counterexample)', () => {
    expect(names(copy('README.md'), original('README.md'))).toEqual(['README.md', 'README.md']);
    expect(names(copy('api/README.md'), original('api/README.md'), copy('web/README.md'))).toEqual([
      'README.md — api',
      'README.md — api',
      'README.md — web',
    ]);
  });
});
