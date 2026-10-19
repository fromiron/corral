import { z } from 'zod';
import { ContentHash } from './harness.ts';
import { Identifier } from './ids.ts';

const option = z.strictObject({
  id: Identifier,
  label: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional(),
  recommended: z.boolean().optional(),
});
const question = z
  .strictObject({
    id: Identifier,
    prompt: z.string().trim().min(1).max(2000),
    description: z.string().max(4000).optional(),
    kind: z.enum(['single', 'multiple', 'text']),
    options: z.array(option).min(2).max(5).optional(),
    allowFreeText: z.boolean().optional(),
  })
  .superRefine((q, ctx) => {
    if ((q.kind === 'text') === (q.options !== undefined))
      ctx.addIssue({
        code: 'custom',
        message: 'text questions have no options; choice questions need options',
      });
    if (q.options && new Set(q.options.map((o) => o.id)).size !== q.options.length)
      ctx.addIssue({ code: 'custom', message: 'option IDs must be unique' });
  });

export const UserInputRequest = z
  .strictObject({
    key: Identifier,
    questions: z.array(question).min(1).max(4),
    timeoutMs: z.int().min(1000).max(600_000).optional(),
  })
  .refine(
    (q) => new Set(q.questions.map((item) => item.id)).size === q.questions.length,
    'question IDs must be unique',
  );
export type UserInputRequest = z.infer<typeof UserInputRequest>;

export const UserAnswers = z
  .array(
    z.strictObject({
      questionId: Identifier,
      optionIds: z.array(Identifier).max(5).optional(),
      text: z.string().trim().min(1).max(12000).optional(),
    }),
  )
  .min(1)
  .max(4);
export type UserAnswers = z.infer<typeof UserAnswers>;

/** Shared by the Coordinator and clients; never trusts the model's choice IDs. */
export function validUserAnswers(request: UserInputRequest, answers: UserAnswers): boolean {
  if (
    !UserAnswers.safeParse(answers).success ||
    answers.length !== request.questions.length ||
    new Set(answers.map((a) => a.questionId)).size !== answers.length
  )
    return false;
  return request.questions.every((q) => {
    const answer = answers.find((a) => a.questionId === q.id);
    if (!answer) return false;
    const ids = answer.optionIds ?? [];
    if (new Set(ids).size !== ids.length || ids.some((id) => !q.options?.some((o) => o.id === id)))
      return false;
    if (q.kind === 'text') return ids.length === 0 && Boolean(answer.text?.trim());
    if (answer.text && !q.allowFreeText) return false;
    const count = ids.length + (answer.text ? 1 : 0);
    return q.kind === 'single' ? count === 1 : count >= 1;
  });
}

export const UserAnswerFile = z
  .array(
    z.strictObject({
      key: Identifier,
      schemaHash: ContentHash,
      answers: UserAnswers,
    }),
  )
  .max(100)
  .refine(
    (entries) => new Set(entries.map((e) => `${e.key}:${e.schemaHash}`)).size === entries.length,
    'duplicate answer key and schema',
  );
export type UserAnswerFile = z.infer<typeof UserAnswerFile>;
