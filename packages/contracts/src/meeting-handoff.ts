import { z } from 'zod';
import { AutoModelChoice, AutoRoute, QualityPreset, UltraSelection } from './auto-team.ts';
import { Identifier } from './ids.ts';

export const MeetingHandoffExecution = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('corral'), corralId: Identifier }),
  z.strictObject({
    kind: z.literal('auto'),
    choice: AutoModelChoice,
    qualityPreset: QualityPreset.optional(),
    ultra: UltraSelection.optional(),
  }),
]);
export type MeetingHandoffExecution = z.infer<typeof MeetingHandoffExecution>;

export const MeetingHandoffOrigin = z.strictObject({
  sourceSessionId: Identifier,
  commandId: Identifier,
  decisionVersionId: Identifier,
});
export type MeetingHandoffOrigin = z.infer<typeof MeetingHandoffOrigin>;

export const MeetingHandoffStartRequest = z.strictObject({
  commandId: Identifier,
  targetHasDraft: z.boolean(),
});
export type MeetingHandoffStartRequest = z.infer<typeof MeetingHandoffStartRequest>;

export const MeetingHandoffRequest = z.strictObject({
  commandId: Identifier,
  decisionVersionId: Identifier,
  target: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('existing'), sessionId: Identifier }),
    z.strictObject({ kind: z.literal('new'), title: z.string().trim().min(1).max(120) }),
  ]),
  action: z.enum(['draft', 'start']),
  execution: MeetingHandoffExecution,
  mode: z.enum(['mock', 'live']),
  /** The requesting client must check the target's local composer before requesting a start. */
  targetHasDraft: z.boolean(),
});
export type MeetingHandoffRequest = z.infer<typeof MeetingHandoffRequest>;

export const MeetingHandoffReceipt = z.strictObject({
  commandId: Identifier,
  startCommandId: Identifier,
  sourceSessionId: Identifier,
  decisionVersionId: Identifier,
  targetSessionId: Identifier,
  entryId: Identifier,
  action: z.enum(['draft', 'start']),
  execution: MeetingHandoffExecution,
  autoRoute: AutoRoute.nullable().optional(),
  /** The exact saved Corral revision selected for this request, never the session default. */
  definitionRevision: z.int().min(1).nullable(),
  mode: z.enum(['mock', 'live']),
  brief: z.string().min(1).max(20000),
  state: z.enum(['drafted', 'starting', 'started', 'refused', 'cancelled', 'uncertain']),
  detail: z.string().nullable(),
  runId: Identifier.nullable(),
  createdAt: z.string(),
  result: z
    .strictObject({
      status: z.string(),
      artifactVersionId: Identifier.nullable(),
    })
    .nullable(),
});
export type MeetingHandoffReceipt = z.infer<typeof MeetingHandoffReceipt>;
