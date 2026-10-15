import { Identifier, type IdKind } from '@corral/contracts';
import { describe, expect, it } from 'vitest';
import { FakeClock, Gate, SequentialIdFactory } from '../src/index.ts';

describe('FakeClock', () => {
  it('only moves when the test advances it', () => {
    const clock = new FakeClock('2026-10-15T00:00:00.000Z');
    expect(clock.nowIso()).toBe('2026-10-15T00:00:00.000Z');
    expect(clock.monotonicMs()).toBe(0);
    clock.advance(1500);
    expect(clock.nowIso()).toBe('2026-10-15T00:00:01.500Z');
    expect(clock.monotonicMs()).toBe(1500);
  });

  it('rejects moving backwards', () => {
    expect(() => new FakeClock('2026-10-15T00:00:00.000Z').advance(-1)).toThrow(RangeError);
  });
});

describe('SequentialIdFactory', () => {
  const kinds: IdKind[] = [
    'run',
    'event',
    'task',
    'execution',
    'model_call',
    'context_snapshot',
    'directive',
    'tool_call',
    'artifact',
    'artifact_version',
  ];

  it('numbers each kind separately and identically across instances', () => {
    const a = new SequentialIdFactory();
    const b = new SequentialIdFactory();
    const first = [a.next('run'), a.next('run'), a.next('task')];
    expect(first).toEqual(['run_0001', 'run_0002', 'task_0001']);
    expect([b.next('run'), b.next('run'), b.next('task')]).toEqual(first);
  });

  it.each(kinds)('produces valid identifiers for %s', (kind) => {
    expect(Identifier.safeParse(new SequentialIdFactory().next(kind)).success).toBe(true);
  });
});

describe('Gate', () => {
  it('holds waiters until opened', async () => {
    const gate = new Gate();
    const order: string[] = [];
    const waiting = gate.wait().then(() => order.push('released'));
    await Promise.resolve();
    expect(gate.waiting).toBe(1);
    order.push('before open');
    gate.open();
    await waiting;
    expect(order).toEqual(['before open', 'released']);
  });

  it('lets later waiters through once open', async () => {
    const gate = new Gate();
    gate.open();
    await expect(gate.wait()).resolves.toBeUndefined();
  });
});
