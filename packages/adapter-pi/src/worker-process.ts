import type { Channel } from './channel.ts';

/** The worker's end of the IPC channel, inside the child process. */
export function processPort(): Channel {
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
