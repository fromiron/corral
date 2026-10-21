import { z } from 'zod';
import { ResourcePath } from './harness.ts';
import { Identifier } from './ids.ts';
export const PreviewFileArgs = z.strictObject({ path: ResourcePath });
export const PreviewAppArgs = z.strictObject({
  operationId: Identifier,
  port: z.int().min(1).max(65535),
  entryPath: z.string().max(2048).optional(),
});
export const PreviewActionArgs = z
  .strictObject({
    leaseId: Identifier,
    tool: z.enum([
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_select_option',
      'browser_press_key',
      'browser_hover',
      'browser_resize',
      'browser_wait_for',
      'browser_close',
      'browser_take_screenshot',
      'browser_verify_element_visible',
      'browser_verify_text_visible',
      'browser_verify_list_visible',
      'browser_verify_value',
    ]),
    args: z.record(z.string(), z.unknown()),
  })
  .refine((input) => {
    if (['filename', 'paths', 'time'].some((key) => key in input.args)) return false;
    try {
      let bytes = 0;
      for (const char of JSON.stringify(input.args)) {
        const code = char.codePointAt(0) ?? 0;
        bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
        if (bytes > 64 * 1024) return false;
      }
      return true;
    } catch {
      return false;
    }
  }, 'unsupported browser parameters');
export type PreviewToolName = 'preview_file' | 'preview_app' | 'preview_action';
