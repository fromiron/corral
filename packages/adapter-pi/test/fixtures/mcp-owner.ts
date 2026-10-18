import { fork } from 'node:child_process';
import { join } from 'node:path';
import { recordWorkerLease } from '../../src/worker-leases.ts';

const directory = process.env.CORRAL_WORKER_LEASE_DIR;
if (!directory) throw new Error('lease directory missing');
const child = fork(join(import.meta.dirname, 'process-group.ts'), ['child'], {
  detached: true,
  execArgv: [],
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
if (!child.pid) throw new Error('child failed');
recordWorkerLease(directory, child.pid);
child.on('message', (info) => process.send?.(info));
setInterval(() => {}, 1000);
