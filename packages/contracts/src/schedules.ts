import { z } from 'zod';
import { AutoModelChoice } from './auto-team.ts';
import { RunReferences } from './commands.ts';
import { Identifier } from './ids.ts';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const ScheduleRule = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), at: z.iso.datetime() }),
  z.strictObject({ kind: z.literal('daily'), time }),
  z.strictObject({
    kind: z.literal('weekly'),
    time,
    weekdays: z.array(z.int().min(0).max(6)).min(1).max(7),
  }),
]);
export type ScheduleRule = z.infer<typeof ScheduleRule>;

export const ScheduleDraft = z.strictObject({
  title: z.string().trim().min(1).max(120),
  hostId: z.literal('local'),
  projectId: Identifier,
  sessionId: Identifier,
  timezone: z
    .string()
    .max(100)
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }, 'Choose an IANA time zone'),
  rule: ScheduleRule,
  enabled: z.boolean(),
  request: z.strictObject({
    brief: z.string().trim().min(1).max(20_000),
    choice: AutoModelChoice,
    mode: z.enum(['mock', 'live']),
    permissionMode: z.enum(['ask', 'accept_edits', 'auto']),
    taskScope: z.enum(['work', 'review_only']).optional(),
    verificationScope: z.enum(['targeted', 'release']).optional(),
    references: RunReferences.optional(),
    /** Revision of these saved request settings; resolved model metadata is pinned by each Run. */
    configRevision: z.int().min(1),
  }),
});
export type ScheduleDraft = z.infer<typeof ScheduleDraft>;
export const Schedule = ScheduleDraft.extend({
  id: Identifier,
  revision: z.int().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  nextAt: z.iso.datetime().nullable(),
  deletedAt: z.iso.datetime().nullable(),
});
export type Schedule = z.infer<typeof Schedule>;

export const ScheduledOccurrence = z.strictObject({
  id: Identifier,
  scheduleId: Identifier,
  revision: z.int().min(1),
  dueAt: z.iso.datetime(),
  commandId: Identifier,
  manual: z.boolean(),
  status: z.enum(['dispatching', 'started', 'missed', 'overlap', 'refused', 'interrupted']),
  runId: Identifier.nullable(),
  detail: z.string().nullable(),
  createdAt: z.iso.datetime(),
});
export type ScheduledOccurrence = z.infer<typeof ScheduledOccurrence>;
