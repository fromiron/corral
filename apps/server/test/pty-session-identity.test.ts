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

import {
  capturePtySession,
  cleanupPtyLaunch,
  cleanupPtySession,
  observePtyLaunch,
  waitForPtySession,
} from '../src/processes/pty-session.ts';

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

it('waits for the same forkpty child to establish its session instead of rejecting its inherited SID', async () => {
  fixture.members.set(pid, { start: '100', session: 7, group: 7 });
  const launch = observePtyLaunch(pid, 'our-pty', fixture.boot);
  const after = vi.fn((_ms: number, done: () => void) => {
    fixture.members.set(pid, { start: '100', session: pid, group: pid, owner: 'our-pty' });
    done();
    return () => {};
  });
  expect(await waitForPtySession(launch, { after })).toEqual({
    ...launch,
    sessionId: pid,
  });
  expect(after).toHaveBeenCalledOnce();
  expect(after.mock.calls[0]?.[0]).toBe(10);
});

it('never follows a reused PID while waiting for a PTY session', async () => {
  fixture.members.set(pid, { start: '100', session: 7, group: 7 });
  const launch = observePtyLaunch(pid, 'our-pty', fixture.boot);
  const after = (_ms: number, done: () => void) => {
    fixture.members.set(pid, { start: '999', session: pid, group: pid, owner: 'our-pty' });
    done();
    return () => {};
  };
  await expect(waitForPtySession(launch, { after })).rejects.toMatchObject({
    code: 'identity_changed',
  });
});

it.each(['denied', 'gone', 'timeout'] as const)(
  'retains a safe structured %s startup failure',
  async (failure) => {
    const launch = observePtyLaunch(pid, 'our-pty', fixture.boot);
    if (failure === 'denied') fixture.denied = true;
    if (failure === 'gone') fixture.members.delete(pid);
    if (failure === 'timeout') fixture.members.set(pid, { start: '100', session: 7, group: 7 });
    await expect(waitForPtySession(launch, timers)).rejects.toMatchObject({
      code:
        failure === 'denied'
          ? 'identity_unavailable'
          : failure === 'gone'
            ? 'process_exited'
            : 'session_not_ready',
    });
  },
);

it('waits for owner proof before cancelling a pre-session child and never signals its parent session', async () => {
  fixture.members.set(pid, { start: '100', session: 7, group: 7 });
  fixture.members.set(7, { start: '1', session: 7, group: 7 });
  const launch = observePtyLaunch(pid, 'our-pty', fixture.boot);
  const kill = vi.spyOn(process, 'kill').mockImplementation((target) => {
    fixture.members.delete(target);
    return true;
  });
  let established = false;
  const ready = {
    after: (_ms: number, done: () => void) => {
      if (!established) {
        expect(kill).not.toHaveBeenCalled();
        fixture.members.set(pid, { start: '100', session: pid, group: pid, owner: 'our-pty' });
        established = true;
      }
      done();
      return () => {};
    },
  };
  try {
    expect(await cleanupPtyLaunch(launch, ready)).toBe(true);
    expect(kill.mock.calls.map(([target]) => target)).toEqual([pid]);
    expect(fixture.members.has(7)).toBe(true);
  } finally {
    kill.mockRestore();
  }
});

it('does not signal a matching numeric PID and birth with an unproven owner', async () => {
  fixture.members.set(pid, { start: '100', session: pid, group: pid, owner: 'other' });
  const launch = observePtyLaunch(pid, 'our-pty', fixture.boot);
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    expect(await cleanupPtyLaunch(launch, timers)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

it('a zombie observed before owner proof does not authorize signalling its unmarked descendants', async () => {
  const launch = observePtyLaunch(pid, 'our-pty', fixture.boot);
  fixture.members.set(pid, { start: '100', session: pid, group: pid, state: 'Z', owner: 'other' });
  fixture.members.set(pid + 1, { start: '200', session: pid, group: pid + 1, owner: 'other' });
  const kill = vi.spyOn(process, 'kill').mockImplementation((target) => {
    fixture.members.delete(target);
    return true;
  });
  try {
    expect(await cleanupPtyLaunch(launch, timers)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    expect(fixture.members.has(pid + 1)).toBe(true);
  } finally {
    kill.mockRestore();
  }
});

it('recovers an unreadable initial birth only after proving the live owner marker', async () => {
  fixture.denied = true;
  const launch = observePtyLaunch(pid, 'our-pty', fixture.boot);
  expect(launch.startTicks).toBeUndefined();
  fixture.denied = false;
  const kill = vi.spyOn(process, 'kill').mockImplementation((target) => {
    fixture.members.delete(target);
    return true;
  });
  try {
    fixture.members.set(pid, { start: '100', session: pid, group: pid, owner: 'other' });
    expect(await cleanupPtyLaunch(launch, timers)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
    fixture.members.set(pid, { start: '100', session: pid, group: pid, owner: 'our-pty' });
    expect(await cleanupPtyLaunch(launch, timers)).toBe(true);
    expect(kill).toHaveBeenCalledExactlyOnceWith(pid, 'SIGKILL');
  } finally {
    kill.mockRestore();
  }
});

it('requires an actual later boot for legacy evidence with no PID, even with no visible processes', async () => {
  const legacy = { bootId: fixture.boot, owner: 'our-pty' };
  fixture.members.clear();
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    expect(await cleanupPtyLaunch(legacy, timers)).toBe(false);
    fixture.boot = 'boot-two';
    expect(await cleanupPtyLaunch(legacy, timers)).toBe(true);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
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
