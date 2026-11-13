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
  /** `submit_advice` only: how the advice was admitted, or why it was dropped (features/advisor.md). */
  advice: z
    .discriminatedUnion('outcome', [
      z.strictObject({
        outcome: z.literal('admitted'),
        adviceId: Identifier,
        delivery: z.enum(['next_request', 'interrupt', 'preserve']),
      }),
      z.strictObject({
        outcome: z.literal('suppressed'),
        reason: z.enum(['noise', 'duplicate', 'over_budget', 'target_terminal']),
      }),
    ])
    .optional(),
});
export type Receipt = z.infer<typeof Receipt>;
