import { expect, it } from 'vitest';
import { CommandError } from '../src/index.ts';

// A refusal over a holder names it (api-contract.md 오류): another run, a task or a terminal.
it.each(['run', 'task', 'terminal'] as const)('a refusal can name a %s as the holder', (kind) => {
  const refusal = {
    code: 'RUN_ALREADY_ACTIVE',
    message: 'the working copy is held',
    owner: { kind, id: 'holder', sessionId: 'session_1', state: 'active' },
  };
  expect(CommandError.safeParse(refusal).success).toBe(true);
});
