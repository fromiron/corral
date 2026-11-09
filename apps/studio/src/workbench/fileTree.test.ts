import { describe, expect, it } from 'vitest';
import { type FolderListing, needsListing, visibleRows } from './fileTree.ts';

const listing = (paths: string[], truncated = false): FolderListing => ({
  files: paths.map((path) => ({ path, bytes: 1 })),
  truncated,
});
const listings = (entries: [string, FolderListing][]) => new Map(entries);
const shape = (rows: ReturnType<typeof visibleRows>) =>
  rows.map((row) => `${'  '.repeat(row.level - 1)}${row.kind === 'folder' ? '/' : ''}${row.name}`);

describe('the folder tree built from the recursive file listing', () => {
  it('lists folders before files and shows only expanded folders’ children', () => {
    const loaded = listings([
      ['', listing(['b.txt', 'src/z.ts', 'src/a/b.ts', 'a.md', 'docs/x.md'])],
    ]);
    expect(shape(visibleRows(loaded, { expanded: new Set() }))).toEqual([
      '/docs',
      '/src',
      'a.md',
      'b.txt',
    ]);
    const rows = visibleRows(loaded, { expanded: new Set(['src']) });
    expect(shape(rows)).toEqual(['/docs', '/src', '  /a', '  z.ts', 'a.md', 'b.txt']);
    const z = rows.find((row) => row.path === 'src/z.ts');
    expect(z).toMatchObject({ level: 2, parent: 'src', posInSet: 2, setSize: 2 });
    expect(rows.find((row) => row.path === 'src')).toMatchObject({
      kind: 'folder',
      expanded: true,
      posInSet: 2,
      setSize: 4,
    });
  });

  it('a complete root listing needs no folder reads; a truncated one reads each folder once', () => {
    const complete = listings([['', listing(['src/a.ts'])]]);
    expect(needsListing('src', complete)).toBe(false);
    const truncated = listings([['', listing(['src/a.ts'], true)]]);
    expect(needsListing('src', truncated)).toBe(true);
    const read = new Map(truncated).set('src', listing(['src/a.ts', 'src/deep/b.ts']));
    expect(needsListing('src', read)).toBe(false);
    // A complete folder listing covers everything under it.
    expect(needsListing('src/deep', read)).toBe(false);
    const partial = new Map(truncated).set('src', listing(['src/a.ts', 'src/deep/b.ts'], true));
    expect(needsListing('src/deep', partial)).toBe(true);
  });

  it('marks a folder whose own listing hit the limit, and merges what it read', () => {
    const loaded = listings([
      ['', listing(['src/a.ts'], true)],
      ['src', listing(['src/a.ts', 'src/b.ts'], true)],
    ]);
    const rows = visibleRows(loaded, { expanded: new Set(['src']) });
    expect(rows.find((row) => row.path === 'src')?.truncated).toBe(true);
    expect(shape(rows)).toEqual(['/src', '  a.ts', '  b.ts']);
  });

  it('a filter shows matching files with their folders open, whatever was expanded', () => {
    const loaded = listings([['', listing(['README.md', 'other.txt', 'docs/readme-ko.md'])]]);
    const rows = visibleRows(loaded, { expanded: new Set(), query: 'readme' });
    expect(shape(rows)).toEqual(['/docs', '  readme-ko.md', 'README.md']);
    expect(rows[0]?.expanded).toBe(true);
    // A folder closed while filtering stays closed until the filter changes.
    expect(
      shape(
        visibleRows(loaded, { expanded: new Set(), query: 'readme', collapsed: new Set(['docs']) }),
      ),
    ).toEqual(['/docs', 'README.md']);
  });

  it('a results filter keeps only the given files, under their own folders', () => {
    const loaded = listings([
      ['', listing(['README.md', 'src/app.ts', 'src/gen/out.ts', 'notes.txt', 'docs/a.md'])],
    ]);
    const only = new Set(['src/gen/out.ts', 'notes.txt']);
    expect(shape(visibleRows(loaded, { expanded: new Set(['docs']), only }))).toEqual([
      '/src',
      '  /gen',
      '    out.ts',
      'notes.txt',
    ]);
    // A folder closed while filtering stays closed; a query narrows the same set further.
    expect(
      shape(visibleRows(loaded, { expanded: new Set(), only, collapsed: new Set(['src/gen']) })),
    ).toEqual(['/src', '  /gen', 'notes.txt']);
    expect(shape(visibleRows(loaded, { expanded: new Set(), only, query: 'out' }))).toEqual([
      '/src',
      '  /gen',
      '    out.ts',
    ]);
    expect(shape(visibleRows(loaded, { expanded: new Set(), only: new Set() }))).toEqual([]);
  });

  it('reports loading and failed folders so their rows can say so', () => {
    const loaded = listings([['', listing(['src/a.ts'], true)]]);
    const rows = visibleRows(loaded, {
      expanded: new Set(['src']),
      loading: new Set(['src']),
      failed: new Set(),
    });
    expect(rows[0]).toMatchObject({ path: 'src', loading: true, expanded: true });
  });
});
