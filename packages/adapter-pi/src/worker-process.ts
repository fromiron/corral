import type { Channel } from './channel.ts';

/** The worker's end of the IPC channel, inside the child process. */
export function processPort(): Channel {
  // A worker cannot outlive the Coordinator that owns its permissions and budget.
  process.once('disconnect', () => {
    if (process.env.CORRAL_WORKER_GROUP === '1' && process.platform !== 'win32') {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        /* Exit even if the group is already gone. */
      }
    }
    process.exit(1);
  });
  let last: Promise<void> = Promise.resolve();
  return {
    send: (frame) => {
      last = new Promise((done) => {
        if (!process.send) return done();
        process.send(frame as never, () => done());
      });
    },
    onFrame: (handler) => void process.on('message', handler),
    onExit: () => {},
    // Leave after what was already sent has reached the host.
    kill: () => void last.then(() => process.exit(0)),
  };
}
