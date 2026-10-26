import { describe, expect, it, vi } from 'vitest';
import { createSettingsTasks } from './settingsTasks.ts';

describe('settings operation ownership', () => {
  it('locks the submitted target through settlement while other targets remain independent', async () => {
    const tasks = createSettingsTasks();
    let finish!: () => void;
    const run = tasks.run(
      'defaults:project:a',
      '/settings/project-defaults?projectId=a',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const duplicate = vi.fn();
    await expect(
      tasks.run('defaults:project:a', '/settings/project-defaults?projectId=b', duplicate),
    ).rejects.toThrow();
    expect(duplicate).not.toHaveBeenCalled();
    await tasks.run('defaults:project:b', '/settings/project-defaults?projectId=b', async () => {});
    expect(
      tasks.store.getState().operations.find((x) => x.target === 'defaults:project:a')?.state,
    ).toBe('pending');
    finish();
    await run;
    expect(
      tasks.store.getState().operations.find((x) => x.target === 'defaults:project:a'),
    ).toMatchObject({ state: 'saved', href: '/settings/project-defaults?projectId=a' });
  });
  it('retains the original command identity when its form is reopened', () => {
    const tasks = createSettingsTasks();
    const first = tasks.command<{ id: string }>('skill:a');
    first.current = { id: 'operation-original' };
    expect(tasks.command('skill:a')).toBe(first);
    expect(tasks.command('skill:b').current).toBeNull();
    expect(JSON.stringify(tasks.store.getState())).not.toContain('operation-original');
  });
  it('keeps only a safe recovery location after failure, never submitted data or raw errors', async () => {
    const tasks = createSettingsTasks();
    await expect(
      tasks.run('provider:a', '/settings/models', async () => {
        throw new Error('secret-value');
      }),
    ).rejects.toThrow('secret-value');
    expect(JSON.stringify(tasks.store.getState())).not.toContain('secret-value');
    expect(tasks.store.getState().operations[0]?.state).toBe('uncertain');
    await tasks.run('provider:a', '/settings/models', async () => {});
    expect(tasks.store.getState().operations).toHaveLength(1);
    tasks.dismiss('provider:a');
    expect(tasks.store.getState().operations).toEqual([]);
  });
});
