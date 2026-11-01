import type { MeetingSelectionInput, ReasoningInput } from '@corral/contracts';

export interface EffortInput {
  goal?: string;
  request: string;
  previousRequest?: string;
  previousReply?: string;
  stage: string;
  plan?: string;
  tools?: { name: string; args?: string; status: string; content: string }[];
}
export interface MeetingInput {
  participants: { id: string; name: string; role: string }[];
  message: string;
  turns: { id: string; speakerId: string | null; text: string; replyTo?: string }[];
}

/** No character clipping here: the model-specific tokenizer owns budget accounting. */
export function renderEffort(input: EffortInput): string {
  const fields = [
    `Task: choose the minimum reasoning effort for the NEXT coding response.`,
    `Stage: ${input.stage}`,
    `Current request: ${input.request}`,
    ...(input.goal ? [`Overall goal: ${input.goal}`] : []),
    ...(input.previousRequest ? [`Previous user request: ${input.previousRequest}`] : []),
    ...(input.previousReply ? [`Previous reply: ${input.previousReply}`] : []),
    ...(input.plan ? [`Current plan: ${input.plan}`] : []),
    ...(input.tools ?? []).flatMap((tool, i) => [
      `Tool ${i + 1}: ${tool.name}; status: ${tool.status}`,
      ...(tool.args ? [`Arguments: ${tool.args}`] : []),
      `Observed output: ${tool.content}`,
    ]),
  ];
  return fields.join('\n');
}

export function renderMeeting(input: MeetingInput, candidateId?: string): string {
  if (candidateId && !input.participants.some((p) => p.id === candidateId)) {
    throw new Error('candidate is not a participant');
  }
  return [
    'Task: choose who should answer the current message in this group conversation.',
    'Participants:',
    ...input.participants.map((p) => `${p.id}: ${p.name}${p.role ? `; role: ${p.role}` : ''}`),
    'Conversation in visible order:',
    ...input.turns.map(
      (t) =>
        `[${t.id}] ${t.speakerId ?? 'user'}${t.replyTo ? ` replies to ${t.replyTo}` : ''}: ${t.text}`,
    ),
    `Current user message: ${input.message}`,
    ...(candidateId ? [`Candidate to judge: ${candidateId}`] : []),
  ].join('\n');
}

const INSTRUCTIONS = {
  effort:
    'Choose the minimum useful reasoning effort for the NEXT coding response, not the total project. Return ONLY low, medium, high, or xhigh.',
  meeting:
    'Select who should answer the current message. Return ONLY comma-separated participant IDs, or NONE for explicit silence. If any one responder is acceptable or the invitation is ambiguous, choose exactly one appropriate participant. Honor exclusions. Never infer capabilities from names.',
} as const;

/** Qwen3.5 frame plus its trained tokenizer's NFC normalizer; source records stay intact. */
export function formatDecisionPrompt(task: 'effort' | 'meeting', text: string): string {
  return `<|im_start|>system\n${INSTRUCTIONS[task]}<|im_end|>\n<|im_start|>user\n${text}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`.normalize(
    'NFC',
  );
}

/** ReasoningInput.calls already contains observed tool results, in supplied order. */
export function toEffortInput(input: ReasoningInput): EffortInput {
  return {
    request: input.request,
    previousRequest: input.prevRequest,
    previousReply: input.prev,
    stage: input.kind,
    plan: input.plan,
    tools: input.calls.map((call) => ({
      name: call.name,
      args: call.args,
      status: 'status' in call && typeof call.status === 'string' ? call.status : 'completed',
      content: call.result,
    })),
  };
}

export type DecisionMeetingSelectionInput = Omit<MeetingSelectionInput, 'history'> & {
  history: (MeetingSelectionInput['history'][number] & { replyTo?: string })[];
};

export interface CompactMeetingInput {
  input: MeetingInput;
  /** Model alias -> real participant ID, retained locally for result restoration. */
  participantIds: ReadonlyMap<string, string>;
}

/** Alias structural metadata only. Body text, names, and roles are never rewritten. */
export function compactMeetingInput(input: DecisionMeetingSelectionInput): CompactMeetingInput {
  if (
    input.participants.length < 2 ||
    input.participants.length > 6 ||
    input.participants.some((participant) => !participant.participantId) ||
    new Set(input.participants.map((participant) => participant.participantId)).size !==
      input.participants.length
  )
    throw new Error('meeting input is invalid');
  const aliases = new Map(
    input.participants.map((participant, index) => [participant.participantId, `p${index + 1}`]),
  );
  const participantIds = new Map([...aliases].map(([id, alias]) => [alias, id]));
  const otherSpeakers = new Map<string, string>();
  const speaker = (id: string | null): string | null => {
    if (id === null) return null;
    const known = aliases.get(id);
    if (known) return known;
    const other = otherSpeakers.get(id) ?? `other${otherSpeakers.size + 1}`;
    otherSpeakers.set(id, other);
    return other;
  };
  const turnIds = new Map(
    input.history.flatMap((turn, index) => (turn.id ? [[turn.id, `t${index + 1}`] as const] : [])),
  );
  let nextTurn = input.history.length + 1;
  const replyTarget = (id: string) => {
    // References outside supplied history keep a stable opaque alias, without inventing a turn.
    const alias = turnIds.get(id) ?? `t${nextTurn++}`;
    turnIds.set(id, alias);
    return alias;
  };
  return {
    participantIds,
    input: {
      participants: input.participants.map((participant, index) => ({
        id: `p${index + 1}`,
        name: participant.name ?? '',
        role: participant.prompt,
      })),
      message: input.message,
      turns: input.history.map((turn, index) => ({
        id: `t${index + 1}`,
        speakerId: speaker(turn.participantId),
        text: turn.text,
        ...(turn.replyTo ? { replyTo: replyTarget(turn.replyTo) } : {}),
      })),
    },
  };
}
