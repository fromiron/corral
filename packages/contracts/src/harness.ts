import { z } from 'zod';
import { Identifier } from './ids.ts';

/** An immutable profile revision, never a path or a mutable "latest" alias (CR-018). */
export const HarnessBindingRef = z.strictObject({
  profileId: Identifier,
  revision: z.int().min(1),
});
export type HarnessBindingRef = z.infer<typeof HarnessBindingRef>;
