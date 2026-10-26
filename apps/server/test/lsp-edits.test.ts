import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { stageLspEdit } from '../src/files/lsp-edits.ts';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const position = (character: number) => ({ line: 0, character });
const edit = (start: number, end: number, newText: string) => ({
  range: { start: position(start), end: position(end) },
  newText,
});
const documents = new Map([
  [
    'file:///copy/a.ts',
    { path: 'a.ts', text: '\uFEFF😀old\r\nlast', sha256: sha256('\uFEFF😀old\r\nlast') },
  ],
  ['file:///copy/b.ts', { path: 'b.ts', text: 'old\n', sha256: sha256('old\n') }],
]);
const source = { uri: 'file:///copy/a.ts', version: 1 };
const read = async (uri: string) => {
  const document = documents.get(uri);
  if (!document) throw new Error('outside scope');
  return document;
};
it('stages all files without mutation and preserves BOM CRLF and UTF-16 boundaries', async () => {
  const result = await stageLspEdit(
    {
      documentChanges: [
        { textDocument: { uri: source.uri, version: 1 }, edits: [edit(3, 6, 'new')] },
        { textDocument: { uri: 'file:///copy/b.ts', version: null }, edits: [edit(0, 3, 'new')] },
      ],
    },
    source,
    read,
  );
  expect(result).toEqual([
    {
      path: 'a.ts',
      before: documents.get(source.uri)!.text,
      beforeHash: documents.get(source.uri)!.sha256,
      after: '\uFEFF😀new\r\nlast',
      afterHash: sha256('\uFEFF😀new\r\nlast'),
    },
    {
      path: 'b.ts',
      before: 'old\n',
      beforeHash: sha256('old\n'),
      after: 'new\n',
      afterHash: sha256('new\n'),
    },
  ]);
  expect(documents.get(source.uri)!.text).toBe('\uFEFF😀old\r\nlast');
});
it('preserves LSP insertion ordering at the same position', async () => {
  const result = await stageLspEdit(
    { changes: { 'file:///copy/b.ts': [edit(0, 0, 'one'), edit(0, 0, 'two')] } },
    source,
    read,
  );
  expect(result[0]?.after).toBe('onetwoold\n');
});
it.each([
  {
    documentChanges: [
      { textDocument: { uri: source.uri, version: 2 }, edits: [edit(3, 6, 'new')] },
    ],
  },
  {
    documentChanges: [
      { textDocument: { uri: 'file:///copy/b.ts', version: 1 }, edits: [edit(0, 3, 'new')] },
    ],
  },
  { changes: { [source.uri]: [edit(2, 3, 'broken surrogate')] } },
  { changes: { [source.uri]: [edit(3, 100, 'outside line')] } },
  { changes: { [source.uri]: [edit(3, 5, 'x'), edit(4, 6, 'y')] } },
  { changes: { 'file:///outside.ts': [edit(0, 0, 'x')] } },
  { documentChanges: [{ kind: 'create', uri: 'file:///copy/new.ts' }] },
  { changes: { [source.uri]: [edit(3, 6, 'new')] }, documentChanges: [] },
  {
    changes: { [source.uri]: [{ ...edit(3, 6, 'new'), annotationId: 'a' }] },
    changeAnnotations: { a: { label: 'Needs approval' } },
  },
  {
    documentChanges: [
      { textDocument: { uri: source.uri, version: 1 }, edits: [edit(3, 6, 'x')] },
      { textDocument: { uri: source.uri, version: 1 }, edits: [edit(3, 6, 'y')] },
    ],
  },
])('refuses unsupported, stale, overlapping or out-of-scope edits %#', async (value) => {
  await expect(stageLspEdit(value, source, read)).rejects.toThrow();
});

it('accepts only the captured versions of other synchronized documents', async () => {
  const change = {
    documentChanges: [
      { textDocument: { uri: 'file:///copy/b.ts', version: 3 }, edits: [edit(0, 3, 'new')] },
    ],
  };
  const versions = new Map([
    [source.uri, 1],
    ['file:///copy/b.ts', 3],
  ]);
  expect((await stageLspEdit(change, source, read, versions))[0]?.after).toBe('new\n');
  versions.set('file:///copy/b.ts', 4);
  await expect(stageLspEdit(change, source, read, versions)).rejects.toMatchObject({
    code: 'REVISION_CONFLICT',
  });
});
