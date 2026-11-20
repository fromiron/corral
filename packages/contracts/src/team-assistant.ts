import { z } from 'zod';
import { Identifier } from './ids.ts';
import { TeamCatalog, TeamComposition } from './team-composition.ts';

const InputIndex = z.int().nonnegative();
export const TeamAssistantTarget = z.strictObject({ outputId: Identifier, index: InputIndex });
export type TeamAssistantTarget = z.infer<typeof TeamAssistantTarget>;

// A working copy, not a generated TeamPlan: keep even an unfinished brief and do not limit
// existing names or roster size to what the model can propose in a plan.
export const TeamAssistantTeam = z.strictObject({
  roles: z.array(z.strictObject({ nodeId: Identifier, name: z.string() })),
  outputs: z.array(
    z.strictObject({
      outputId: Identifier,
      results: z.array(
        z.strictObject({ index: InputIndex, name: z.string(), producerName: z.string() }),
      ),
    }),
  ),
  hasSharedOutrider: z.boolean(),
  brief: z.string(),
});
export type TeamAssistantTeam = z.infer<typeof TeamAssistantTeam>;

/** The index belongs to the unfiltered output inputs, not the results array's offsets. */
export function hasAssistantTarget(
  team: TeamAssistantTeam | undefined,
  target: TeamAssistantTarget,
): boolean {
  return (
    team?.outputs.some(
      (output) =>
        output.outputId === target.outputId &&
        output.results.some((result) => result.index === target.index),
    ) ?? false
  );
}

const Material = z.enum(['person', 'team']);
const ReviewPolicy = z.enum(['opinion_only', 'required']);
const QuestionId = z.enum(['material', 'review_policy', 'review_target']);
const MessageContent = z.string().min(1).max(2000);
const requestFields = {
  operationId: z.string().min(1).max(200),
  messages: z
    .array(
      z.discriminatedUnion('role', [
        z.strictObject({ role: z.literal('user'), content: MessageContent }),
        z.strictObject({
          role: z.literal('assistant'),
          content: MessageContent,
          questionId: QuestionId,
        }),
      ]),
    )
    .min(1)
    .max(12),
  decisions: z
    .strictObject({
      material: Material.optional(),
      reviewPolicy: ReviewPolicy.optional(),
      observeWork: z.boolean().optional(),
      reviewTarget: TeamAssistantTarget.optional(),
    })
    .optional(),
};
export const TeamAssistantRequest = z
  .discriminatedUnion('mode', [
    // A new team is composed from what the editor can pick by hand; `proposal` is the shown
    // composition the person asks to change.
    z.strictObject({
      ...requestFields,
      mode: z.literal('create'),
      team: z.never().optional(),
      catalog: TeamCatalog,
      proposal: TeamComposition.optional(),
    }),
    z.strictObject({ ...requestFields, mode: z.literal('edit'), team: TeamAssistantTeam }),
  ])
  .refine(
    ({ decisions, team }) =>
      !decisions?.reviewTarget || hasAssistantTarget(team, decisions.reviewTarget),
    { path: ['decisions', 'reviewTarget'], message: 'Choose a result in the current team.' },
  );
export type TeamAssistantRequest = z.infer<typeof TeamAssistantRequest>;

const question = z.literal('question');
const Question = z.discriminatedUnion('id', [
  z.strictObject({
    kind: question,
    id: z.literal(QuestionId.enum.material),
    choices: z
      .array(Material)
      .length(2)
      .refine(([a, b]) => a !== b),
  }),
  z.strictObject({
    kind: question,
    id: z.literal(QuestionId.enum.review_policy),
    choices: z
      .array(ReviewPolicy)
      .length(2)
      .refine(([a, b]) => a !== b),
  }),
  z.strictObject({
    kind: question,
    id: z.literal(QuestionId.enum.review_target),
    choices: z
      .array(TeamAssistantTarget)
      .min(2)
      .max(3)
      .refine(
        (choices) =>
          new Set(choices.map(({ outputId, index }) => `${outputId}/${index}`)).size ===
          choices.length,
      ),
  }),
]);

const Edit = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('set_brief'), brief: z.string().min(1) }),
  z.strictObject({ kind: z.literal('add_shared_advice') }),
  TeamAssistantTarget.extend({ kind: z.literal('require_review') }),
]);

let sentences: Intl.Segmenter | undefined;
const Reason = z
  .string()
  .trim()
  .min(1)
  .transform((text) => {
    sentences ??= new Intl.Segmenter('und', { granularity: 'sentence' });
    const first = sentences.segment(text).containing(0)?.segment ?? text;
    return first.slice(0, 400).trimEnd();
  });

export const TeamAssistantReply = z.discriminatedUnion('kind', [
  Question,
  z.strictObject({ kind: z.literal('plan'), plan: TeamComposition, reason: Reason }),
  z.strictObject({ kind: z.literal('edits'), edits: z.array(Edit).min(1), reason: Reason }),
  z.strictObject({
    kind: z.literal('describe'),
    topic: z.enum(['submitter', 'members', 'review']),
  }),
  z.strictObject({ kind: z.literal('unsupported') }),
]);
export type TeamAssistantReply = z.infer<typeof TeamAssistantReply>;

/** The request supplies the mode; it is never a model-selected field of the reply. */
export function assistantKindAllowed(
  mode: TeamAssistantRequest['mode'],
  kind: TeamAssistantReply['kind'],
): boolean {
  return mode === 'create' ? kind === 'question' || kind === 'plan' : kind !== 'plan';
}

export const TeamAssistantResponse = z.strictObject({
  reply: TeamAssistantReply,
  model: z.string().min(1),
});
export type TeamAssistantResponse = z.infer<typeof TeamAssistantResponse>;

/** The failure of a model answer that cannot be used as a team proposal. */
export const UNUSABLE_TEAM_PROPOSAL_MESSAGE = 'The model did not return a usable team proposal.';

/** The failure message, with the reason code after it in parentheses; never the answer's text. */
export function unusableTeamProposal(reason?: string): string {
  return reason ? `${UNUSABLE_TEAM_PROPOSAL_MESSAGE} (${reason})` : UNUSABLE_TEAM_PROPOSAL_MESSAGE;
}

/** The reason code of that failure, `''` when it names none, or null for any other message. */
export function unusableTeamProposalReason(message: string): string | null {
  if (message === UNUSABLE_TEAM_PROPOSAL_MESSAGE) return '';
  const prefix = `${UNUSABLE_TEAM_PROPOSAL_MESSAGE} (`;
  if (!message.startsWith(prefix) || !message.endsWith(')')) return null;
  const reason = message.slice(prefix.length, -1);
  return /^[a-z_]+$/.test(reason) ? reason : null;
}
