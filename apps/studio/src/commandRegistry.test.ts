import { describe, expect, it, vi } from 'vitest';
import { registeredCommands, runShortcut, setCommands } from './commandRegistry.ts';

// Workbench polish P2/P4: one list of commands for `/`, ⌘K, menus and shortcuts.

describe('command registry', () => {
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
