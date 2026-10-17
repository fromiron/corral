import { LspDiagnostic, LspPosition, LspRange, type LspReport } from '@corral/contracts';
import { ToolRefusal } from '@corral/core';
import { z } from 'zod';
import { redactToolText } from './check-output.ts';
import type { LspResponse } from './lsp.ts';

export interface LspDocument {
  path: string;
  text: string;
  sha256: string;
}
const Location = z.union([
  z.object({ uri: z.string(), range: LspRange }),
  z.object({ targetUri: z.string(), targetRange: LspRange, targetSelectionRange: LspRange }),
]);

export function validateLspPosition(raw: unknown, text: string) {
  const position = LspPosition.parse(raw),
    lines = text.split(/\r\n|\r|\n/);
  if (position.line >= lines.length || position.character > (lines[position.line]?.length ?? 0))
    throw new ToolRefusal('SCHEMA_INVALID', 'LSP position is outside the UTF-16 document');
  return position;
}
function rangeOf(raw: unknown, text: string) {
  const range = LspRange.parse(raw),
    lines = text.split(/\r\n|\r|\n/);
  const position = (value: z.infer<typeof LspPosition>) => {
    if (value.line >= lines.length)
      throw new ToolRefusal('SCHEMA_INVALID', 'language server range is outside the document');
    // LSP specifies that characters beyond a line's length mean the end of that line.
    return { ...value, character: Math.min(value.character, lines[value.line]?.length ?? 0) };
  };
  return LspRange.parse({ start: position(range.start), end: position(range.end) });
}

export async function lspResults(
  raw: LspResponse,
  source: LspDocument,
  readUri: (uri: string) => Promise<LspDocument>,
  privateRoot: string,
): Promise<LspReport['result']> {
  if (raw.kind === 'edits')
    throw new ToolRefusal('SCHEMA_INVALID', 'LSP edits require the change proposal broker');
  if (raw.kind === 'diagnostics')
    return {
      kind: 'diagnostics',
      diagnostics: raw.diagnostics.map((value) => {
        const item = z
          .object({
            range: LspRange,
            message: z.string(),
            severity: LspDiagnostic.shape.severity,
            code: z.union([z.string(), z.number()]).optional(),
            source: z.string().optional(),
          })
          .parse(value);
        return LspDiagnostic.parse({
          ...item,
          range: rangeOf(item.range, source.text),
          message: redactToolText(item.message, [privateRoot]).slice(0, 4000),
          ...(typeof item.code === 'string'
            ? { code: redactToolText(item.code, [privateRoot]).slice(0, 200) }
            : {}),
          ...(item.source
            ? { source: redactToolText(item.source, [privateRoot]).slice(0, 200) }
            : {}),
        });
      }),
    };
  const documents = new Map<string, LspDocument>();
  let bytes = Buffer.byteLength(source.text);
  const locations = [];
  for (const value of raw.locations) {
    const location = Location.parse(value),
      uri = 'uri' in location ? location.uri : location.targetUri;
    let document = documents.get(uri);
    if (!document) {
      document = await readUri(uri);
      bytes += Buffer.byteLength(document.text);
      if (bytes > 8 * 1024 * 1024)
        throw new ToolRefusal('LIMIT_REACHED', 'LSP result document limit exceeded');
      documents.set(uri, document);
    }
    if ('targetRange' in location) rangeOf(location.targetRange, document.text);
    locations.push({
      path: document.path,
      sha256: document.sha256,
      range: rangeOf(
        'range' in location ? location.range : location.targetSelectionRange,
        document.text,
      ),
    });
  }
  return { kind: 'locations', locations };
}
