import { type TextAttachment, TextRange } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import type { DocumentBuffer } from '../documents/store.ts';

export async function hashDocumentText(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Capture immutable selected bytes before yielding; Monaco columns exclude a leading BOM. */
export async function captureDocumentAttachment(
  entry: Pick<
    DocumentBuffer,
    'text' | 'target' | 'path' | 'baseHash' | 'editVersion' | 'dirty' | 'saving' | 'pendingSave'
  >,
  selection: TextRange,
): Promise<TextAttachment> {
  const range = TextRange.parse(selection);
  const fullText = entry.text;
  const text = fullText.startsWith('\uFEFF') ? fullText.slice(1) : fullText;
  const starts = [0],
    ends: number[] = [];
  for (const newline of text.matchAll(/\r\n|\r|\n/g)) {
    ends.push(newline.index);
    starts.push(newline.index + newline[0].length);
  }
  ends.push(text.length);
  const offset = (line: number, column: number) => {
    const start = starts[line - 1],
      end = ends[line - 1];
    if (start === undefined || end === undefined || column > end - start + 1)
      throw new Error('Selection is outside the document');
    return start + column - 1;
  };
  const selected = text.slice(
    offset(range.startLine, range.startColumn),
    offset(range.endLine, range.endColumn),
  );
  const target = { ...entry.target };
  const path = entry.path;
  const baseHash = entry.baseHash;
  const editVersion = entry.editVersion;
  const snapshot = entry.dirty || entry.saving || entry.pendingSave ? 'draft' : 'saved';
  const name =
    (path.split('/').at(-1) ?? 'code')
      .replace(/\p{Cc}/gu, ' ')
      .trim()
      .slice(0, 120)
      .replace(/\p{Cs}$/u, '') || 'code';
  const bufferHash = await hashDocumentText(fullText);
  return createTextAttachment(name, 'text/plain', selected, {
    kind: 'code',
    target,
    path,
    snapshot,
    baseHash,
    bufferHash,
    editVersion,
    range,
  });
}
