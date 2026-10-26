import type { Scheduler } from '@corral/contracts';
import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  boot: 'boot-one',
  members: new Map<
    number,
    { start: string; session: number; group: number; state?: string; owner?: string }
  >(),
  denied: false,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) =>
      String(args[0]) === '/proc'
        ? [...fixture.members.keys()].map(String)
        : actual.readdirSync(...args),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      const path = String(args[0]);
      if (path === '/proc/sys/kernel/random/boot_id') return fixture.boot;
      const match = /^\/proc\/(\d+)\/(stat|environ)$/.exec(path);
      if (!match) return actual.readFileSync(...args);
      if (fixture.denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      const member = fixture.members.get(Number(match[1]));
      if (!member) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
      if (match[2] === 'environ') return `CORRAL_PROCESS_OWNER=${member.owner ?? ''}\0`;
      const fields = Array(20).fill('0');
      fields[0] = member.state ?? 'S';
      fields[2] = String(member.group);
      fields[3] = String(member.session);
      fields[19] = member.start;
      return `${match[1]} (fixture with ) name) ${fields.join(' ')}`;
    },
  };
});

import { capturePtySession, cleanupPtySession } from '../src/processes/pty-session.ts';

const timers: Scheduler = {
  after: (_ms, fn) => {
    fn();
    return () => {};
  },
};
const pid = 43210;
beforeEach(() => {
  fixture.boot = 'boot-one';
  fixture.denied = false;
  fixture.members.clear();
  fixture.members.set(pid, { start: '100', session: pid, group: pid, owner: 'our-pty' });
});

it.skipIf(process.platform !== 'linux')(
  'cleans marked session jobs after their leader exits, including other groups',
  async () => {
    const identity = capturePtySession(pid, 'our-pty');
    fixture.members.delete(pid);
    fixture.members.set(pid + 1, { start: '200', session: pid, group: pid + 1, owner: 'our-pty' });
    fixture.members.set(pid + 2, { start: '300', session: pid, group: pid + 2, owner: 'our-pty' });
    const kill = vi.spyOn(process, 'kill').mockImplementation((member) => {
      fixture.members.delete(member);
      return true;
    });
    try {
      expect(await cleanupPtySession(identity, timers)).toBe(true);
      expect(kill.mock.calls.map(([member]) => member).sort()).toEqual([pid + 1, pid + 2]);
      expect(await cleanupPtySession(identity, timers)).toBe(true);
      expect(kill).toHaveBeenCalledTimes(2);
    } finally {
      kill.mockRestore();
    }
  },
);

it.skipIf(process.platform !== 'linux').each(['reused', 'unproven', 'denied'])(
  'leaves %s process ownership uncertain without signalling',
  async (failure) => {
    const identity = capturePtySession(pid, 'our-pty');
    if (failure === 'reused')
      fixture.members.set(pid, { start: '999', session: pid, group: pid, owner: 'our-pty' });
    if (failure === 'unproven') {
      fixture.members.delete(pid);
      fixture.members.set(pid + 1, { start: '200', session: pid, group: pid + 1 });
    }
    if (failure === 'denied') fixture.denied = true;
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      expect(await cleanupPtySession(identity, timers)).toBe(false);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  },
);

it.skipIf(process.platform !== 'linux')(
  'old boot and non-executing zombies need no signals',
  async () => {
    const identity = capturePtySession(pid, 'our-pty');
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      fixture.members.set(pid, { start: '100', session: pid, group: pid, state: 'Z' });
      expect(await cleanupPtySession(identity, timers)).toBe(true);
      fixture.boot = 'boot-two';
      fixture.members.set(pid, { start: '999', session: pid, group: pid });
      expect(await cleanupPtySession(identity, timers)).toBe(true);
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  },
);
