import { describe, expect, it } from 'vitest';
import { validateSettingsSearch, workHref } from './navigation.ts';

describe('settings navigation boundaries', () => {
  it('preserves an exact work destination and run selection through settings categories', () => {
    const returnTo = '/sessions/session_a?panel=run&run=run_old&execution=execution_a#result';
    expect(
      validateSettingsSearch({ projectId: 'project_a', returnTo, section: 'general' }),
    ).toEqual({ projectId: 'project_a', returnTo });
    expect(workHref('/corrals/team_a/edit?fromSession=session_a')).toBe(
      '/corrals/team_a/edit?fromSession=session_a',
    );
    expect(workHref('/projects/a?newSession=true&draft=true#teams')).toBe('/projects/a#teams');
  });

  it('does not turn a settings return link into an external or recursive navigation', () => {
    for (const returnTo of [
      'https://example.org',
      '//example.org',
      '/\\example.org',
      '/settings?section=general',
      '/projects/a/unknown',
      '/projects\n',
    ]) {
      expect(validateSettingsSearch({ projectId: [], returnTo })).toEqual({});
    }
    expect(validateSettingsSearch({ projectId: 'x'.repeat(257), returnTo: '/projects' })).toEqual({
      returnTo: '/projects',
    });
  });
});

describe('contextual settings navigation', () => {
  it('validates settings independently of work selection and strips only settings navigation values', async () => {
    const { validateSettingsOverlay, withoutSettings, settingsOnlyTransition } = await import(
      './navigation.ts'
    );
    expect(
      validateSettingsOverlay({ settings: 'models', settingsProject: 'a', run: 'old' }),
    ).toEqual({ settings: 'models', settingsProject: 'a' });
    expect(validateSettingsOverlay({ settings: 'bad', settingsProject: 'a' })).toEqual({});
    expect(
      withoutSettings({ settings: 'models', settingsProject: 'a', run: 'old', panel: 'changes' }),
    ).toEqual({ run: 'old', panel: 'changes' });
    const current = { pathname: '/corrals/a/edit', search: { fromSession: 'session_a' } };
    expect(
      settingsOnlyTransition(current, {
        ...current,
        search: { ...current.search, settings: 'models' },
      }),
    ).toBe(true);
    expect(
      settingsOnlyTransition(current, {
        ...current,
        pathname: '/corrals/b/edit',
        search: { settings: 'models' },
      }),
    ).toBe(false);
    expect(workHref('/sessions/a?settings=models&settingsProject=b&run=old#result')).toBe(
      '/sessions/a?run=old#result',
    );
  });
});
