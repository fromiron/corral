import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  compactMeetingInput,
  type MeetingInput,
  renderMeeting,
} from '../../../../packages/local-intelligence/src/decision/text.ts';
import { renderIndexedMeeting } from './representations.ts';

export type View = 'timeline' | 'participant-index';
type Domain = 'natural' | 'synthetic' | 'effort';
interface SourceRow {
  id: string;
  group: string;
  split: string;
  task: 'effort' | 'meeting';
  language: string;
  input: unknown;
  target: Record<string, unknown>;
  text?: string;
}
const VERSION = 'phase2-sft-views-v1';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

/** Only supplied input enters rendering; supervision is mapped by a separate caller. */
export function meetingView(input: MeetingInput, view: View) {
  const compact = compactMeetingInput({
    message: input.message,
    participants: input.participants.map((p) => ({
      participantId: p.id,
      name: p.name,
      prompt: p.role,
    })),
    history: input.turns.slice(-12).map((t) => ({
      id: t.id,
      participantId: t.speakerId,
      text: t.text,
      ...(t.replyTo ? { replyTo: t.replyTo } : {}),
    })),
  });
  return {
    input: compact.input,
    modelToOriginalIds: Object.fromEntries(compact.participantIds),
    text: view === 'timeline' ? renderMeeting(compact.input) : renderIndexedMeeting(compact.input),
  };
}

export function sftRow(row: SourceRow, domain: Domain, view: View) {
  if (row.split !== 'fit' || !row.id || !row.group)
    throw new Error('SFT views require grouped F rows');
  if (row.task === 'effort') {
    if (domain !== 'effort' || typeof row.text !== 'string')
      throw new Error('existing effort text required');
    return { ...row, text: row.text, phase2Domain: domain, phase2View: view };
  }
  if (domain === 'effort') throw new Error('meeting domain mismatch');
  const rendered = meetingView(row.input as MeetingInput, view);
  const originalToModel = new Map(
    Object.entries(rendered.modelToOriginalIds).map(([alias, original]) => [original, alias]),
  );
  const mapIds = (value: unknown) => {
    if (
      !Array.isArray(value) ||
      value.some((id) => typeof id !== 'string' || !originalToModel.has(id))
    )
      throw new Error('target identity is outside roster');
    return value.map((id: string) => originalToModel.get(id) as string);
  };
  return {
    ...row,
    ...rendered,
    phase2Domain: domain,
    phase2View: view,
    target: {
      ...row.target,
      eligibleIds: mapIds(row.target.eligibleIds),
      excludedIds: mapIds(row.target.excludedIds),
    },
  };
}

/** Builds new immutable files only; no model, annotation source or non-F partition is opened. */
export function buildSftViews(
  syntheticPath: string,
  naturalPath: string,
  foldsPath: string,
  outputPath: string,
) {
  const output = resolve(outputPath);
  for (let at = output; ; at = dirname(at)) {
    if (existsSync(join(at, '.git')))
      throw new Error('research data must stay outside a repository');
    if (at === dirname(at)) break;
  }
  if (existsSync(output)) throw new Error('SFT view output must be new');
  const syntheticBytes = readFileSync(syntheticPath);
  const naturalBytes = readFileSync(naturalPath);
  const foldsBytes = readFileSync(foldsPath);
  const meetingFolds = JSON.parse(foldsBytes.toString()) as {
    syntheticFitSha256: string;
    naturalFitSha256: string;
    groups: { domain: 'natural' | 'synthetic'; group: string; fold: number }[];
  };
  if (
    hash(syntheticBytes) !== meetingFolds.syntheticFitSha256 ||
    hash(naturalBytes) !== meetingFolds.naturalFitSha256
  )
    throw new Error('source F files differ from frozen meeting fold manifest');
  const parse = (bytes: Buffer): SourceRow[] =>
    bytes
      .toString()
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
  const synthetic = parse(syntheticBytes);
  const natural = parse(naturalBytes);
  if (natural.some((r) => r.task !== 'meeting'))
    throw new Error('natural component must contain meeting F only');
  const rows = [...synthetic, ...natural];
  if (new Set(rows.map((r) => r.id)).size !== rows.length) throw new Error('duplicate F row IDs');
  const domains = new Map(
    rows.map(
      (r) =>
        [
          r.id,
          r.task === 'effort' ? 'effort' : natural.includes(r) ? 'natural' : 'synthetic',
        ] as const,
    ),
  );
  const assignment = new Map(meetingFolds.groups.map((g) => [g.group, g.fold]));
  const effortGroups = [
    ...new Set(synthetic.filter((r) => r.task === 'effort').map((r) => r.group)),
  ].sort((a, b) =>
    hash(`${VERSION}:41:effort:${a}`).localeCompare(hash(`${VERSION}:41:effort:${b}`)),
  );
  for (const [i, group] of effortGroups.entries()) {
    if (assignment.has(group)) throw new Error('effort and meeting groups overlap');
    assignment.set(group, i % 3);
  }
  const groups = new Set(rows.map((r) => r.group));
  if (assignment.size !== groups.size || [...groups].some((g) => !assignment.has(g)))
    throw new Error('fold groups differ from combined F');
  const views = (['timeline', 'participant-index'] as const).map((view) => {
    const derived = rows.map((row) => sftRow(row, domains.get(row.id) as Domain, view));
    const bytes = `${derived.map((row) => JSON.stringify(row)).join('\n')}\n`;
    const folds = [0, 1, 2].map((fold) => ({
      devGroups: [...assignment]
        .filter(([, f]) => f === fold)
        .map(([g]) => g)
        .sort(),
    }));
    return {
      view,
      bytes,
      holdout: { version: 'fit-holdout-v1', fitSha256: hash(bytes), folds },
      counts: Object.fromEntries(
        (['effort', 'synthetic', 'natural'] as const).map((domain) => [
          domain,
          derived.filter((r) => r.phase2Domain === domain).length,
        ]),
      ),
    };
  });
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const write = (path: string, value: string | Buffer) =>
    writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
  write(join(output, 'source-synthetic-fit.jsonl'), syntheticBytes);
  write(join(output, 'source-natural-fit.jsonl'), naturalBytes);
  write(join(output, 'meeting-folds.json'), foldsBytes);
  const receipt = {
    version: VERSION,
    sourceHashes: {
      synthetic: hash(syntheticBytes),
      natural: hash(naturalBytes),
      meetingFolds: hash(foldsBytes),
    },
    effortFoldRule: `${VERSION}:41:effort:<group> SHA256 order, round-robin3`,
    views: views.map(({ view, holdout, counts }) => ({
      view,
      fitSha256: holdout.fitSha256,
      counts,
      foldCounts: holdout.folds.map((part) =>
        Object.fromEntries(
          (['effort', 'synthetic', 'natural'] as const).map((domain) => [
            domain,
            rows.filter((r) => domains.get(r.id) === domain && part.devGroups.includes(r.group))
              .length,
          ]),
        ),
      ),
    })),
  };
  for (const { view, bytes, holdout } of views) {
    const directory = join(output, view);
    mkdirSync(directory, { mode: 0o700 });
    write(join(directory, 'fit.jsonl'), bytes);
    write(join(directory, 'holdout.json'), `${JSON.stringify(holdout, null, 2)}\n`);
    write(join(directory, 'manifest.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  }
  write(join(output, 'manifest.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

if (import.meta.main) {
  const [synthetic, natural, folds, output, ...extra] = process.argv.slice(2);
  if (!synthetic || !natural || !folds || !output || extra.length)
    throw new Error('expected synthetic-F natural-F meeting-folds new-private-output');
  console.log(JSON.stringify(buildSftViews(synthetic, natural, folds, output)));
}
