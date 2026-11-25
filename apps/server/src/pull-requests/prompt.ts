import type { PullRequestDraftInput } from './service.ts';

export function limitSection(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  // Half an emoji serializes to a lone surrogate escape, which provider JSON parsers reject.
  const last = value.charCodeAt(maxChars - 1);
  const truncated = value.slice(0, last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars);
  return `${truncated}\n\n[truncated]`;
}

export const PULL_REQUEST_SYSTEM_PROMPT = [
  'You write source control change request content.',
  'Return a JSON object with keys: title, body.',
  'Rules:',
  '- title should be concise and specific',
  "- body must be markdown and include headings '## Summary' and '## Testing'",
  '- under Summary, provide short bullet points',
  "- under Testing, include bullet points with concrete checks or 'Not run' where appropriate",
  '- never copy absolute local paths into the body; reviewers cannot open them',
].join('\n');

export function pullRequestPrompt(input: PullRequestDraftInput): string {
  return [
    `Base branch: ${input.base}`,
    `Head branch: ${input.head}`,
    '',
    'Commits:',
    limitSection(input.commits, 12_000),
    '',
    'Diff stat:',
    limitSection(input.diffStat, 12_000),
    '',
    'Diff patch:',
    limitSection(input.diff, 40_000),
    '',
    'Now write the title and body for these code changes.',
  ].join('\n');
}
