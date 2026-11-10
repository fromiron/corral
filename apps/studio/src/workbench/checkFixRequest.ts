import type { VerificationResultView } from '@corral/client';
import { commandLine } from './commandLine.ts';

// "Draft a fix request" from a failed check: the check's name, command, result and the end of
// its displayed output, as one text for the composer. It is put in the composer only; nothing is
// sent (workbench.md).

export const FIX_REQUEST_LINES = 40;
export const FIX_REQUEST_CHARS = 4000;

/** The last lines of an output, capped by line count and then by characters on whole lines. */
export function outputSummary(
  output: string,
  { lines = FIX_REQUEST_LINES, chars = FIX_REQUEST_CHARS }: { lines?: number; chars?: number } = {},
) {
  const all = output.replace(/\n+$/, '').split('\n');
  let tail = all.slice(-lines);
  while (tail.length > 1 && tail.join('\n').length > chars) tail = tail.slice(1);
  const text = tail.join('\n');
  return {
    text: text.length > chars ? text.slice(-chars) : text,
    shown: tail.length,
    total: all.length,
  };
}

function fenced(text: string) {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((run) => run[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}

export function fixRequestText(result: VerificationResultView): string {
  const summary = outputSummary(result.output);
  return [
    `Fix the failing check "${result.name}".`,
    `Command: ${commandLine(result.argv)}`,
    result.timedOut
      ? 'Result: Timed out'
      : `Exit code: ${result.exitCode ?? result.signal ?? 'none'}`,
    summary.text
      ? summary.shown < summary.total
        ? `Output (last ${summary.shown} of ${summary.total} lines):`
        : 'Output:'
      : 'Output: none',
    ...(summary.text ? [fenced(summary.text)] : []),
  ].join('\n');
}

/** An attachment name for the request: no path separators or control characters. */
export function fixRequestName(check: string) {
  const name = check.replace(/[/\\\p{Cc}]+/gu, '-').trim() || 'check';
  return `fix ${name}`.slice(0, 116).concat('.md');
}
