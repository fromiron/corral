import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, isAbsolute } from 'node:path';

/** A registration is an identity, not a copy of the remote workspace or its credentials. */
export interface RemoteHost {
  id: string;
  name: string;
  sshAlias: string;
  port: number;
  targetFingerprint?: string;
}

const aliasPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const idPattern = /^host_[0-9a-f-]{36}$/;
const validPort = (port: unknown): port is number =>
  Number.isInteger(port) && Number(port) >= 1024 && Number(port) <= 65535;

export function parseRemoteHostImport(value: unknown): {
  name: string;
  sshAlias: string;
  port: number;
  bootstrapUrl?: string;
} {
  if (!value || typeof value !== 'object') throw new Error('Invalid host registration.');
  const input = value as Record<string, unknown>;
  if (
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 120 ||
    [...input.name].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    typeof input.sshAlias !== 'string' ||
    !aliasPattern.test(input.sshAlias) ||
    !validPort(input.port)
  )
    throw new Error('A name, SSH config alias and loopback port (1024–65535) are required.');
  const registration = {
    name: input.name.trim(),
    sshAlias: input.sshAlias,
    port: input.port,
  };
  if (input.bootstrapUrl === undefined) return registration;
  return { ...registration, bootstrapUrl: remoteBootstrapUrl(input.bootstrapUrl, input.port) };
}

/** The token stays in memory and the URL fragment; never serialize it in the registry. */
export function remoteBootstrapUrl(value: unknown, port: number): string {
  try {
    if (typeof value !== 'string' || value.length > 1024) throw new Error();
    const url = new URL(value);
    if (
      url.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.port !== String(port) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      !/^#bootstrap=[a-zA-Z0-9_-]{43}$/.test(url.hash)
    )
      throw new Error();
    return `http://127.0.0.1:${port}/${url.hash}`;
  } catch {
    throw new Error('Use the remote Corral loopback bootstrap link for the registered port.');
  }
}

export function remotePartition(host: RemoteHost): string {
  if (!idPattern.test(host.id)) throw new Error('Invalid host identity.');
  return `persist:corral-${host.id}`;
}

export function remoteRequestAllowed(
  url: string,
  origin: string,
  connected: boolean,
  resourceType?: string,
): boolean {
  if (!connected) return false;
  if (resourceType === 'image' && url.startsWith('data:image/')) return true;
  try {
    const target = new URL(url);
    return target.origin === origin && target.pathname !== '/demo';
  } catch {
    return false;
  }
}

export class RemoteHostRegistry {
  private hosts: RemoteHost[] = [];
  private readonly file: string;

  constructor(file: string) {
    this.file = file;
    let source: string;
    try {
      source = readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new Error('Could not read remote host registrations.');
    }
    try {
      if (source.length > 65536) throw new Error();
      const value = JSON.parse(source);
      if (value.version !== 1 || !Array.isArray(value.hosts) || value.hosts.length > 64)
        throw new Error();
      this.hosts = value.hosts.map((entry: RemoteHost) => {
        const host = parseRemoteHostImport(entry);
        if (!idPattern.test(entry.id)) throw new Error();
        if (
          entry.targetFingerprint !== undefined &&
          !/^[a-f0-9]{64}$/.test(entry.targetFingerprint)
        )
          throw new Error();
        return {
          id: entry.id,
          name: host.name,
          sshAlias: host.sshAlias,
          port: host.port,
          ...(entry.targetFingerprint ? { targetFingerprint: entry.targetFingerprint } : {}),
        };
      });
      if (new Set(this.hosts.map((host) => host.id)).size !== this.hosts.length) throw new Error();
      if (
        new Set(this.hosts.map((host) => `${host.sshAlias}:${host.port}`)).size !==
        this.hosts.length
      )
        throw new Error();
    } catch {
      // A corrupt registry must not silently reassign identities/cookies to other hosts.
      throw new Error('Remote host registrations are invalid. Restore the registration file.');
    }
  }

  list(): RemoteHost[] {
    return this.hosts.map((host) => ({ ...host }));
  }

  register(input: { name: string; sshAlias: string; port: number }): RemoteHost {
    const parsed = parseRemoteHostImport(input);
    const existing = this.hosts.find(
      (host) => host.sshAlias === parsed.sshAlias && host.port === parsed.port,
    );
    if (!existing && this.hosts.length >= 64) throw new Error('Remote host limit reached.');
    const host: RemoteHost = {
      id: existing?.id ?? `host_${randomUUID()}`,
      name: parsed.name,
      sshAlias: parsed.sshAlias,
      port: parsed.port,
      ...(existing?.targetFingerprint ? { targetFingerprint: existing.targetFingerprint } : {}),
    };
    this.save([...this.hosts.filter((item) => item.id !== host.id), host]);
    return { ...host };
  }

  remove(id: string) {
    this.save(this.hosts.filter((host) => host.id !== id));
  }

  pinTarget(id: string, fingerprint: string) {
    const host = this.hosts.find((item) => item.id === id);
    if (!host || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error('Invalid host identity.');
    if (host.targetFingerprint && host.targetFingerprint !== fingerprint)
      throw new Error(
        'The SSH alias now points to a different target. Remove and register it again to use a separate host identity.',
      );
    if (!host.targetFingerprint)
      this.save(
        this.hosts.map((item) =>
          item.id === id ? { ...item, targetFingerprint: fingerprint } : item,
        ),
      );
  }

  private save(hosts: RemoteHost[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ version: 1, hosts }, null, 2), {
      mode: 0o600,
      flag: 'wx',
    });
    renameSync(temporary, this.file);
    this.hosts = hosts;
  }
}

const sshOptions = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ExitOnForwardFailure=yes',
  '-o',
  'GatewayPorts=no',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ForwardX11=no',
  '-o',
  'PermitLocalCommand=no',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3',
];

export interface RemoteForward {
  host: '127.0.0.1' | '127.0.0.2';
  port: number;
}

export function remoteSshArgs(
  host: RemoteHost,
  config: string,
  forward: RemoteForward = { host: '127.0.0.1', port: host.port },
): string[] {
  parseRemoteHostImport(host);
  if (!['127.0.0.1', '127.0.0.2'].includes(forward.host) || !validPort(forward.port))
    throw new Error('Invalid remote loopback forwarding target.');
  if (!isAbsolute(config)) throw new Error('An absolute SSH config path is required.');
  return [
    '-N',
    '-T',
    '-v',
    '-F',
    config,
    ...sshOptions,
    '-L',
    `${forward.host}:${forward.port}:${forward.host}:${forward.port}`,
    host.sshAlias,
  ];
}

/** Extra forwarding and helper processes are unsupported, never silently inherited. */
export function assertRemoteSshConfiguration(output: string) {
  for (const line of output.split(/\r?\n/)) {
    const [key, ...parts] = line.trim().split(/\s+/);
    const value = parts.join(' ');
    if (
      ['localforward', 'remoteforward', 'dynamicforward'].includes(key ?? '') ||
      (['proxycommand', 'proxyjump'].includes(key ?? '') && value && value !== 'none')
    )
      throw new Error(
        'Use a direct SSH config host without extra forwarding, ProxyCommand or ProxyJump.',
      );
  }
}

export function remoteTargetFingerprint(configuration: string): string {
  const lines = new Map(
    configuration.split(/\r?\n/).map((line) => {
      const space = line.indexOf(' ');
      return [line.slice(0, space), line.slice(space + 1)] as const;
    }),
  );
  if (!lines.get('hostname') || !lines.get('user') || !lines.get('port'))
    throw new Error('SSH did not resolve a complete host identity.');
  return createHash('sha256')
    .update(
      JSON.stringify(
        ['hostname', 'user', 'port', 'hostkeyalias'].map((field) => lines.get(field) ?? ''),
      ),
    )
    .digest('hex');
}

export interface RemoteHostConnection {
  readonly hostId: string;
  readonly origin: string;
  readonly connected: boolean;
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

/**
 * Host/Origin validation requires the remote server's port on both ends of the tunnel.
 * Never allocate a substitute port, relax CORS, or fall back to the local sidecar.
 */
export async function connectRemoteHost(
  host: RemoteHost,
  options: {
    sshExecutable: string;
    sshConfig: string;
    pinIdentity: (fingerprint: string) => void;
    onDisconnect: () => void;
    signal?: AbortSignal;
    forward?: RemoteForward;
  },
): Promise<RemoteHostConnection> {
  if (!isAbsolute(options.sshExecutable)) throw new Error('Use an installed SSH executable.');
  const executable = realpathSync(options.sshExecutable);
  const config = realpathSync(options.sshConfig);
  const forward = options.forward ?? { host: '127.0.0.1' as const, port: host.port };
  const args = remoteSshArgs(host, config, forward);
  options.signal?.throwIfAborted();
  await new Promise<void>((done, reject) => {
    const reservation = createServer();
    reservation.once('error', () =>
      reject(new Error(`Port ${forward.port} is in use. Stop its listener before connecting.`)),
    );
    reservation.listen({ host: forward.host, port: forward.port, exclusive: true }, () =>
      reservation.close((error) => (error ? reject(error) : done())),
    );
  });
  const configuration = await new Promise<string>((done, reject) => {
    execFile(
      executable,
      ['-G', '-F', config, ...sshOptions, host.sshAlias],
      {
        windowsHide: true,
        timeout: 10000,
        maxBuffer: 262144,
        signal: options.signal,
      },
      (error, stdout) => {
        if (error) reject(new Error('Could not read the configured SSH host.'));
        else done(stdout);
      },
    );
  });
  assertRemoteSshConfiguration(configuration);
  options.pinIdentity(remoteTargetFingerprint(configuration));
  options.signal?.throwIfAborted();

  return new Promise((done, reject) => {
    let ready = false;
    let exited = false;
    let buffer = '';
    let child: ChildProcess;
    let finishClosed = () => {};
    const closed = new Promise<void>((resolve) => {
      finishClosed = resolve;
    });
    const failure = () => {
      if (exited) return;
      exited = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', abort);
      finishClosed();
      if (ready) options.onDisconnect();
      else
        reject(
          new Error(
            'SSH connection failed. Check the host alias, known host key, key authentication and remote server.',
          ),
        );
    };
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
    }, 15000);
    const abort = () => child.kill('SIGKILL');
    child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.once('error', failure);
    child.once('exit', failure);
    options.signal?.addEventListener('abort', abort, { once: true });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (ready || exited) return;
      // OpenSSH emits this only after authentication and opening the requested listener.
      // Diagnostic output contains local paths and is never logged or returned to the UI.
      buffer = (buffer + chunk.toString('utf8')).slice(-16384);
      if (
        !buffer.includes(
          `debug1: Local forwarding listening on ${forward.host} port ${forward.port}.`,
        )
      )
        return;
      ready = true;
      buffer = '';
      clearTimeout(timeout);
      done({
        hostId: host.id,
        origin: `http://${forward.host}:${forward.port}`,
        get connected() {
          return !exited;
        },
        closed,
        async close() {
          if (exited) return;
          child.kill();
          await closed;
        },
      });
    });
  });
}
