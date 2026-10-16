import { describe, expect, it } from 'vitest';
import { type Command, rankCommands } from './commands.ts';

const commands: Command[] = [
  { id: 'new', title: 'New Corral', group: 'Create', run: () => {} },
  {
    id: 'tpl-team',
    title: 'New Corral from template: Research team',
    group: 'Create',
    run: () => {},
  },
  { id: 'models', title: 'Model settings', group: 'Go to', run: () => {} },
  {
    id: 'run-1',
    title: 'Open run run_0001',
    group: 'Runs',
    keywords: ['succeeded'],
    run: () => {},
  },
];

describe('command ranking (UX-A5)', () => {
  it('[TC-UX-001-H] matches words in any order, prefers title starts, and keeps all commands for an empty query', () => {
    expect(rankCommands('', commands).map((c) => c.id)).toEqual([
      'new',
      'tpl-team',
      'models',
      'run-1',
    ]);
    expect(rankCommands('team research', commands).map((c) => c.id)).toEqual(['tpl-team']);
    expect(rankCommands('new', commands).map((c) => c.id)).toEqual(['new', 'tpl-team']);
    expect(rankCommands('succ', commands).map((c) => c.id)).toEqual(['run-1']);
  });

  it('[TC-UX-001-N] is case and accent insensitive and returns nothing for an unmatched word', () => {
    expect(rankCommands('MODEL', commands).map((c) => c.id)).toEqual(['models']);
    expect(rankCommands('modèl', commands).map((c) => c.id)).toEqual(['models']);
    expect(rankCommands('xyz', commands)).toEqual([]);
  });
});
