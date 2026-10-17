import { z } from 'zod';
import type { FileToolName } from './definition.ts';
import { ResourcePath } from './harness.ts';

export type BrokerFileToolName = FileToolName | 'edit' | 'write';

const Text = z.string().max(1024 * 1024);
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
