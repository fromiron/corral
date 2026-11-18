import { describe, expect, it } from 'vitest';
import { documentTabFor } from './documentTarget.ts';

const target = (over: Partial<Parameters<typeof documentTabFor>[0]> = {}) => ({
  hostId: 'host',
  projectId: 'project',
  bindingId: 'binding',
  sessionId: 'session',
  copyGeneration: 2,
  ...over,
});
const conversation = {
  projectId: 'project',
  sessionId: 'session',
  current: { known: true, copy: { bindingId: 'binding', generation: 2 } },
};

describe('the 문서 tab a way to a file opens', () => {
  it("opens the file's tab for the conversation's current copy", () => {
    expect(documentTabFor(target(), 'src/a.ts', conversation)).toBe('document:copy:src/a.ts');
  });

  it("refuses a file of another conversation's copy (counterexample)", () => {
    expect(documentTabFor(target({ sessionId: 'other' }), 'src/a.ts', conversation)).toBeNull();
  });

  it('refuses a file of an earlier copy of this conversation (counterexample)', () => {
    expect(documentTabFor(target({ copyGeneration: 1 }), 'src/a.ts', conversation)).toBeNull();
    expect(documentTabFor(target({ bindingId: 'gone' }), 'src/a.ts', conversation)).toBeNull();
  });

  it('refuses any copy once the conversation has no Paddock (counterexample)', () => {
    const none = { ...conversation, current: { known: true, copy: null } };
    expect(documentTabFor(target(), 'src/a.ts', none)).toBeNull();
  });

  it("takes the target's own copy before the Paddock was first read", () => {
    const unread = { ...conversation, current: { known: false, copy: null } };
    expect(documentTabFor(target({ copyGeneration: 1 }), 'src/a.ts', unread)).toBe(
      'document:copy:src/a.ts',
    );
  });
});
