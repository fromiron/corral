import type { MeetingInput } from './data.ts';

/** Production assigns p1..pN in roster order, so keep that representation in its stress view. */
export function permuteCanonicalRoster(input: MeetingInput, order: number[]) {
  return permuteMeeting(
    input,
    input.participants.map((_, i) => `p${order.indexOf(i) + 1}`),
    order,
  );
}

export function remapTarget<T extends { eligibleIds: string[]; excludedIds: string[] }>(
  target: T,
  remap: (id: string) => string,
): T {
  return {
    ...target,
    eligibleIds: target.eligibleIds.map(remap),
    excludedIds: target.excludedIds.map(remap),
  };
}

/** Renumber identities and independently permute the roster without changing the scene. */
export function permuteMeeting(input: MeetingInput, ids: string[], order: number[]) {
  if (
    ids.length !== input.participants.length ||
    new Set(ids).size !== ids.length ||
    order.length !== ids.length ||
    new Set(order).size !== ids.length ||
    order.some((i) => !Number.isInteger(i) || i < 0 || i >= ids.length)
  )
    throw new Error('identity and roster mappings must be permutations');
  const map = new Map(input.participants.map((p, i) => [p.id, ids[i]!]));
  const escaped = [...map.keys()].map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`\\b(${escaped.join('|')})\\b`, 'g');
  const text = (s: string) => s.replace(pattern, (id) => map.get(id)!);
  const remap = (id: string) => map.get(id) ?? id;
  return {
    remap,
    input: {
      participants: order.map((i) => ({
        ...input.participants[i]!,
        id: ids[i]!,
        role: text(input.participants[i]!.role),
      })),
      message: text(input.message),
      turns: input.turns.map((t) => ({
        ...t,
        speakerId: t.speakerId === null ? null : remap(t.speakerId),
        text: text(t.text),
      })),
    } satisfies MeetingInput,
  };
}
