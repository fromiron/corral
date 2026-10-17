import { describe, expect, it } from 'vitest';
import { refusalKind } from './refusal.ts';

// UX-04: a refused start says what to do next, in the person's language.

describe('refused start (UX-04)', () => {
  it('[TC-UX-04-H] tells a missing sign-in from a missing model and a busy runtime', () => {
    expect(
      refusalKind({
        code: 'CAPABILITY_DENIED',
        message: 'model-a: sign in to OpenAI under Settings → Models',
      }),
    ).toBe('signin');
    expect(refusalKind({ code: 'GRAPH_INVALID', message: 'model-x: no such model profile' })).toBe(
      'profile',
    );
    expect(refusalKind({ code: 'GRAPH_INVALID', message: 'openai has no model gpt-x' })).toBe(
      'profile',
    );
    expect(refusalKind({ code: 'RUN_ALREADY_ACTIVE', message: 'a run is active' })).toBe('busy');
    expect(refusalKind({ code: 'RESOURCE_CAPACITY', message: 'busy' })).toBe('busy');
    expect(refusalKind({ code: 'LIMIT_REACHED', message: 'too large' })).toBe('limit');
    expect(refusalKind({ code: 'TARGET_NOT_FOUND', message: 'run x has no version y' })).toBe(
      'reference',
    );
  });

  it('[TC-UX-04-H] reads a recorded refusal without its code from the message', () => {
    expect(refusalKind({ message: 'model-a: sign in to OpenAI under Settings → Models' })).toBe(
      'signin',
    );
    expect(refusalKind({ message: 'Choose a team before continuing.' })).toBe('other');
  });

  it('[TC-UX-04-F] calls a lost answer a network failure, not a refusal', () => {
    expect(refusalKind({ network: true, message: 'Failed to fetch' })).toBe('network');
  });
});
