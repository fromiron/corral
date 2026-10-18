import { createHash } from 'node:crypto';
import { LspRange } from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { TextDocument } from 'vscode-languageserver-protocol/node';
import { z } from 'zod';
import { type LspDocument, validateLspPosition } from './lsp-results.ts';

const TextEdit = z.strictObject({ range: LspRange, newText: z.string().max(1024 * 1024) });
const Edits = z.array(TextEdit).max(1000);
const WorkspaceEdit = z
  .strictObject({
    changes: z.record(z.string().max(4000), Edits).optional(),
    documentChanges: z
      .array(
        z.strictObject({
          textDocument: z.strictObject({
            uri: z.string().max(4000),
            version: z.int().min(1).nullable(),
          }),
          edits: Edits,
        }),
      )
      .max(32)
      .optional(),
  })
  .refine(
    (value) => value.changes === undefined || value.documentChanges === undefined,
    'mixed workspace edit forms',
  );
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface LspProposedFile {
  path: string;
  before: string;
  beforeHash: string;
  after: string;
  afterHash: string;
}

/** Calculate immutable proposed bytes; callers alone decide when to persist and apply them. */
export async function stageLspEdit(
  raw: unknown,
  source: { uri: string; version: number },
  readUri: (uri: string) => Promise<LspDocument>,
): Promise<LspProposedFile[]> {
  if (raw === null) return [];
  const parsed = WorkspaceEdit.safeParse(raw);
  if (!parsed.success)
    throw new ToolRefusal(
      'SCHEMA_INVALID',
      'LSP edit contains an unsupported operation, annotation or document shape',
    );
  const changes =
    parsed.data.documentChanges ??
    Object.entries(parsed.data.changes ?? {}).map(([uri, edits]) => ({
      textDocument: { uri, version: null },
      edits,
    }));
  if (changes.length > 32) throw new ToolRefusal('LIMIT_REACHED', 'LSP proposal exceeds 32 files');
  const files: LspProposedFile[] = [];
  const paths = new Set<string>();
  let total = 0;
  for (const change of changes) {
    const { uri, version } = change.textDocument;
    if (version !== null && (uri !== source.uri || version !== source.version))
      throw new ToolRefusal(
        'REVISION_CONFLICT',
        'LSP document version is stale or was not synchronized',
      );
    const file = await readUri(uri);
    const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
    if (paths.has(key)) throw new ToolRefusal('SCHEMA_INVALID', 'LSP proposal repeats a document');
    paths.add(key);
    if (Buffer.byteLength(file.text) > 1024 * 1024 || hash(file.text) !== file.sha256)
      throw new ToolRefusal('REVISION_CONFLICT', 'LSP source bytes changed');
    const lines = file.text.split(/\r\n|\r|\n/);
    for (const edit of change.edits) {
      if (
        edit.newText.includes('\0') ||
        Buffer.from(edit.newText).toString('utf8') !== edit.newText
      )
        throw new ToolRefusal('SCHEMA_INVALID', 'LSP edit is not valid UTF-8 text');
      for (const rawPosition of [edit.range.start, edit.range.end]) {
        const position = validateLspPosition(rawPosition, file.text);
        const line = lines[position.line] ?? '';
        const left = line.charCodeAt(position.character - 1),
          right = line.charCodeAt(position.character);
        if (left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff)
          throw new ToolRefusal('SCHEMA_INVALID', 'LSP edit splits a UTF-16 surrogate pair');
      }
    }
    // Reuse the installed protocol package's stable edit ordering and overlap checks.
    let after: string;
    try {
      after = TextDocument.applyEdits(
        TextDocument.create(uri, 'text', version ?? 0, file.text),
        change.edits,
      );
    } catch {
      throw new ToolRefusal('SCHEMA_INVALID', 'LSP edits overlap');
    }
    total += Buffer.byteLength(file.text) + Buffer.byteLength(after);
    if (Buffer.byteLength(after) > 1024 * 1024 || total > 8 * 1024 * 1024)
      throw new ToolRefusal('LIMIT_REACHED', 'LSP proposal exceeds text limits');
    if (after !== file.text)
      files.push({
        path: file.path,
        before: file.text,
        beforeHash: file.sha256,
        after,
        afterHash: hash(after),
      });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}
