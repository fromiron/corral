import { z } from 'zod';
import { Identifier } from './ids.ts';

export const PreviewObservationUrl = z
  .string()
  .min(1)
  .max(2048)
  .regex(
    /^http:\/\/127\.0\.0\.2:[1-9][0-9]{0,4}\/[^?#\s\\]*$/,
    'preview observation URL must omit credentials and query data',
  );

/** Untrusted page observations, never an executable instruction or proof of a source tree. */
export const PreviewObservation = z.strictObject({
  sessionId: Identifier,
  leaseId: Identifier,
  capturedAt: z.iso.datetime(),
  url: PreviewObservationUrl,
  pageRevision: z.int().min(0),
  sourceRevision: z.null(),
  element: z.strictObject({
    tag: z.string().max(80),
    role: z.string().max(120).nullable(),
    selector: z.string().max(500),
    text: z.string().max(4000),
    bounds: z.strictObject({
      x: z.number().finite().min(0),
      y: z.number().finite().min(0),
      width: z.number().finite().positive(),
      height: z.number().finite().positive(),
    }),
    styles: z.record(z.string().max(80), z.string().max(200)),
  }),
  console: z
    .array(z.strictObject({ level: z.string().max(20), message: z.string().max(1000) }))
    .max(20),
  screenshot: z
    .strictObject({
      mime: z.literal('image/png'),
      data: z.string().max(Math.ceil((1024 * 1024) / 3) * 4),
      width: z.int().min(1).max(2048),
      height: z.int().min(1).max(2048),
    })
    .nullable(),
});
export type PreviewObservation = z.infer<typeof PreviewObservation>;
