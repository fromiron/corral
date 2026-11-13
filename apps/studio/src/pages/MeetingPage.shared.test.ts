import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';

// features/composer-flow.md "화면 틀": a meeting uses the conversation's frame and composer. The
// meeting page renders the very component the conversation renders, from the same module, and
// builds no composer of its own.

const pages = import.meta.dirname;
const meetingPage = resolve(pages, 'MeetingPage.tsx');
const workTab = resolve(pages, '../workbench/session/WorkTab.tsx');

/** The module a file imports `name` from, resolved to its path. */
function importOf(file: string, name: string) {
  const source = readFileSync(file, 'utf8');
  for (const [, names = '', from = ''] of source.matchAll(
    /^import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*'([^']+)';/gm,
  )) {
    const imported = names.split(',').map((item) => item.trim().replace(/^type\s+/, ''));
    if (imported.includes(name)) return resolve(dirname(file), from);
  }
  return null;
}

it('the meeting renders the conversation’s composer and timeline, from the same modules', () => {
  expect(importOf(meetingPage, 'Composer')).toBe(
    resolve(pages, '../workbench/session/Composer.tsx'),
  );
  expect(importOf(meetingPage, 'Composer')).toBe(importOf(workTab, 'Composer'));
  expect(importOf(meetingPage, 'ChatView')).toBe(resolve(pages, '../workbench/ChatView.tsx'));
  expect(importOf(meetingPage, 'ChatView')).toBe(importOf(workTab, 'ChatView'));
});

it('the meeting page builds no input, recipients row or send keys of its own', () => {
  const source = readFileSync(meetingPage, 'utf8');
  expect(source).not.toMatch(/\bInputMessage\b/);
  expect(source).not.toMatch(/\bMeetingComposer\b/);
  expect(source).not.toMatch(/\bMeetingRecipients\b/);
  expect(source).not.toMatch(/\bisSendKey\b/);
  expect(source).toMatch(/<Composer\b[^>]*\bmeeting=/s);
});
