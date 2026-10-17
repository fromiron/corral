import { fork } from 'node:child_process';
import { createServer } from 'node:net';

if (process.argv[2] === 'child') {
  const server = createServer(socket => socket.end('alive'));
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (typeof address === 'object' && address) process.send?.({ port: address.port, pid: process.pid });
  });
} else {
  process.on('message', () => process.exit(0));
  const child = fork(import.meta.filename, ['child'], { execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  child.on('message', message => process.send?.(message));
}
