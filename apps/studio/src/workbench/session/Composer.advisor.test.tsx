// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RunSummary, WorkSession } from '@corral/core';
import { emptyProjection } from '@corral/core';
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStore } from 'zustand/vanilla';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { setCommands } from '../../commandRegistry.ts';
import { changePreferences } from '../preferences.ts';
import { Composer } from './Composer.tsx';
import { openAdvisorControl } from './composer/AdvisorControl.tsx';

// features/advisor.md "두는 곳" (대화) and "보이는 곳": the conversation's advisor is turned on
// and off, with its model, beside the team menu. What shows is what the session's record says;
// the first request of a new conversation carries it; a run already going is not touched.

const fixture = vi.hoisted(() => ({
  services: {} as Record<string, unknown>,
  invalidate: vi.fn(async () => {}),
}));
vi.mock('../../services.tsx', () => ({ useServices: () => fixture.services }));
vi.mock('../../router.tsx', () => ({ sessionRoute: {}, runRoute: {} }));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => <a href="#session">{children}</a>,
  useNavigate: () => vi.fn(),
  useRouter: () => ({
    invalidate: fixture.invalidate,
    state: { location: { href: '/sessions/session' } },
  }),
}));
vi.mock('../navigation.ts', () => ({
  useSettingsNavigation: () => ({ link: () => ({ to: '/' }) }),
}));
vi.mock('../useModels.ts', () => ({
  useModelProfiles: () => [
    { profileId: 'model-a', label: 'Model A', available: true },
    { profileId: 'model-b', label: 'Model B', available: true },
  ],
  useTeamRoles: () => [],
}));
vi.mock('../useMentionSearch.ts', () => ({ useMentionSearch: () => async () => [] }));

Element.prototype.getAnimations ??= () => [];

const disposals: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0).reverse()) await dispose();
  setCommands('composer', null);
  window.localStorage.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const baseSession: WorkSession = {
  sessionId: 'session',
  projectId: 'project',
  corralId: null,
  auto: { modelProfile: 'model-a' },
  title: 'Session',
  objective: '',
  pinned: false,
  revision: 3,
  createdAt: '2026-11-13T00:00:00Z',
  updatedAt: '2026-11-13T00:00:00Z',
  archivedAt: null,
  autoStart: true,
  entries: [],
};
const running: RunSummary = {
  runId: 'run_live',
  status: 'running',
  corralId: 'auto',
  projectId: 'project',
  sessionId: 'session',
  startedAt: '2026-11-13T00:00:00Z',
};

type Save = (change: Record<string, unknown>) => Promise<unknown>;

/** A promise the test settles. */
function held<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function mount({
  session = baseSession,
  active = null as RunSummary | null,
  save,
  stored,
  home = false,
}: {
  session?: WorkSession;
  active?: RunSummary | null;
  /** The server's answer to a session save; by default it saves. */
  save?: Save;
  /** The session as a fresh read returns it; by default the current one. */
  stored?: () => WorkSession;
  home?: boolean;
} = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  changePreferences({ sendKey: 'enter' });
  let current = session;
  const repository = {
    getSession: vi.fn(async () => (stored ? stored() : current)),
    get: vi.fn(async () => null),
    addSessionEntry: vi.fn(async () => ({ ok: true, session: current })),
    updateSessionEntry: vi.fn(async () => ({ ok: true, session: current })),
    updateSession: vi.fn(async (_sessionId: string, change: Record<string, unknown>) => {
      if (save) return save(change);
      if (change.expectedRevision !== current.revision)
        return { ok: false, error: 'revision_conflict', message: 'changed elsewhere' };
      const { expectedRevision: _r, ...rest } = change;
      current = { ...current, ...rest, revision: current.revision + 1 } as WorkSession;
      return { ok: true, session: current };
    }),
  };
  const startAuto = vi.fn(async () => ({
    runId: 'run_new',
    receipt: { commandId: 'x', accepted: true },
    autoRoute: null,
  }));
  const sendCommand = vi.fn(async () => ({}));
  const projection = emptyProjection('run_live');
  projection.status = 'running';
  const store = createStore(() => ({
    runId: 'run_live',
    projection,
    definition: null,
    streamError: null,
    missingRunId: null,
    events: [],
    open: vi.fn(async () => {}),
    pendingCommandIds: [],
    sendCommand,
  }));
  fixture.services = {
    repository,
    transport: {
      sendCommand,
      getSnapshot: vi.fn(async () => ({ projection, seq: 1 })),
      getRunDefinition: vi.fn(async () => null),
    },
    runFor: () => store,
    retainRun: () => () => {},
    mode: 'server',
    live: true,
    workspaceId: 'host',
    workspaces: null,
    voice: null,
    startAuto,
    startExplain: vi.fn(),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  disposals.push(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const corrals = [
    {
      corralId: 'corral_review',
      projectId: 'project',
      name: 'Review team',
      definitionRevision: 1,
    },
  ] as never[];
  const render = async (next: WorkSession = current, run: RunSummary | null = active) => {
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <Composer
            session={next}
            team={
              next.corralId
                ? ({ corralId: next.corralId, name: 'Review team', definitionRevision: 1 } as never)
                : null
            }
            corrals={corrals}
            runs={run ? [run] : []}
            active={run}
            selectedRunId={run?.runId ?? null}
            queued={[]}
            onChange={() => {}}
            reference={null}
            onReferenceUsed={() => {}}
            home={home}
          />
        </IntlProvider>,
      ),
    );
  };
  await render(session);
  const control = () =>
    container.querySelector<HTMLButtonElement>('[data-slot="composer-advisor"]');
  const open = async () => {
    await act(async () => control()?.click());
  };
  const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"]');
  const flip = async () => {
    await act(async () => toggle()?.click());
  };
  const said = () =>
    document.querySelector('[data-slot="advisor-popover"] [role="alert"]')?.textContent ?? '';
  const box = () => container.querySelector('textarea') as HTMLTextAreaElement;
  const type = async (value: string) => {
    await act(async () => {
      box().focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        box(),
        value,
      );
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const press = async () => {
    await act(async () => {
      box().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
    });
    await act(async () => {});
  };
  return {
    container,
    repository,
    startAuto,
    sendCommand,
    render,
    current: () => current,
    control,
    open,
    toggle,
    flip,
    said,
    type,
    press,
  };
}

const advisorSaves = (repository: { updateSession: ReturnType<typeof vi.fn> }) =>
  repository.updateSession.mock.calls
    .map((call) => call[1] as Record<string, unknown>)
    .filter((change) => 'advisor' in change);

describe('the advisor control on the tool line', () => {
  it('sits beside the team menu, quiet while off and plainly on once on', async () => {
    const f = await mount();
    const control = f.control();
    expect(control).not.toBeNull();
    // Beside the team menu: the next control after it.
    const buttons = [...f.container.querySelectorAll('button')];
    const team = buttons.findIndex((b) => b.textContent?.includes(messages.Composer.teamNone));
    expect(team).toBeGreaterThanOrEqual(0);
    expect(buttons[team + 1]).toBe(control);
    expect(control?.getAttribute('aria-label')).toBe(messages.Composer.advisor.name);
    expect(control?.dataset.state).toBe('off');
    // Off, it takes its place and says nothing.
    expect(control?.textContent?.trim()).toBe('');
    await f.render({ ...baseSession, advisor: { modelProfile: 'model-b' }, revision: 4 });
    expect(f.control()?.dataset.state).toBe('on');
    expect(f.control()?.getAttribute('aria-description')).toContain('Model B');
  });

  it('is off in a new conversation', async () => {
    const f = await mount({ session: { ...baseSession, advisor: null } });
    expect(f.control()?.dataset.state).toBe('off');
    const g = await mount({ session: { ...baseSession } });
    expect(g.control()?.dataset.state).toBe('off');
  });

  it("turns on with the conversation's model, and shows on only once the session says so", async () => {
    const answer = held<unknown>();
    const f = await mount({ save: () => answer.promise });
    await f.open();
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('false');
    await f.flip();
    expect(advisorSaves(f.repository)).toEqual([
      { advisor: { modelProfile: 'model-a' }, expectedRevision: 3 },
    ]);
    // Not first changed on the screen, and not pressed twice while it goes.
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(f.toggle()?.getAttribute('aria-disabled') ?? f.toggle()?.disabled.toString()).toMatch(
      /true/,
    );
    await f.flip();
    expect(advisorSaves(f.repository)).toHaveLength(1);
    await act(async () =>
      answer.resolve({
        ok: true,
        session: { ...baseSession, advisor: { modelProfile: 'model-a' }, revision: 4 },
      }),
    );
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(f.control()?.dataset.state).toBe('on');
  });

  it('turns off with null and changes the model with the same list as the conversation’s', async () => {
    const f = await mount({ session: { ...baseSession, advisor: { modelProfile: 'model-a' } } });
    await f.open();
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('true');
    // The conversation's own model picker, in the popover.
    const picker = document.querySelector<HTMLButtonElement>(
      '[data-slot="advisor-popover"] [data-slot="model-picker-trigger"], [data-slot="advisor-popover"] button[aria-haspopup]',
    );
    expect(picker?.textContent).toContain('Model A');
    await f.flip();
    expect(advisorSaves(f.repository).at(-1)).toEqual({ advisor: null, expectedRevision: 3 });
  });

  it('reads the session again on a revision conflict and shows what it says', async () => {
    const f = await mount({
      save: async () => ({ ok: false, error: 'revision_conflict', message: 'changed elsewhere' }),
      stored: () => ({ ...baseSession, advisor: { modelProfile: 'model-b' }, revision: 6 }),
    });
    await f.open();
    await f.flip();
    expect(f.repository.getSession).toHaveBeenCalledWith('session');
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(f.control()?.dataset.state).toBe('on');
    expect(f.said()).toBe(messages.Composer.advisor.conflict);
    // Nothing else was sent to make it so.
    expect(advisorSaves(f.repository)).toHaveLength(1);
  });

  it('says a refused save where it was pressed and changes nothing', async () => {
    const f = await mount({
      save: async () => ({
        ok: false,
        error: 'invalid',
        message: 'The advisor names one model profile.',
      }),
    });
    await f.open();
    await f.flip();
    expect(f.said()).toContain('The advisor names one model profile.');
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('false');
    expect(f.control()?.dataset.state).toBe('off');
  });

  it('reads a save the client could not deliver as a lost answer, not a refusal', async () => {
    // The REST client answers a dropped connection with storage_unavailable instead of throwing.
    const f = await mount({
      save: async () => ({
        ok: false,
        error: 'storage_unavailable',
        message: 'Could not save: TypeError: Failed to fetch',
      }),
      stored: () => ({ ...baseSession, advisor: { modelProfile: 'model-a' }, revision: 4 }),
    });
    await f.open();
    await f.flip();
    expect(advisorSaves(f.repository)).toHaveLength(1);
    expect(f.repository.getSession).toHaveBeenCalledWith('session');
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(f.said()).toBe(messages.Composer.advisor.lost);
  });

  it('does not send again, with any value, when the answer is lost', async () => {
    const f = await mount({
      save: async () => {
        throw new TypeError('Failed to fetch');
      },
      // It did arrive: the session says on.
      stored: () => ({ ...baseSession, advisor: { modelProfile: 'model-a' }, revision: 4 }),
    });
    await f.open();
    await f.flip();
    expect(advisorSaves(f.repository)).toHaveLength(1);
    expect(f.repository.getSession).toHaveBeenCalledWith('session');
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(f.said()).toBe(messages.Composer.advisor.lost);
  });

  it('keeps a saved model that is no longer listed, shown as unavailable, and stays on', async () => {
    const f = await mount({ session: { ...baseSession, advisor: { modelProfile: 'model-gone' } } });
    expect(f.control()?.dataset.state).toBe('on');
    await f.open();
    expect(f.toggle()?.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('[data-slot="advisor-popover"]')?.textContent).toContain(
      'model-gone',
    );
  });
});

describe('the advisor and requests', () => {
  it('a new conversation’s first request starts only after the setting is saved', async () => {
    const answer = held<unknown>();
    const f = await mount({ save: () => answer.promise });
    await f.open();
    await f.flip();
    await f.type('Find why login is slow');
    await f.press();
    // The save is still on its way: the request waits for it.
    expect(f.startAuto).not.toHaveBeenCalled();
    await act(async () =>
      answer.resolve({
        ok: true,
        session: { ...baseSession, advisor: { modelProfile: 'model-a' }, revision: 4 },
      }),
    );
    await f.render({ ...baseSession, advisor: { modelProfile: 'model-a' }, revision: 4 });
    await f.press();
    expect(f.startAuto).toHaveBeenCalledTimes(1);
    expect(f.repository.updateSession.mock.invocationCallOrder[0]).toBeLessThan(
      f.startAuto.mock.invocationCallOrder[0] as number,
    );
  });

  it('choosing a team keeps the advisor as it is', async () => {
    const on = { ...baseSession, advisor: { modelProfile: 'model-b' } };
    const f = await mount({ session: on, home: true });
    const start = [...f.container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Review team'),
    );
    await act(async () => start?.click());
    const teamSave = f.repository.updateSession.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(teamSave).toMatchObject({ corralId: 'corral_review' });
    expect('advisor' in teamSave).toBe(false);
    await f.render(f.current());
    expect(f.control()?.dataset.state).toBe('on');
  });

  it('changes while a run goes, for the next request, without touching the run', async () => {
    const f = await mount({ active: running });
    // The team menu is not offered while a run goes; the advisor stays reachable and visible.
    expect(f.control()).not.toBeNull();
    await f.open();
    await f.flip();
    expect(advisorSaves(f.repository)).toEqual([
      { advisor: { modelProfile: 'model-a' }, expectedRevision: 3 },
    ]);
    expect(f.sendCommand).not.toHaveBeenCalled();
    expect(f.startAuto).not.toHaveBeenCalled();
  });

  it('works in an archived conversation, which still takes requests', async () => {
    const f = await mount({ session: { ...baseSession, archivedAt: '2026-11-13T01:00:00Z' } });
    expect(f.control()?.disabled).toBe(false);
    await f.open();
    await f.flip();
    expect(advisorSaves(f.repository)).toHaveLength(1);
  });

  it("opens from the refusal line's action", async () => {
    const f = await mount();
    expect(f.toggle()).toBeNull();
    await act(async () => openAdvisorControl());
    expect(f.toggle()).not.toBeNull();
  });
});

it('a meeting’s composer has no advisor control', () => {
  const source = readFileSync(resolve(import.meta.dirname, 'composer/meeting.tsx'), 'utf8');
  expect(source).not.toMatch(/AdvisorControl/);
});
