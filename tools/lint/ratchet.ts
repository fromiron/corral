// A ratchet over source files: a rule counts something per file, and a checked-in baseline holds
// the exact count of every file that has any. The check fails on any difference; --update
// rewrites the baseline to the tree as it is, unless a group's total would rise.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Group {
  name: string;
  /** Repository-relative folder. A file belongs to the first group whose folder holds it. */
  root: string;
}

export interface Rule {
  name: string;
  /** Repository-relative path of the rule's baseline JSON. */
  baseline: string;
  groups: Group[];
  /** Whether a repository-relative path is counted at all. */
  includes(path: string): boolean;
  count(path: string, text: string): number;
  messages: {
    rose(path: string, count: number, allowed: number): string;
    added(path: string, count: number): string;
    fell(path: string, count: number, allowed: number): string;
    gone(path: string): string;
  };
}

/** Group name to file path to count, files with a count of zero left out. */
export type Counts = Record<string, Record<string, number>>;

export const UPDATE_COMMAND = 'pnpm lint:update';

export function scan(rule: Rule, root: string): Counts {
  const counts: Counts = Object.fromEntries(rule.groups.map((group) => [group.name, {}]));
  const seen = new Set<string>();
  for (const group of rule.groups) {
    const folder = join(root, group.root);
    if (!existsSync(folder)) continue;
    for (const entry of readdirSync(folder, { recursive: true, encoding: 'utf8' })) {
      const path = `${group.root}/${entry.split('\\').join('/')}`;
      if (seen.has(path)) continue;
      seen.add(path);
      if (!rule.includes(path)) continue;
      const count = rule.count(path, readFileSync(join(root, path), 'utf8'));
      if (count > 0) (counts[group.name] as Record<string, number>)[path] = count;
    }
  }
  return counts;
}

function readBaseline(rule: Rule, root: string): Counts {
  const path = join(root, rule.baseline);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Counts) : {};
}

/** Keys sorted, two-space indent and a final newline: the shape Biome's formatter keeps. */
export function formatCounts(counts: Counts): string {
  const sorted = Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((group) => {
        const files = counts[group] ?? {};
        return [
          group,
          Object.fromEntries(
            Object.keys(files)
              .sort()
              .map((p) => [p, files[p]]),
          ),
        ];
      }),
  );
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

function flatten(counts: Counts): Map<string, number> {
  return new Map(Object.values(counts).flatMap((files) => Object.entries(files)));
}

const total = (files: Record<string, number> | undefined) =>
  Object.values(files ?? {}).reduce((sum, count) => sum + count, 0);

function check(rule: Rule, root: string, baseline: Counts, current: Counts): string[] {
  const before = flatten(baseline);
  const now = flatten(current);
  const lines: string[] = [];
  for (const path of [...new Set([...before.keys(), ...now.keys()])].sort()) {
    const allowed = before.get(path);
    const count = now.get(path) ?? 0;
    if (allowed === undefined) lines.push(rule.messages.added(path, count));
    else if (count > allowed) lines.push(rule.messages.rose(path, count, allowed));
    else if (count < allowed && count === 0 && !existsSync(join(root, path)))
      lines.push(rule.messages.gone(path));
    else if (count < allowed) lines.push(rule.messages.fell(path, count, allowed));
  }
  return lines;
}

function update(rule: Rule, root: string, baseline: Counts, current: Counts): string[] | null {
  const refusals: string[] = [];
  for (const group of rule.groups) {
    const was = baseline[group.name] ?? {};
    const is = current[group.name] ?? {};
    if (total(is) <= total(was)) continue;
    refusals.push(
      `${rule.name}: not updated, the ${group.name} total would rise from ${total(was)} to ${total(is)}. A rise is a hand edit in ${rule.baseline}; these files rose:`,
    );
    for (const path of Object.keys(is).sort()) {
      const from = was[path] ?? 0;
      const to = is[path] ?? 0;
      if (to > from) refusals.push(`  ${path}: ${from} → ${to}`);
    }
  }
  if (refusals.length > 0) return refusals;
  writeFileSync(join(root, rule.baseline), formatCounts(current));
  return null;
}

export interface Options {
  root: string;
  update?: boolean;
}

export function run(rules: Rule[], options: Options): { code: number; output: string } {
  const lines: string[] = [];
  let code = 0;
  for (const rule of rules) {
    const baseline = readBaseline(rule, options.root);
    const current = scan(rule, options.root);
    if (options.update) {
      const refusals = update(rule, options.root, baseline, current);
      if (refusals) {
        code = 1;
        lines.push(...refusals);
      } else {
        const totals = rule.groups.map((g) => `${g.name} ${total(current[g.name])}`);
        lines.push(`${rule.name}: ${rule.baseline} now holds ${totals.join(', ')}.`);
      }
      continue;
    }
    const problems = check(rule, options.root, baseline, current);
    if (problems.length > 0) {
      code = 1;
      lines.push(...problems);
    }
  }
  return { code, output: lines.join('\n') };
}
