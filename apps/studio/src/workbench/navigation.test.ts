import { describe, expect, it } from 'vitest';
import { validateSettingsSearch, workHref } from './navigation.ts';

describe('[TC-UX-004-N] settings navigation boundaries', () => {
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
