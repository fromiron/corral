import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { publicRemotePreview } from '../src/remote-host-preview-policy.ts';
import { remoteSshArgs } from '../src/remote-hosts.ts';

it('[TC-ABS-014-N] only a live remote static lease can authorize its keyed iframe and assets', () => {
  const origin = 'http://127.0.0.2:4123';
  const prefix = `/${'a'.repeat(43)}/`;
  const lease = {
    leaseId: 'preview_one',
    sessionId: 'session_one',
    state: 'ready',
    kind: 'static',
    origin,
    url: `${origin}${prefix}index.html`,
  };
  expect(publicRemotePreview(lease, 'session_one', `${origin}${prefix}style.css`)).toBe(true);
  for (const url of [
    `${origin}/private`,
    'http://127.0.0.1:4123/',
    'http://127.0.0.2:4124/',
    `http://user:pass@127.0.0.2:4123${prefix}a`,
  ])
    expect(publicRemotePreview(lease, 'session_one', url)).toBe(false);
  expect(publicRemotePreview(lease, 'session_other', lease.url)).toBe(false);
  expect(publicRemotePreview({ ...lease, state: 'stopped' }, 'session_one', lease.url)).toBe(false);
  expect(publicRemotePreview({ ...lease, kind: 'service' }, 'session_one', lease.url)).toBe(false);
});

it('[TC-ABS-014-H] preview forwards preserve the remote isolated origin and never bind wildcard', () => {
  const host = {
    id: 'host_00000000-0000-0000-0000-000000000000',
    name: 'Remote',
    sshAlias: 'remote',
    port: 4317,
  };
  const args = remoteSshArgs(host, resolve('ssh-config'), { host: '127.0.0.2', port: 4123 });
  expect(args).toContain('127.0.0.2:4123:127.0.0.2:4123');
  expect(args).toContain('GatewayPorts=no');
});
