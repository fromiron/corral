import { createHash } from 'node:crypto';
import type {
  MeetingSelectionInput,
  ReasoningInput,
} from '../../../packages/contracts/src/index.ts';
import type { HumanRequest } from './codex.ts';
import type { MeetingCase } from './meeting.ts';

interface Base {
  id: string;
  group: string;
  split: 'tuning' | 'final';
  lang: 'ko' | 'ja' | 'en';
  /** Set on a blind repeat of another item; it measures how stable the labels themselves are. */
  retestOf?: string;
}
export type GoldItem =
  | (Base & { kind: 'effort'; input: ReasoningInput })
  | (Base & {
      kind: 'meeting';
      input: MeetingSelectionInput;
      names: Record<string, string>;
      chosen?: string[];
    });
export interface SampleOptions {
  seed: string;
  maxSteps: number;
  stepsPerSession: number;
  retestShare: number;
}

const digest = (text: string) => createHash('sha256').update(text).digest();
const hash = (text: string) => digest(text).toString('hex');
const language = (text: string): Base['lang'] =>
  /[가-힣]/.test(text) ? 'ko' : /[぀-ヿ]/.test(text) ? 'ja' : 'en';
const base = (kind: string, group: string, input: unknown, text: string): Base => ({
  id: hash(kind + JSON.stringify(input)).slice(0, 16),
  group,
  split: digest(`gold-split:${group}`)[0]! < 128 ? 'tuning' : 'final',
  lang: language(text),
});
const ordered = <T>(rows: T[], key: (row: T) => string) =>
  rows
    .map((row) => ({ row, key: key(row) }))
    .sort((a, b) => a.key.localeCompare(b.key))
    .map(({ row }) => row);

export function sampleItems(
  requests: HumanRequest[],
  meetings: MeetingCase[],
  options: SampleOptions,
): GoldItem[] {
  const seen = new Set<string>();
  const unique = requests.filter(({ turn }) => {
    const key = turn.request.replace(/\s+/g, ' ').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const items: GoldItem[] = unique.map(({ session, turn }) => ({
    ...base('effort', session, turn, turn.request),
    kind: 'effort',
    input: turn,
  }));
  // One step per request, so a long-running task cannot fill the step sample by itself.
  const picks = unique.flatMap(({ session, turn, steps }) => {
    if (!steps.length) return [];
    const at = digest(options.seed + turn.request).readUInt32BE(0) % steps.length;
    return [{ session, step: steps[at]!, text: turn.request }];
  });
  const perSession = new Map<string, number>();
  let taken = 0;
  for (const pick of ordered(picks, (p) => hash(options.seed + JSON.stringify(p.step)))) {
    const used = perSession.get(pick.session) ?? 0;
    if (taken >= options.maxSteps) break;
    if (used >= options.stepsPerSession) continue;
    perSession.set(pick.session, used + 1);
    taken += 1;
    items.push({
      ...base('effort', pick.session, pick.step, pick.text),
      kind: 'effort',
      input: pick.step,
    });
  }
  for (const { session, input, names, chosen } of meetings)
    items.push({
      ...base('meeting', session, input, input.message),
      kind: 'meeting',
      input,
      names,
      ...(chosen ? { chosen } : {}),
    });
  const repeatable = items.filter((item) => item.kind === 'effort' || !item.chosen);
  const repeats = ordered(repeatable, (item) => hash(`${options.seed}retest${item.id}`))
    .slice(0, Math.ceil(repeatable.length * options.retestShare))
    .map((item) => ({ ...item, id: hash(`retest${item.id}`).slice(0, 16), retestOf: item.id }));
  return ordered([...items, ...repeats], (item) => hash(options.seed + item.id));
}
