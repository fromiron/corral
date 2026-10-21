import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  assertRemoteSshConfiguration,
  connectRemoteHost,
  parseRemoteHostImport,
  RemoteHostRegistry,
  remoteBootstrapUrl,
  remotePartition,
  remoteRequestAllowed,
  remoteSshArgs,
  remoteTargetFingerprint,
} from '../src/remote-hosts.ts';

const folders: string[] = [];
const temporary = () => {
  const path = mkdtempSync(join(tmpdir(), 'corral-remote-'));
  folders.push(path);
  return path;
};
afterEach(() => {
  for (const path of folders.splice(0)) rmSync(path, { recursive: true, force: true });
});
const registration = { name: 'Build host', sshAlias: 'corral-build', port: 4319 };

it('[TC-ABS-014-H] registration preserves host identity across reload and never persists bootstrap credentials', () => {
  const path = join(temporary(), 'hosts.json');
  const registry = new RemoteHostRegistry(path);
  const bootstrapUrl = `http://127.0.0.1:4319/#bootstrap=${'a'.repeat(43)}`;
  const host = registry.register(parseRemoteHostImport({ ...registration, bootstrapUrl }));
  expect(readFileSync(path, 'utf8')).not.toContain('bootstrap');
  const reloaded = new RemoteHostRegistry(path);
  expect(reloaded.list()).toEqual([host]);
  expect(reloaded.register({ ...registration, name: 'Renamed' }).id).toBe(host.id);
  expect(remotePartition(host)).toBe(`persist:corral-${host.id}`);
  const second = reloaded.register({ ...registration, sshAlias: 'other' });
  expect(remotePartition(second)).not.toBe(remotePartition(host));
  reloaded.remove(host.id);
  expect(new RemoteHostRegistry(path).list()).toEqual([second]);
});

it('[TC-ABS-014-N] remote pages cannot use another local service, preview listener or demo runtime', () => {
  const origin = 'http://127.0.0.1:4319';
  expect(remoteRequestAllowed(`${origin}/api/v1/runs`, origin, true)).toBe(true);
  expect(remoteRequestAllowed('data:image/png;base64,a', origin, true, 'image')).toBe(true);
  expect(remoteRequestAllowed('data:text/html,x', origin, true, 'mainFrame')).toBe(false);
  expect(remoteRequestAllowed(`blob:${origin}/id`, origin, true, 'image')).toBe(true);
  for (const url of [
    'http://127.0.0.1:4320/api/v1/runs',
    'http://127.0.0.2:4319/preview',
    'file:///C:/private',
    'https://example.com/',
    `${origin}/demo`,
  ])
    expect(remoteRequestAllowed(url, origin, true)).toBe(false);
  expect(remoteRequestAllowed(`${origin}/api/v1/runs`, origin, false)).toBe(false);
});

it('[TC-ABS-014-N] an edited SSH target cannot inherit the previous host cookie namespace', () => {
  const registry = new RemoteHostRegistry(join(temporary(), 'hosts.json'));
  const host = registry.register(registration);
  const first = remoteTargetFingerprint('hostname first\nuser corral\nport 22');
  registry.pinTarget(host.id, first);
  registry.pinTarget(host.id, first);
  expect(() =>
    registry.pinTarget(host.id, remoteTargetFingerprint('hostname second\nuser corral\nport 22')),
  ).toThrow('different target');
  expect(registry.register({ ...registration, name: 'Renamed' }).targetFingerprint).toBe(first);
});

it('[TC-ABS-014-N] corrupt registration cannot silently reassign an existing host identity', () => {
  const path = join(temporary(), 'hosts.json');
  writeFileSync(path, JSON.stringify({ version: 1, hosts: [{ ...registration, id: 'local' }] }));
  expect(() => new RemoteHostRegistry(path)).toThrow('registrations are invalid');
});

it('[TC-ABS-014-N] bootstrap must match registered loopback port and cannot carry query or navigation', () => {
  const token = 'x'.repeat(43);
  expect(remoteBootstrapUrl(`http://localhost:4319/#bootstrap=${token}`, 4319)).toBe(
    `http://127.0.0.1:4319/#bootstrap=${token}`,
  );
  for (const url of [
    `http://127.0.0.1:4320/#bootstrap=${token}`,
    `http://127.0.0.1:4319/?token=${token}`,
    `http://127.0.0.1:4319/sessions/s#bootstrap=${token}`,
    `http://user:pass@127.0.0.1:4319/#bootstrap=${token}`,
    `https://example.com:4319/#bootstrap=${token}`,
  ])
    expect(() => remoteBootstrapUrl(url, 4319)).toThrow('registered port');
});

it('[TC-ABS-014-N] SSH accepts only a config alias and strictly pins loopback endpoints and host keys', () => {
  const config = join(temporary(), 'ssh-config');
  const host = { ...registration, id: 'host_00000000-0000-0000-0000-000000000000' };
  const args = remoteSshArgs(host, config);
  expect(args).toContain('StrictHostKeyChecking=yes');
  expect(args).toContain('ExitOnForwardFailure=yes');
  expect(args).toContain('BatchMode=yes');
  expect(args).toContain('127.0.0.1:4319:127.0.0.1:4319');
  expect(args.at(-1)).toBe(host.sshAlias);
  for (const sshAlias of ['-oProxyCommand=x', 'user@host', 'host;command', '../config'])
    expect(() => remoteSshArgs({ ...host, sshAlias }, config)).toThrow('SSH config alias');
  for (const output of [
    'localforward 127.0.0.1:9999 localhost:22',
    'remoteforward 2222 localhost:22',
    'proxycommand arbitrary-helper',
    'proxyjump jumphost',
  ])
    expect(() => assertRemoteSshConfiguration(output)).toThrow('direct SSH config');
  expect(() => assertRemoteSshConfiguration('hostname 127.0.0.1\nproxycommand none')).not.toThrow();
});

// Opt-in to the real installed OpenSSH client. It only contacts a closed local TCP port.
it.runIf(process.env.CORRAL_TEST_SSH)(
  '[TC-ABS-014-N] installed SSH refuses an occupied tunnel port and a failed local connection without fallback',
  async () => {
    const config = join(temporary(), 'ssh-config');
    const occupied = createServer();
    await new Promise<void>((done) => occupied.listen(0, '127.0.0.1', done));
    const port = (occupied.address() as { port: number }).port;
    const remote = createServer();
    await new Promise<void>((done) => remote.listen(0, '127.0.0.1', done));
    const remotePort = (remote.address() as { port: number }).port;
    await new Promise<void>((done) => remote.close(() => done()));
    writeFileSync(
      config,
      `Host corral-build\n  HostName 127.0.0.1\n  Port ${remotePort}\n  User corral\n`,
    );
    const options = {
      sshExecutable: process.env.CORRAL_TEST_SSH as string,
      sshConfig: config,
      pinIdentity: (fingerprint: string) => expect(fingerprint).toMatch(/^[a-f0-9]{64}$/),
      onDisconnect: () => {
        throw new Error('A connection was never established.');
      },
    };
    const host = { ...registration, port, id: 'host_00000000-0000-0000-0000-000000000000' };
    try {
      await expect(connectRemoteHost(host, options)).rejects.toThrow('in use');
    } finally {
      await new Promise<void>((done) => occupied.close(() => done()));
    }
    await expect(connectRemoteHost(host, options)).rejects.toThrow('SSH connection failed');
  },
);
