import type { Channel } from './channel.ts';
import { isProcessCapacityFrame } from './processes/capacity.ts';

/** The worker's end of the IPC channel, inside the child process. */
export function processPort(): Channel {
  let finishing = false;
  // A worker cannot outlive the Coordinator that owns its permissions and budget.
  process.once('disconnect', () => {
    if (finishing) return;
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
    onFrame: (handler) =>
      void process.on('message', (frame: unknown) => {
        if (!isProcessCapacityFrame(frame)) handler(frame);
      }),
    onExit: () => {},
    // Leave after what was already sent has reached the host.
    // Let pending HTTP/IPC close callbacks drain before native teardown. Forcing exit
    // during Windows HTTP/IPC teardown can trigger a native libuv assertion.
    kill: () =>
      void last.then(() => {
        if (finishing) return;
        finishing = true;
        process.exitCode = 0;
        if (process.connected) process.disconnect();
        // A trusted extension may leave a timer behind; completion still has a bound.
        setTimeout(() => process.exit(0), 1000).unref();
      }),
  };
}
