/** A location a check or task reported, inside the session copy. */
export interface Problem {
  path: string;
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
}

const TSC = /^(?<path>[^\s:()]+)\((?<line>\d+),(?<column>\d+)\): (?<rest>(?:error|warning).*)$/;
const LOCATION =
  /(?:^|\s)(?:❯\s*)?(?<path>[A-Za-z0-9_@][A-Za-z0-9_./@-]*\.[A-Za-z0-9]+):(?<line>\d+):(?<column>\d+)(?::\s*(?<rest>.*))?$/;

/** Relative paths inside the copy only: no absolute, parent, dependency or Git paths. */
function inside(path: string) {
  const parts = path.split('/');
  return (
    !path.startsWith('/') &&
    !parts.includes('..') &&
    !parts.includes('node_modules') &&
    parts[0] !== '.git' &&
    parts[0] !== '.corral'
  );
}

const severity = (text: string): Problem['severity'] =>
  /^\s*warn(?:ing)?\b/i.test(text) ? 'warning' : 'error';

/** Reads tsc, vitest/jest and `path:line:col` locations from command output, in order. */
export function parseProblems(text: string, limit = 500): Problem[] {
  const seen = new Set<string>();
  const problems: Problem[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const match = TSC.exec(line.trim()) ?? LOCATION.exec(line);
    const groups = match?.groups;
    if (!groups?.path || !inside(groups.path)) continue;
    const rest = groups.rest?.trim();
    const problem: Problem = {
      path: groups.path,
      line: Number(groups.line),
      column: Number(groups.column),
      severity: rest ? severity(rest) : 'error',
      message: rest || `${groups.path}:${groups.line}:${groups.column}`,
    };
    const key = `${problem.path}:${problem.line}:${problem.column}:${problem.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push(problem);
    if (problems.length >= limit) break;
  }
  return problems;
}
