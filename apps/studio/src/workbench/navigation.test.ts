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

describe('list screens outside a project', () => {
  it('host the settings dialog and can be returned to, without matching lookalike paths', () => {
    expect(workHref('/inbox?settings=models&settingsProject=a')).toBe('/inbox');
    for (const view of ['', '/teams', '/agents', '/skills', '/templates', '/resources'])
      expect(workHref(`/library${view}?project=a#list`)).toBe(`/library${view}?project=a#list`);
    expect(workHref('/preview')).toBe('/preview');
    expect(workHref('/preview/pr-review?newSession=true')).toBe('/preview/pr-review');
    expect(validateSettingsSearch({ returnTo: '/library/resources' })).toEqual({
      returnTo: '/library/resources',
    });
    for (const lookalike of [
      '/inboxes',
      '/inbox/a',
      '/library/unknown',
      '/library/teams/a',
      '/libraries',
      '/preview/a/b',
      '/previews',
      '//inbox',
    ])
      expect(workHref(lookalike)).toBeUndefined();
  });
});

// features/library.md: Manage opens the dialog with the resource chosen. The resource rides in
// history state, never in the address, and only the dialog entry that Manage opened carries it.
describe('the resource Manage chooses', () => {
  it('rides in history state beside the dialog owner, not in the address', async () => {
    const { settingsOpenState, settingsItemOf } = await import('./navigation.ts');
    const opened = settingsOpenState(
      { __TSR_index: 4, key: 'k' },
      { overlay: false, owner: 'owner_a', oneShot: false, item: 'hash_1:skills/SKILL.md' },
    );
    expect(opened).toEqual({
      __TSR_index: 4,
      key: 'k',
      settingsOwner: 'owner_a',
      settingsOrigin: 4,
      settingsOneShot: false,
      settingsItem: 'hash_1:skills/SKILL.md',
    });
    expect(settingsItemOf(opened)).toBe('hash_1:skills/SKILL.md');
    expect(validateSettingsSearch(opened as unknown as Record<string, unknown>)).toEqual({});
    const { validateSettingsOverlay } = await import('./navigation.ts');
    expect(
      validateSettingsOverlay({ settings: 'skills', settingsItem: 'hash_1:skills/SKILL.md' }),
    ).toEqual({ settings: 'skills' });
  });

  it('is absent when the link names no resource, as the Add of an empty group does', async () => {
    const { settingsOpenState, settingsItemOf } = await import('./navigation.ts');
    const opened = settingsOpenState(
      { __TSR_index: 1 },
      { overlay: false, owner: 'owner_a', oneShot: true },
    );
    expect(opened).not.toHaveProperty('settingsItem');
    expect(settingsItemOf(opened)).toBeUndefined();
  });

  it('does not follow a section change inside the dialog to the other section', async () => {
    const { settingsOpenState, settingsItemOf } = await import('./navigation.ts');
    const inDialog = {
      __TSR_index: 5,
      settingsOwner: 'owner_a',
      settingsOrigin: 4,
      settingsOneShot: false,
      settingsItem: 'docs',
    };
    const switched = settingsOpenState(inDialog, {
      overlay: true,
      owner: 'owner_b',
      oneShot: true,
    });
    expect(settingsItemOf(switched)).toBeUndefined();
    // The dialog keeps the owner it was opened with, so closing still goes back one step.
    expect(switched).toMatchObject({
      settingsOwner: 'owner_a',
      settingsOrigin: 4,
      settingsOneShot: false,
    });
  });

  it('is dropped when the dialog closes or switches project', async () => {
    const { settingsClosedState, withoutSettingsItem, settingsItemOf } = await import(
      './navigation.ts'
    );
    const inDialog = {
      __TSR_index: 5,
      key: 'k',
      settingsOwner: 'owner_a',
      settingsOrigin: 4,
      settingsOneShot: true,
      settingsItem: 'docs',
    };
    expect(settingsClosedState(inDialog)).toEqual({ __TSR_index: 5, key: 'k' });
    const otherProject = withoutSettingsItem(inDialog);
    expect(settingsItemOf(otherProject)).toBeUndefined();
    expect(otherProject).toMatchObject({ settingsOwner: 'owner_a', settingsOrigin: 4 });
  });

  it('reads only a bounded string', async () => {
    const { settingsItemOf } = await import('./navigation.ts');
    for (const settingsItem of [undefined, '', 3, ['docs'], 'x'.repeat(1025)])
      expect(settingsItemOf({ __TSR_index: 0, settingsItem })).toBeUndefined();
    expect(settingsItemOf(undefined)).toBeUndefined();
  });
});
