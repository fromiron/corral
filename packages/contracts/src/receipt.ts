import { z } from 'zod';
import { CommandError } from './errors.ts';
import { Identifier } from './ids.ts';
import { ReceiptStatus } from './states.ts';

/** See docs/specs/api-contract.md §2. `accepted` means committed, never applied (docs/specs/features/reins.md §3). */
export const Receipt = z.strictObject({
  commandId: Identifier,
  runId: Identifier,
  status: ReceiptStatus,
  acceptedSeq: z.int().min(1).nullable(),
  target: z.string().min(1),
  requestedBoundary: z.enum(['immediate', 'next_request', 'next_activation', 'safe_boundary']),
  relatedEventIds: z.array(Identifier),
  error: CommandError.optional(),
});
export type Receipt = z.infer<typeof Receipt>;
