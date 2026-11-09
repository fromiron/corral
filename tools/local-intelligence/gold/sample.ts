import { createHash } from 'node:crypto';
import type { MeetingSelectionInput } from '../../../packages/contracts/src/index.ts';
import type { MeetingCase } from './meeting.ts';

interface Base {
  id: string;
  group: string;
  split: 'tuning' | 'final';
  lang: 'ko' | 'ja' | 'en';
  /** Set on a blind repeat of another item; it measures how stable the labels themselves are. */
  retestOf?: string;
}
export type GoldItem = Base & {
  kind: 'meeting';
  input: MeetingSelectionInput;
  names: Record<string, string>;
  chosen?: string[];
};
export interface SampleOptions {
  seed: string;
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

export function sampleItems(meetings: MeetingCase[], options: SampleOptions): GoldItem[] {
  const items: GoldItem[] = [];
  for (const { session, input, names, chosen } of meetings)
    items.push({
      ...base('meeting', session, input, input.message),
      kind: 'meeting',
      input,
      names,
      ...(chosen ? { chosen } : {}),
    });
  const repeatable = items.filter((item) => !item.chosen);
  const repeats = ordered(repeatable, (item) => hash(`${options.seed}retest${item.id}`))
    .slice(0, Math.ceil(repeatable.length * options.retestShare))
    .map((item) => ({ ...item, id: hash(`retest${item.id}`).slice(0, 16), retestOf: item.id }));
  return ordered([...items, ...repeats], (item) => hash(options.seed + item.id));
}
