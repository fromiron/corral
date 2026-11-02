export interface TeacherResponse {
  model?: string;
  usage?: { completion_tokens?: number; [key: string]: unknown };
  choices?: { message?: { content?: string }; finish_reason?: string }[];
}

/** Some gateways report stop even when reasoning consumed the entire output allowance. */
export function completedTeacherJson(body: TeacherResponse, budget: number): string {
  const choice = body.choices?.[0];
  if (
    choice?.finish_reason !== 'stop' ||
    !choice.message?.content ||
    (body.usage?.completion_tokens ?? 0) >= budget
  ) {
    throw new Error('teacher response is incomplete or exhausted its output budget');
  }
  const content = choice.message.content
    .trim()
    .replace(/^```(?:json)?\s*\n?/, '')
    .replace(/\n?```$/, '');
  return JSON.stringify(JSON.parse(content));
}
