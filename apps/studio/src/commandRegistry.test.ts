import { RunEvent } from '@corral/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  harnessCommands,
  registeredCommands,
  runShortcut,
  setCommands,
} from './commandRegistry.ts';

// Workbench polish P2/P4: one list of commands for `/`, ⌘K, menus and shortcuts.

describe('command registry', () => {
  it('extension commands retain their target and package alias and cannot run after startup', () => {
    const event = RunEvent.parse({
      schemaVersion: '0.1',
      eventId: 'event_1',
      runId: 'run_1',
      runSeq: 1,
      recordedAt: '2026-10-18T00:00:00.000Z',
      actor: { kind: 'runtime', id: 'runtime' },
      causedByEventIds: [],
      executionId: 'exec_1',
      type: 'harness.loaded',
      payload: {
        snapshotHash: 'a'.repeat(64),
        tools: [],
        diagnostics: [],
        commands: [
          {
            name: 'pause',
            invocation: 'pause',
            alias: 'fixture:pause',
            source: 'extension:fixture@1.0.0',
            description: 'Mode',
            condition: 'startup',
          },
        ],
      },
    });
    const commands = harnessCommands([event], 'Extensions', 'Startup only');
    expect(commands).toMatchObject([
      {
        source: 'extension',
        targetExecutionId: 'exec_1',
        condition: 'startup',
        slash: 'fixture:pause',
        disabled: true,
        hint: 'Startup only',
      },
    ]);
    expect(commands[0]?.id).toContain('run_1:exec_1');
  });
  it('keeps the same list when only the functions change, and runs the newest one', () => {
    const first = vi.fn();
    const second = vi.fn();
    setCommands('test', [{ id: 'a', title: 'A', group: 'G', shortcutId: 'run.stop', run: first }]);
    const before = registeredCommands();
    setCommands('test', [{ id: 'a', title: 'A', group: 'G', shortcutId: 'run.stop', run: second }]);
    expect(registeredCommands()).toBe(before);
    expect(runShortcut('run.stop')).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
    setCommands('test', null);
  });

  it('publishes a new list when a title or availability changes, and skips disabled commands', () => {
    const run = vi.fn();
    setCommands('test', [{ id: 'a', title: 'A', group: 'G', shortcutId: 'run.stop', run }]);
    const before = registeredCommands();
    setCommands('test', [
      { id: 'a', title: 'A', group: 'G', shortcutId: 'run.stop', disabled: true, run },
    ]);
    expect(registeredCommands()).not.toBe(before);
    expect(runShortcut('run.stop')).toBe(false);
    expect(run).not.toHaveBeenCalled();
    setCommands('test', null);
    expect(registeredCommands()).toEqual([]);
  });

  it('passes the digit to a jump command', () => {
    const jump = vi.fn();
    setCommands('test', [
      { id: 'j', title: 'Jump', group: 'G', shortcutId: 'session.jump', run: () => {}, jump },
    ]);
    expect(runShortcut('session.jump', 3)).toBe(true);
    expect(jump).toHaveBeenCalledWith(3);
    setCommands('test', null);
  });
});
