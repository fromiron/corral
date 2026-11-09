import { z } from 'zod';

/** The reasoning levels automatic reasoning chooses from, weakest first (features/effort-routing.md). */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh'] as const;
export const EffortLevel = z.enum(EFFORT_LEVELS);
export type EffortLevel = z.infer<typeof EffortLevel>;
