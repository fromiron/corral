import { z } from 'zod';
import { OutputContract } from './definition.ts';

// A new team the model composes (docs/specs/features/team-assistant.md, "팀 구성 제안"). The
// catalog lists what the editor can pick by hand; the composition seats catalog agents and shapes
// the flow from three step kinds. Neither carries a tool, a permission, a prompt body or a path:
// those come from the chosen agents and the editor's defaults when the composition is assembled.

/**
 * A short name that means something only inside one request or one answer. No node takes it as
 * its id, so it needs no form beyond its length.
 */
const ShortId = z.string().min(1).max(40);
const Text = (max: number) => z.string().trim().min(1).max(max);

export const TEAM_COMPOSITION_LIMITS = {
  agents: 64,
  skills: 256,
  skillDescription: 300,
  name: 80,
  brief: 2000,
  criteria: 6,
  criterion: 200,
  seats: 8,
  seatName: 40,
  duty: 400,
  /** Skills a seat keeps once the server normalises its ids. */
  seatSkills: 4,
  /** Skill ids a seat may name; unknown, repeated or extra ones are dropped. */
  seatSkillIds: 16,
  parallel: { min: 2, max: 4 },
  loopWork: { min: 1, max: 3 },
  rounds: { min: 1, max: 3 },
} as const;
const L = TEAM_COMPOSITION_LIMITS;

export const CatalogAgent = z.strictObject({
  id: ShortId,
  name: z.string().min(1),
  /**
   * A bundled agent's file description; for any other agent its own description, or the first
   * sentence of its instructions without one.
   */
  description: z.string().min(1).optional(),
  changesFiles: z.boolean(),
  runsCommands: z.boolean(),
  output: OutputContract,
  /** The names of the skills the agent already has. */
  skills: z.array(z.string().min(1)),
});
export type CatalogAgent = z.infer<typeof CatalogAgent>;

/** A skill goes by its name, and a bundled skill's name may be 64 characters. */
export const SkillRef = z.string().min(1).max(64);

export const CatalogSkill = z.strictObject({
  id: SkillRef,
  name: z.string().min(1),
  description: z.string().max(L.skillDescription),
});
export type CatalogSkill = z.infer<typeof CatalogSkill>;

const distinctIds = (items: readonly { id: string }[]) =>
  new Set(items.map(({ id }) => id)).size === items.length;

export const TeamCatalog = z.strictObject({
  agents: z
    .array(CatalogAgent)
    .min(1)
    .max(L.agents)
    .refine(distinctIds, { message: 'agent ids are unique' }),
  skills: z
    .array(CatalogSkill)
    .max(L.skills)
    .refine(distinctIds, { message: 'skill ids are unique' }),
});
export type TeamCatalog = z.infer<typeof TeamCatalog>;

export const CompositionSeat = z.strictObject({
  id: ShortId,
  /** A catalog agent's id. */
  agent: ShortId,
  name: Text(L.seatName),
  /** The seat's duty: the step instruction of its node. */
  duty: Text(L.duty),
  /** Catalog skill ids added to the agent's own skills. */
  skills: z.array(SkillRef).max(L.seatSkillIds).optional(),
});
export type CompositionSeat = z.infer<typeof CompositionSeat>;

export const CompositionStep = z.union([
  z.strictObject({ seat: ShortId }),
  z.strictObject({ parallel: z.array(ShortId).min(L.parallel.min).max(L.parallel.max) }),
  z.strictObject({
    loop: z.strictObject({
      work: z.array(ShortId).min(L.loopWork.min).max(L.loopWork.max),
      judge: ShortId,
      /** Absent means 2. */
      rounds: z.int().min(L.rounds.min).max(L.rounds.max).optional(),
    }),
  }),
]);
export type CompositionStep = z.infer<typeof CompositionStep>;

/** The seats a step names, in the order they work: a loop's judge comes after its work. */
export function stepSeats(step: CompositionStep): string[] {
  if ('seat' in step) return [step.seat];
  if ('parallel' in step) return [...step.parallel];
  return [...step.loop.work, step.loop.judge];
}

export const TeamComposition = z
  .strictObject({
    name: Text(L.name),
    brief: Text(L.brief),
    criteria: z.array(Text(L.criterion)).min(1).max(L.criteria),
    seats: z.array(CompositionSeat).min(1).max(L.seats),
    flow: z.array(CompositionStep).min(1),
    /** Requested consultation or review by the shared Outrider; never automatic observation. */
    outrider: z.enum(['consultation', 'artifact_review', 'required_review']).optional(),
  })
  .superRefine((composition, ctx) => {
    const ids = composition.seats.map((seat) => seat.id);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: 'custom',
        path: ['seats'],
        message: 'seat ids are unique',
        params: { issue: 'duplicate_seat' },
      });
    const known = new Set(ids);
    const named = new Map<string, number>();
    composition.flow.forEach((step, index) => {
      for (const id of stepSeats(step)) {
        if (!known.has(id))
          ctx.addIssue({
            code: 'custom',
            path: ['flow', index],
            message: `no seat ${id}`,
            params: { issue: 'unknown_seat' },
          });
        named.set(id, (named.get(id) ?? 0) + 1);
      }
    });
    for (const id of known)
      if (named.get(id) !== 1)
        ctx.addIssue({
          code: 'custom',
          path: ['flow'],
          message: `seat ${id} appears in the flow exactly once`,
          params: { issue: 'seat_not_once' },
        });
  });
export type TeamComposition = z.infer<typeof TeamComposition>;
