import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';

const control = vi.hoisted(() => ({ release: () => {}, terminations: 0 }));
vi.mock('node:worker_threads', () => ({
  Worker: class extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit('message', { type: 'ready' }));
    }
    ref() {}
    unref() {}
    postMessage() {}
    async terminate() {
      control.terminations++;
      await new Promise<void>((resolve) => {
        control.release = resolve;
      });
      this.emit('exit', 0);
      return 0;
    }
  },
}));

it('repeated close waits for the same actual worker exit', async () => {
  const { workerSession } = await import('../src/provider.ts');
  const session = await workerSession('fixture');
  const first = session.close!();
  let closed = false;
  const second = session.close!().then(() => {
    closed = true;
  });
  try {
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(control.terminations).toBe(1);
  } finally {
    control.release();
    await Promise.all([first, second]);
  }
});
