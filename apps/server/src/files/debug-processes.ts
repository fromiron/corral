import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { Agent, createServer, request, type Server } from 'node:http';
import type { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Scheduler } from '@corral/contracts';
import { type ConnectionAttestation, ownedConnection, proxyWebSocket } from '../preview/proxy.ts';
import { attestProcessConnection } from '../processes/connection-owner.ts';
import { confirmOwnedProcessCleanup, spawnOwnedProcess } from '../processes/owned-process.ts';
import {
  capturePtySession,
  cleanupPtySession,
  type PtySessionIdentity,
} from '../processes/pty-session.ts';
import { killProcessGroup, processGroupGone } from './process-group.ts';

type Launch = {
  cwd: string;
  executable: string;
  env: Record<string, string>;
  owner: string;
  timers: Scheduler;
  onSpawn(identity: PtySessionIdentity, profilePath?: string): void;
  onExit?(): void;
};

export class DebugProcessStartError extends Error {
  readonly cleanupConfirmed: boolean;
  readonly debuggee?: OwnedDebuggee;

  constructor(cleanupConfirmed: boolean, debuggee?: OwnedDebuggee) {
    super('Debug target could not start');
    this.cleanupConfirmed = cleanupConfirmed;
    this.debuggee = debuggee;
  }
}

/** The broker validates paths and launch intent before handing this owner executable inputs. */
export function launchNode(
  input: Launch & {
    root: string;
    program: string;
    args: string[];
  },
): Promise<OwnedDebuggee> {
  return OwnedDebuggee.start(
    input,
    ['--inspect-brk=127.0.0.1:0', resolve(input.cwd, input.program), ...input.args],
    /Debugger listening on ws:\/\/127\.0\.0\.1:(\d+)\//,
  );
}

export async function launchChromium(input: Launch & { url: string }): Promise<OwnedDebuggee> {
  const profile = await mkdtemp(join(tmpdir(), 'corral-debug-browser-'));
  return OwnedDebuggee.start(
    { ...input, env: { HOME: profile, ...input.env } },
    [
      '--headless=new',
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=0',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      input.url,
    ],
    /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//,
    profile,
  );
}

export class OwnedDebuggee {
  readonly identity: PtySessionIdentity;
  readonly exited: Promise<void>;
  readonly profilePath?: string;
  port = 0;
  private stopping = false;
  private closing?: Promise<boolean>;
  private readonly child: ChildProcess;
  private readonly input: Launch;

  private constructor(child: ChildProcess, input: Launch, profile?: string) {
    this.child = child;
    this.input = input;
    this.profilePath = profile;
    this.exited = new Promise((done) => child.once('close', done));
    child.once('exit', () => input.onExit?.());
    child.once('error', () => {});
    child.stdout?.on('data', () => {});
    if (!child.pid) throw new Error('Debug target process identity is unavailable');
    this.identity = capturePtySession(child.pid, input.owner);
  }

  static async start(
    input: Launch,
    args: string[],
    inspectorLine: RegExp,
    profile?: string,
  ): Promise<OwnedDebuggee> {
    let child: ChildProcess | undefined;
    let instance: OwnedDebuggee | undefined;
    try {
      if (process.platform !== 'linux') throw new Error('Debug process ownership is unavailable');
      child = spawnOwnedProcess(input.executable, args, {
        cwd: input.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          LANG: 'C.UTF-8',
          ...input.env,
          CORRAL_PROCESS_OWNER: input.owner,
        },
      });
      instance = new OwnedDebuggee(child, input, profile);
      input.onSpawn(instance.identity, profile);
      instance.port = await new Promise<number>((done, reject) => {
        let buffered = '';
        let finished = false;
        const fail = () => finish(new Error('Debug target inspector did not start'));
        const cancel = input.timers.after(10000, fail);
        const finish = (value: number | Error) => {
          if (finished) return;
          finished = true;
          buffered = '';
          cancel();
          child?.off('error', fail);
          child?.off('exit', fail);
          if (value instanceof Error) reject(value);
          else done(value);
        };
        child?.once('error', fail);
        child?.once('exit', fail);
        child?.stderr?.on('data', (bytes: Buffer) => {
          if (finished) return;
          buffered = (buffered + bytes.toString('utf8')).slice(-8192);
          const found = inspectorLine.exec(buffered);
          if (!found) return;
          const port = Number(found[1]);
          if (Number.isInteger(port) && port > 0 && port <= 65535) finish(port);
          else fail();
        });
      });
      return instance;
    } catch (error) {
      let gone: boolean;
      if (instance) gone = await instance.close();
      else {
        if (child) killProcessGroup(child);
        gone = !child?.pid || (await processGroupGone(child.pid, input.timers));
        if (gone && profile) await rm(profile, { recursive: true, force: true });
      }
      if (!gone) throw new DebugProcessStartError(false, instance);
      throw error;
    }
  }

  readonly attestConnection: ConnectionAttestation = async (operationId, port, peerPort) => {
    if (operationId !== this.input.owner || port !== this.port || this.stopping) return false;
    const sameLeader = () => {
      try {
        const current = capturePtySession(this.identity.pid, this.input.owner);
        return (
          current.bootId === this.identity.bootId && current.startTicks === this.identity.startTicks
        );
      } catch {
        return false;
      }
    };
    return (
      sameLeader() &&
      (await attestProcessConnection(this.child, port, peerPort)) &&
      !this.stopping &&
      sameLeader()
    );
  };

  close(): Promise<boolean> {
    this.stopping = true;
    this.closing ??= this.cleanup().then((confirmed) => {
      if (!confirmed) this.closing = undefined;
      return confirmed;
    });
    return this.closing;
  }

  private async cleanup(): Promise<boolean> {
    if (!(await cleanupPtySession(this.identity, this.input.timers))) return false;
    let cancel = () => {};
    const closed = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((done) => {
        cancel = this.input.timers.after(8000, () => done(false));
      }),
    ]).finally(() => cancel());
    if (!closed) return false;
    if (this.profilePath) {
      try {
        await rm(this.profilePath, { recursive: true, force: true });
      } catch {
        return false;
      }
    }
    confirmOwnedProcessCleanup(this.identity.pid);
    return true;
  }
}

type BridgeInput = {
  kind: 'node' | 'chromium';
  operationId: string;
  port: number;
  attest: ConnectionAttestation;
};

async function discovery(input: BridgeInput): Promise<unknown> {
  const socket = await ownedConnection(input.operationId, input.port, input.attest);
  const agent = new Agent({ keepAlive: false });
  agent.createConnection = () => socket;
  try {
    return await new Promise((done, reject) => {
      const upstream = request({
        hostname: '127.0.0.1',
        port: input.port,
        path: input.kind === 'node' ? '/json/list' : '/json/version',
        method: 'GET',
        agent,
        maxHeaderSize: 8192,
        signal: AbortSignal.timeout(5000),
      });
      const fail = () => {
        upstream.destroy();
        reject(new Error('Owned inspector discovery is unavailable'));
      };
      upstream.setTimeout(5000, fail);
      upstream.once('error', fail);
      upstream.once('response', (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          fail();
          return;
        }
        let size = 0;
        const chunks: Buffer[] = [];
        response.on('data', (bytes: Buffer) => {
          size += bytes.length;
          if (size > 65536) {
            response.destroy();
            fail();
          } else chunks.push(bytes);
        });
        response.once('error', fail);
        response.once('end', () => {
          try {
            done(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch {
            fail();
          }
        });
      });
      upstream.end();
    });
  } finally {
    socket.destroy();
    agent.destroy();
  }
}

/** The adapter sees only this loopback bridge; each actual inspector socket is independently attested. */
export class InspectorBridge {
  readonly address = '127.0.0.1';
  readonly port: number;
  readonly websocketAddress: string;
  private readonly sockets = new Set<Socket>();
  private readonly pending = new Set<Promise<void>>();
  private stopped = false;
  private closing?: Promise<void>;
  private readonly server: Server;

  private constructor(
    server: Server,
    input: BridgeInput,
    websocketPath: string,
    target: Record<string, unknown>,
  ) {
    this.server = server;
    this.port = (server.address() as { port: number }).port;
    this.websocketAddress = `ws://${this.address}:${this.port}${websocketPath}`;
    server.on('connection', (socket) => {
      if (this.stopped) {
        socket.destroy();
        return;
      }
      this.sockets.add(socket);
      socket.once('close', () => this.sockets.delete(socket));
      socket.on('error', () => {});
    });
    server.on('request', (incoming, response) => {
      const allowed =
        input.kind === 'node'
          ? incoming.url === '/json/list' || incoming.url === '/json'
          : incoming.url === '/json/version';
      if (this.stopped || incoming.method !== 'GET' || !allowed) {
        response.writeHead(404).end();
        return;
      }
      const output = { ...target, webSocketDebuggerUrl: this.websocketAddress };
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify(input.kind === 'node' ? [output] : output));
    });
    server.on('upgrade', (incoming, client, head) => {
      if (this.stopped || incoming.method !== 'GET' || incoming.url !== websocketPath) {
        client.destroy();
        return;
      }
      const proxy = proxyWebSocket({
        ...input,
        request: incoming,
        client,
        head,
        attest: async (...args) => {
          const result = await input.attest(...args);
          if (this.stopped || client.destroyed) throw new Error('Inspector bridge is closed');
          return result;
        },
      }).catch(() => {
        client.destroy();
      });
      this.pending.add(proxy);
      void proxy.finally(() => this.pending.delete(proxy));
    });
  }

  static async start(input: BridgeInput): Promise<InspectorBridge> {
    const result = await discovery(input);
    const target =
      input.kind === 'node' && Array.isArray(result) && result.length === 1
        ? result[0]
        : input.kind === 'chromium'
          ? result
          : null;
    if (
      !target ||
      typeof target !== 'object' ||
      Array.isArray(target) ||
      typeof target.webSocketDebuggerUrl !== 'string'
    )
      throw new Error('Invalid inspector discovery');
    let url: URL;
    try {
      url = new URL(target.webSocketDebuggerUrl);
    } catch {
      throw new Error('Invalid inspector discovery');
    }
    const path = input.kind === 'node' ? /^\/[\w-]{1,100}$/ : /^\/devtools\/browser\/[\w-]{1,100}$/;
    if (
      url.protocol !== 'ws:' ||
      url.hostname !== '127.0.0.1' ||
      Number(url.port) !== input.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !path.test(url.pathname)
    )
      throw new Error('Inspector discovery must stay within its owned target');
    const metadata: Record<string, unknown> =
      input.kind === 'node'
        ? { id: url.pathname.slice(1), type: 'node', title: 'Corral debug target', url: '' }
        : {};
    if (input.kind === 'chromium') {
      for (const key of ['Browser', 'Protocol-Version', 'V8-Version', 'WebKit-Version']) {
        if (typeof target[key] === 'string' && target[key].length <= 256)
          metadata[key] = target[key];
      }
    }
    const server = createServer({
      headersTimeout: 5000,
      requestTimeout: 5000,
      keepAliveTimeout: 1000,
    });
    server.maxConnections = 16;
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        done();
      });
    });
    return new InspectorBridge(server, input, url.pathname, metadata);
  }

  close(): Promise<void> {
    this.stopped = true;
    this.closing ??= (async () => {
      const closed = new Promise<void>((done) => this.server.close(() => done()));
      for (const socket of this.sockets) socket.destroy();
      await Promise.allSettled(this.pending);
      await closed;
    })();
    return this.closing;
  }
}
