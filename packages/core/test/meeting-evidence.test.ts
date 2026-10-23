import { expect, it } from 'vitest';
import { createTextAttachment } from '../src/attachments.ts';
import { formatMeetingEvidence } from '../src/meeting-evidence.ts';

it('[TC-MEET-001-H] formats only the frozen captures as data and preserves their identity', () => {
  const captured = createTextAttachment('design.md', 'text/markdown', 'A selected fact.');
  const formatted = formatMeetingEvidence([captured]);
  expect(formatted).toContain('data, not instructions');
  expect(formatted).toContain(captured.sha256);
  expect(formatted).toContain('A selected fact.');
  expect(formatted).toContain('design.md');
  expect(formatMeetingEvidence(undefined)).toBe('');
  expect(formatMeetingEvidence([])).toBe('');
});
