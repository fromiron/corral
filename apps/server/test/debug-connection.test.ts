import type { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolCancellation } from '@corral/core';
import { afterEach, expect, it, vi } from 'vitest';
import { DebugConnection } from '../src/files/debug-connection.ts';
import { spawnOwnedProcess } from '../src/processes/owned-process.ts';
import { systemClock, systemTimers } from '../src/runtime.ts';

vi.setConfig({ testTimeout: 30000 });
const directories: string[] = [];
const connections: DebugConnection[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const adapter = String.raw`
import net from 'node:net';
const mode = process.argv[2];
const socketPath = process.argv[3];
let seq = 0, root, launch;
const write = (socket, value) => {
  const body = Buffer.from(JSON.stringify({seq: ++seq, ...value}));
  socket.write('Content-Length: ' + body.length + '\r\n\r\n');
  socket.write(body);
};
const reply = (socket, request, body = {}) => write(socket, {
  type: 'response', request_seq: request.seq, command: request.command, success: true, body,
});
net.createServer(socket => {
  root ??= socket;
  let buffered = Buffer.alloc(0), configured = false, breakpoint = false;
  socket.on('data', chunk => {
    buffered = Buffer.concat([buffered, chunk]);
    while (true) {
      const index = buffered.indexOf('\r\n\r\n');
      if (index < 0) return;
      const length = Number(buffered.subarray(0,index).toString().split(':')[1]);
      if (buffered.length < index + 4 + length) return;
      const message = JSON.parse(buffered.subarray(index + 4,index + 4 + length));
      buffered = buffered.subarray(index + 4 + length);
      if (message.type !== 'request') continue;
      const {command, arguments: args} = message;
      if (command === 'initialize') {
        reply(socket,message,{supportsConfigurationDoneRequest:true,supportsCancelRequest:true});
        write(socket,{type:'event',event:'initialized'});
      } else if (command === 'setBreakpoints') {
        breakpoint = true;
        reply(socket,message,{breakpoints:[{id:1,verified:true,line:args.breakpoints[0].line}]});
      } else if (command === 'configurationDone') {
        configured = true;
        reply(socket,message);
      } else if (command === 'attach') {
        if (socket === root) {
          launch = message;
          write(socket,{type:'request',command:mode === 'unexpected' ? 'runInTerminal' : 'startDebugging',arguments:{
            request:'attach',configuration:{type:'pwa-node',name:'fixture',__pendingTargetId:'target-1'}
          }});
        } else {
          if (!breakpoint || !configured) {
            socket.destroy();
            continue;
          }
          reply(socket,message);
          reply(root,launch);
          write(socket,{type:'event',event:'stopped',body:{reason:'breakpoint',threadId:1}});
        }
      } else if (command === 'threads') {
        reply(socket,message,{threads:[{id:1,name:socket === root ? 'wrong-root' : 'fixture'}]});
      } else if (command === 'finishChild') {
        reply(socket,message);
        write(socket,{type:'event',event:'terminated'});
      } else if (command === 'oversize') {
        socket.write('Content-Length: 4194305\r\n\r\n');
      } else if (command === 'wait') {
        write(socket,{type:'event',event:'output',body:{category:'console',output:'waiting'}});
      } else if (command === 'cancel') {
        reply(socket,message);
      } else if (command === 'disconnect') {
        if (args.terminateDebuggee !== false) process.exit(2);
        reply(socket,message);
        socket.end();
      }
    }
  });
}).listen(socketPath);
`;

async function fixture(mode = 'normal', onSpawn?: () => void) {
  const cwd = mkdtempSync(join(tmpdir(), 'corral-debug-test-'));
  directories.push(cwd);
  const entry = join(cwd, 'adapter.mjs');
  writeFileSync(entry, adapter);
  const events: { event: string; body: unknown; id: string }[] = [];
  const failures: Error[] = [];
  let pid = 0;
  let socket = '';
  let waiting = () => {};
  const connection = await DebugConnection.start({
    cwd,
    argv: [process.execPath, entry, mode],
    owner: 'debug-connection-test',
    timeoutMs: 3000,
    clock: systemClock,
    timers: systemTimers,
    onSpawn(identity) {
      pid = identity.pid;
      expect(statSync(join(socket, '..')).mode & 0o777).toBe(0o700);
      onSpawn?.();
    },
    onEvent(event, body, id) {
      events.push({ event, body, id });
      if (event === 'output') waiting();
    },
    onReady: async (id) => {
      await connection.request(id, 'setBreakpoints', {
        source: { path: join(cwd, 'index.js') },
        breakpoints: [{ line: 3 }],
      });
    },
    onFailure: (error) => failures.push(error),
    spawn: (...args: Parameters<typeof spawn>) => {
      socket = (args[1] as string[]).at(-1) as string;
      return (spawnOwnedProcess as typeof spawn)(...args);
    },
  });
  connections.push(connection);
  return {
    connection,
    events,
    failures,
    pid,
    onWaiting: (fn: () => void) => {
      waiting = fn;
    },
  };
}

const config = { type: 'pwa-node', request: 'attach', address: '127.0.0.1', port: 1234 };
it.skipIf(process.platform !== 'linux')(
  '[TC-WBD-023-H] initializes reverse child connections and installs breakpoints before configurationDone',
  async () => {
    const { connection, events, pid } = await fixture();
    await connection.attach(config);
    expect(connection.capabilities.supportsConfigurationDoneRequest).toBe(true);
    const child = [...connection.sessions.keys()].find((id) => id !== 'root');
    expect(child).toBeDefined();
    expect(await connection.request(child, 'threads')).toEqual({
      threads: [{ id: 1, name: 'fixture' }],
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        event: 'stopped',
        body: { reason: 'breakpoint', threadId: 1 },
        id: child,
      }),
    );
    await connection.request(child, 'finishChild');
    await vi.waitFor(() => expect(connection.sessions.has(child as string)).toBe(false));
    expect(await connection.request('root', 'threads')).toMatchObject({ threads: [{ id: 1 }] });
    await connection.close();
    expect(() => process.kill(pid, 0)).toThrow();
  },
);

it.skipIf(process.platform !== 'linux')(
  '[TC-WBD-023-N] rejects oversized messages and unsupported reverse execution with confirmed cleanup',
  async () => {
    const large = await fixture();
    await large.connection.attach(config);
    await expect(large.connection.request('root', 'oversize')).rejects.toThrow(/limit/);
    await large.connection.close();
    expect(large.failures).toHaveLength(1);
    expect(() => process.kill(large.pid, 0)).toThrow();
    const unexpected = await fixture('unexpected');
    await expect(unexpected.connection.attach(config)).rejects.toThrow(/reverse/);
    await unexpected.connection.close();
    expect(() => process.kill(unexpected.pid, 0)).toThrow();
    await expect(
      fixture('normal', () => {
        throw new Error('storage failed');
      }),
    ).rejects.toThrow(/start/);
  },
);

it.skipIf(process.platform !== 'linux')(
  '[TC-WBD-023-F] cancels pending queries without replay and closes a pending query before releasing ownership',
  async () => {
    const { connection, onWaiting, pid, failures } = await fixture();
    await connection.attach(config);
    const controller = new AbortController();
    const cancellation: ToolCancellation = {
      get aborted() {
        return controller.signal.aborted;
      },
      onCancel(fn) {
        controller.signal.addEventListener('abort', fn);
        return () => controller.signal.removeEventListener('abort', fn);
      },
    };
    onWaiting(() => controller.abort());
    await expect(connection.request('root', 'wait', {}, cancellation)).rejects.toThrow(/cancelled/);
    expect(await connection.request('child-1', 'threads')).toMatchObject({ threads: [{ id: 1 }] });
    onWaiting(() => {});
    await expect(connection.request('root', 'wait')).rejects.toThrow(/timeout/);
    onWaiting(() => {
      void connection.close();
    });
    await expect(connection.request('root', 'wait')).rejects.toThrow(/closed/);
    await connection.close();
    expect(failures).toHaveLength(0);
    expect(() => process.kill(pid, 0)).toThrow();
  },
);
