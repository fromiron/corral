import { describe, expect, it } from 'vitest';
import {
  autoChoiceFor,
  autoCommandSeed,
  autoNotReady,
  reasoningFrom,
  reasoningValue,
  sessionRunMode,
} from './autoChoice.ts';
import type { ProfileInfo } from './useModels.ts';

// CR-024: sessions run live wherever live is possible; auto sessions use one model and
// reasoning for the choice and every role.

const profiles: ProfileInfo[] = [
  { profileId: 'model-a', label: 'OpenAI · a', available: false },
  { profileId: 'model-b', label: 'OpenAI · b', available: true },
];

describe('session run mode (CR-024)', () => {
  it('[TC-AUTO-004-H] a server with live models runs sessions live; there is no choice to make', () => {
    expect(sessionRunMode('server', true)).toBe('live');
  });

  it('[TC-AUTO-004-N] simulation stays only where live is impossible, and a disconnected model blocks instead of simulating', () => {
    expect(sessionRunMode('server', false)).toBe('mock');
    expect(sessionRunMode('browser', false)).toBe('mock');
    expect(autoNotReady({ modelProfile: 'model-a' }, profiles, 'live')).toBe(true);
    expect(autoNotReady({ modelProfile: 'model-x' }, profiles, 'live')).toBe(true);
    expect(autoNotReady({ modelProfile: 'model-b' }, profiles, 'live')).toBe(false);
    expect(autoNotReady({ modelProfile: 'model-a' }, null, 'mock')).toBe(false);
  });
});

describe('the auto model choice (CR-024)', () => {
  it('[TC-AUTO-001-H] a saved choice wins; otherwise the first connected model', () => {
    const saved = { modelProfile: 'model-a', reasoning: { mode: 'auto' as const } };
    expect(autoChoiceFor(saved, profiles)).toEqual(saved);
    expect(autoChoiceFor(null, profiles)).toEqual({ modelProfile: 'model-b' });
    expect(autoChoiceFor(null, [profiles[0] as ProfileInfo])).toEqual({ modelProfile: 'model-a' });
    // The demo has no profiles; its simulated agents use the default profile.
    expect(autoChoiceFor(null, null)).toEqual({ modelProfile: 'model-a' });
  });

  it('[TC-AUTO-003-N] a request sent with one model is a different command from the same text with another', () => {
    const a = autoCommandSeed('Hello', [], { modelProfile: 'model-a' });
    expect(autoCommandSeed('Hello', [], { modelProfile: 'model-a' })).toBe(a);
    expect(autoCommandSeed('Hello', [], { modelProfile: 'model-b' })).not.toBe(a);
    expect(
      autoCommandSeed('Hello', [], { modelProfile: 'model-a' }, { taskScope: 'review_only' }),
    ).not.toBe(a);
    expect(
      autoCommandSeed('Hello', [], {
        modelProfile: 'model-a',
        reasoning: { mode: 'fixed', level: 'high' },
      }),
    ).not.toBe(a);
  });
});

describe('per-request reasoning (CR-024 §7)', () => {
  it('[TC-AUTO-005-H] the reasoning chip round-trips route, modes and levels', () => {
    for (const policy of [
      { mode: 'route' as const },
      { mode: 'auto' as const },
      { mode: 'provider_default' as const },
      { mode: 'fixed' as const, level: 'low' as const },
    ])
      expect(reasoningFrom(reasoningValue(policy))).toEqual(policy);
    expect(reasoningValue(undefined)).toBe('');
    expect(reasoningFrom('')).toBeUndefined();
  });

  it('[TC-AUTO-005-N] choosing per request is a different command from a fixed level', () => {
    expect(
      autoCommandSeed('Hi', [], { modelProfile: 'model-a', reasoning: { mode: 'route' } }),
    ).not.toBe(
      autoCommandSeed('Hi', [], {
        modelProfile: 'model-a',
        reasoning: { mode: 'fixed', level: 'medium' },
      }),
    );
  });
});
