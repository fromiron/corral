import type { AdviceSeverity } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { resolveDelivery } from '../src/advisor/channel.ts';

describe('advice delivery', () => {
  const live = (interruptible: boolean) => ({ terminal: false, interruptible });
  const done = { terminal: true, interruptible: false };

  it.each([
    ['nit', true, { delivery: 'next_request' }],
    ['nit', false, { delivery: 'next_request' }],
    ['concern', true, { delivery: 'next_request' }],
    ['concern', false, { delivery: 'next_request' }],
    ['blocker', true, { delivery: 'interrupt' }],
    ['blocker', false, { delivery: 'next_request' }],
  ] as const)(
    'a %s for a live target (interruptible %s) is %j',
    (severity, interruptible, expected) => {
      expect(resolveDelivery({ severity, target: live(interruptible) })).toEqual(expected);
    },
  );

  it.each([
    ['nit', { suppressed: 'target_terminal' }],
    ['concern', { delivery: 'preserve' }],
    ['blocker', { delivery: 'preserve' }],
  ] as const)('a %s for a finished target is %j', (severity, expected) => {
    expect(resolveDelivery({ severity, target: done })).toEqual(expected);
  });

  it('never interrupts a finished target even if it claims to be interruptible', () => {
    const severities: AdviceSeverity[] = ['nit', 'concern', 'blocker'];
    for (const severity of severities) {
      const result = resolveDelivery({ severity, target: { terminal: true, interruptible: true } });
      expect(result).not.toEqual({ delivery: 'interrupt' });
      expect(result).not.toEqual({ delivery: 'next_request' });
    }
  });
});
