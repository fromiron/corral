import { z } from 'zod';
import type { FileToolName } from './definition.ts';
import { ResourcePath } from './harness.ts';

export type BrokerFileToolName =
  | FileToolName
  | 'edit'
  | 'write'
  | 'read_hashline'
  | 'edit_hashline';

const Text = z.string().max(1024 * 1024);
export const HashlineEditInput = z.strictObject({
  version: z.literal(1),
  path: ResourcePath,
  tag: z.string().regex(/^[a-fA-F0-9]{4}$/),
  ops: z
    .string()
    .min(1)
    .max(256 * 1024),
});
export type HashlineEditInput = z.infer<typeof HashlineEditInput>;
/** Path-policy view of the same standalone MV grammar used by the broker. null fails closed. */
export function hashlineEffectPaths(args: Record<string, unknown>): string[] | null {
  const parsed = HashlineEditInput.safeParse(args);
  if (!parsed.success) return null;
  const { path, tag, ops } = parsed.data;
  const rows = ops.replace(/\r\n/g, '\n').split('\n');
  if (rows[0]?.startsWith('[')) {
    const header = /^\[(.+)#([a-fA-F0-9]{4})\]$/.exec(rows.shift() ?? '');
    if (!header || header[1] !== path || header[2]?.toLowerCase() !== tag.toLowerCase())
      return null;
  }
  const operations = rows.filter((row) => row.trim() && !row.startsWith('+'));
  const moves = operations.filter((row) => row.startsWith('MV '));
  if (!moves.length) return [path];
  if (operations.length !== 1) return null;
  let destination = moves[0]!.slice(3).trim();
  if (destination.startsWith('"') || destination.startsWith("'")) {
    if (destination.length < 3 || !destination.endsWith(destination[0]!)) return null;
    destination = destination.slice(1, -1);
  }
  return ResourcePath.safeParse(destination).success ? [path, destination] : null;
}
export const PiEditInput = z.strictObject({
  path: ResourcePath,
  edits: z
    .array(z.strictObject({ oldText: Text, newText: Text }))
    .min(1)
    .max(100),
});
export type PiEditInput = z.infer<typeof PiEditInput>;
export const PiWriteInput = z.strictObject({ path: ResourcePath, content: Text });
export type PiWriteInput = z.infer<typeof PiWriteInput>;
export const EditTextRequest = PiEditInput.extend({ text: Text });
export type EditTextRequest = z.infer<typeof EditTextRequest>;
export const EditTextResult = z.strictObject({
  text: Text,
  result: z.strictObject({
    content: z
      .array(z.strictObject({ type: z.literal('text'), text: z.string().max(2000) }))
      .max(16),
    details: z.strictObject({
      diff: z.string().max(4 * 1024 * 1024),
      patch: z.string().max(4 * 1024 * 1024),
      firstChangedLine: z.int().min(1).optional(),
    }),
  }),
});
export type EditTextResult = z.infer<typeof EditTextResult>;
