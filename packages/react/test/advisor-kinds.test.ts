import type { CorralNode } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import en from '../src/messages/en.json' with { type: 'json' };
import ko from '../src/messages/ko.json' with { type: 'json' };
import { KIND_COLOR, KIND_ICON, kindOf } from '../src/team-editor/kinds.ts';

// An advisor and its advise link are named on screen before the editor can draw them
// (docs/specs/features/advisor.md).

const advisor: CorralNode = {
  id: 'advisor',
  type: 'agent',
  label: 'Advisor',
  roleId: 'advisor_role',
  invocation: 'observer',
  outputName: 'notes',
};

describe('advisor names', () => {
  it('an advisor node is its own kind, not a working agent', () => {
    expect(kindOf(advisor)).toBe('observer');
    expect(KIND_ICON.observer).toBeDefined();
    expect(KIND_COLOR.observer).toBeDefined();
  });

  it.each([
    ['en', en, 'Outrider', 'advises'],
    ['ko', ko, 'Outrider', '조언'],
  ] as const)('names the advisor and the advise link in %s', (_lang, messages, kind, link) => {
    expect(messages.TeamEditor.kinds.observer).toBe(kind);
    expect(messages.TeamEditor.links.advise).toBe(link);
    expect(messages.Canvas.linkLabel.advise).toBe(link);
    expect(messages.Canvas.ports.advise).toBeTruthy();
    expect(messages.Validation.codes.ADVISOR_UNWATCHED).toBeTruthy();
    expect(messages.Validation.codes).not.toHaveProperty('ADVISOR_NOT_SUPPORTED');
  });
});
