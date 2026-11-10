// @vitest-environment jsdom
import type { CorralSummary, WorkSession } from '@corral/core';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import messages from '../../../../../packages/react/src/messages/en.json' with { type: 'json' };
import { SessionMenu } from '../Breadcrumbs.tsx';
import { TopbarSlotContext } from '../TopbarSlot.tsx';
import { SessionActions } from './SessionActions.tsx';

const services = vi.hoisted(() => ({
  repository: {
    updateSession: (() => {}) as (...args: unknown[]) => unknown,
    getSession: (() => {}) as (...args: unknown[]) => unknown,
  },
  mode: 'server',
  terminals: {},
}));
vi.mock('../../services.tsx', () => ({ useServices: () => services }));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouter: () => ({ invalidate: vi.fn(async () => {}) }),
}));
vi.mock('../ChatView.tsx', () => ({ ChatDensityMenu: () => null }));
const fit = vi.hoisted(() => ({ tier: 0 }));
vi.mock('../TopbarSlot.tsx', async (original) => {
  const actual = await original<typeof import('../TopbarSlot.tsx')>();
  const { topbarLayout } = await import('../topbarTier.ts');
  return { ...actual, useTopbarLayout: () => topbarLayout(fit.tier) };
});

Element.prototype.getAnimations ??= () => [];
const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => {
  services.repository.updateSession = vi.fn();
  // Unless a test says otherwise, the session cannot be read again.
  services.repository.getSession = vi.fn(async () => null);
});
afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
  vi.unstubAllGlobals();
});

const team: CorralSummary = {
  corralId: 'team_brief',
  projectId: 'project',
  name: 'Research brief',
  definitionRevision: 3,
  nodeCount: 2,
  updatedAt: '2026-11-10T00:00:00.000Z',
};
const session = {
  sessionId: 'session',
  projectId: 'project',
  title: 'Brief',
  corralId: 'team_brief',
  revision: 1,
  pinned: false,
  archivedAt: null,
  entries: [],
} as unknown as WorkSession;

it("leaves the team's name and revision to the session menu, not the top bar", async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const bar = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(bar, container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    bar.remove();
    container.remove();
  });
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TopbarSlotContext.Provider value={{ actions: bar, views: null, crumbs: null }}>
          <SessionActions
            session={session}
            corrals={[team]}
            team={team}
            changes={null}
            panel={undefined}
            onPanel={vi.fn()}
            fileViewerOpen={false}
            onToggleFileViewer={vi.fn()}
            onEditTeam={() => true}
          />
        </TopbarSlotContext.Provider>
      </IntlProvider>,
    ),
  );
  expect(bar.textContent).not.toContain('Research brief');
  expect(bar.textContent).not.toContain('r3');
  const menu = bar.querySelector<HTMLElement>(
    `[aria-label="${messages.Desktop.sessionActions.replace('{title}', 'Brief')}"]`,
  );
  expect(menu).not.toBeNull();
  await act(async () => menu?.click());
  const line = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
    row.textContent?.startsWith(messages.Sessions.chooseTeam),
  );
  expect(line?.textContent).toContain('Research brief · r3');
});

it.each([
  [6, 'bar'],
  [7, 'menu'],
] as const)(
  'at tier %i the changes, terminal and file viewer sit in the %s',
  async (tier, place) => {
    fit.tier = tier;
    cleanup.push(async () => {
      fit.tier = 0;
    });
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const bar = document.createElement('div');
    const container = document.createElement('div');
    document.body.append(bar, container);
    const root = createRoot(container);
    cleanup.push(async () => {
      await act(async () => root.unmount());
      bar.remove();
      container.remove();
    });
    const onPanel = vi.fn();
    const onToggleFileViewer = vi.fn();
    await act(async () =>
      root.render(
        <IntlProvider locale="en" messages={messages} timeZone="UTC">
          <TopbarSlotContext.Provider value={{ actions: bar, views: null, crumbs: null }}>
            <SessionActions
              session={session}
              corrals={[team]}
              team={team}
              changes={[{ path: 'README.md' } as never]}
              panel={undefined}
              onPanel={onPanel}
              fileViewerOpen={false}
              onToggleFileViewer={onToggleFileViewer}
              onEditTeam={() => true}
            />
          </TopbarSlotContext.Provider>
        </IntlProvider>,
      ),
    );
    const changes = 'Session changes · 1 file';
    const inBar = (name: string) =>
      [...bar.querySelectorAll('button')].some(
        (button) => (button.getAttribute('aria-label') ?? button.textContent) === name,
      );
    expect(inBar(messages.Docking.terminal)).toBe(place === 'bar');
    expect(inBar(messages.Docking.openFileViewer)).toBe(place === 'bar');
    expect(inBar(changes)).toBe(place === 'bar');
    const menu = bar.querySelector<HTMLElement>(
      `[aria-label="${messages.Desktop.sessionActions.replace('{title}', 'Brief')}"]`,
    );
    await act(async () => menu?.click());
    const item = (name: string) =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((row) =>
        row.textContent?.startsWith(name),
      );
    // The menu's rows exist either way: the folded tools are what differs.
    expect(item(messages.Desktop.rename)).toBeDefined();
    if (place === 'bar') {
      expect(item(messages.Docking.terminal)).toBeUndefined();
      expect(item(messages.Docking.openFileViewer)).toBeUndefined();
      expect(item(changes)).toBeUndefined();
      return;
    }
    // Folded, each one still does what its button did.
    await act(async () => item(changes)?.click());
    expect(onPanel).toHaveBeenLastCalledWith('changes');
    await act(async () => menu?.click());
    await act(async () => item(messages.Docking.terminal)?.click());
    expect(onPanel).toHaveBeenLastCalledWith('terminal');
    await act(async () => menu?.click());
    await act(async () => item(messages.Docking.openFileViewer)?.click());
    expect(onToggleFileViewer).toHaveBeenLastCalledWith(true);
  },
);

// A work session's completion criteria, read and edited from its menus
// (docs/specs/workbench.md#세션-완료-기준).
async function mountCriteria(change: Partial<WorkSession> = {}) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const bar = document.createElement('div');
  const container = document.createElement('div');
  document.body.append(bar, container);
  const root = createRoot(container);
  cleanup.push(async () => {
    await act(async () => root.unmount());
    bar.remove();
    container.remove();
  });
  const current = { ...session, revision: 4, criteria: ['The build passes'], ...change };
  await act(async () =>
    root.render(
      <IntlProvider locale="en" messages={messages} timeZone="UTC">
        <TopbarSlotContext.Provider value={{ actions: bar, views: null, crumbs: null }}>
          <SessionMenu
            sessions={[current]}
            runs={[]}
            projectId="project"
            sessionId="session"
            title="Brief"
            onOpen={vi.fn()}
          />
          <SessionActions
            session={current}
            corrals={[team]}
            team={team}
            changes={null}
            panel={undefined}
            onPanel={vi.fn()}
            fileViewerOpen={false}
            onToggleFileViewer={vi.fn()}
            onEditTeam={() => true}
          />
        </TopbarSlotContext.Provider>
      </IntlProvider>,
    ),
  );
  const actionsMenu = bar.querySelector<HTMLElement>(
    `[aria-label="${messages.Desktop.sessionActions.replace('{title}', 'Brief')}"]`,
  );
  const pathMenu = container.querySelector<HTMLElement>('h2 button');
  return { actionsMenu, pathMenu, update: services.repository.updateSession as Mock };
}

type Mock = ReturnType<typeof vi.fn>;
const criteria = messages.Sessions.criteria;
/** Text a person reads: the kit draws each label twice, once hidden to reserve its bold width. */
function visibleText(element: Element) {
  const copy = element.cloneNode(true) as Element;
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove();
  return copy.textContent?.trim();
}
const menuItems = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
const menuItem = (name: string) => menuItems().find((row) => visibleText(row) === name);
const criteriaBox = () =>
  document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${criteria.label}"]`);
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (node) => node.textContent === name,
  );
async function settle(ms = 0) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}
async function openCriteria(trigger: HTMLElement | null) {
  expect(trigger).toBeTruthy();
  await act(async () => trigger?.click());
  await act(async () => menuItem(criteria.label)?.click());
  await settle(10);
  expect(criteriaBox()).toBeTruthy();
}
async function type(field: HTMLTextAreaElement | null, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
      field,
      value,
    );
    field?.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const describedError = (field: HTMLElement | null) => {
  const id = field?.getAttribute('aria-describedby');
  return id ? document.getElementById(id)?.textContent : undefined;
};

it('puts Completion criteria after Rename in the session menu and the path’s session menu', async () => {
  const f = await mountCriteria();
  await act(async () => f.actionsMenu?.click());
  const names = menuItems().map(visibleText);
  expect(names.indexOf(criteria.label)).toBe(names.indexOf(messages.Desktop.rename) + 1);
  await act(async () => f.actionsMenu?.click());
  await settle(10);
  await act(async () => f.pathMenu?.click());
  expect(menuItems().map(visibleText)).toEqual([
    messages.Commands.rename,
    criteria.label,
    messages.Commands.pin,
    messages.Commands.archive,
  ]);
});

it('reads the saved criteria and saves the edited lines, trimmed and without blank lines', async () => {
  const f = await mountCriteria();
  f.update.mockResolvedValue({ ok: true, session });
  await openCriteria(f.actionsMenu);
  const box = criteriaBox();
  expect(box?.value).toBe('The build passes');
  // A plain list editor: no state, progress or explanation beside the criteria.
  const dialog = box?.closest('[role="dialog"]');
  expect(
    dialog?.querySelector('[role="checkbox"], [role="progressbar"], svg[role="img"]'),
  ).toBeNull();
  expect(dialog?.textContent).not.toMatch(/\brun\b|met|passed|verified/i);
  await type(box, '  The build passes \n\n  Docs mention the flag  \n');
  await act(async () => button(messages.Sessions.save)?.click());
  await settle();
  expect(f.update).toHaveBeenCalledExactlyOnceWith('session', {
    criteria: ['The build passes', 'Docs mention the flag'],
    expectedRevision: 4,
  });
  await settle(600);
  expect(criteriaBox()).toBeNull();
});

it('clears the criteria by saving an empty list', async () => {
  const f = await mountCriteria();
  f.update.mockResolvedValue({ ok: true, session });
  await openCriteria(f.pathMenu);
  await type(criteriaBox(), '\n  \n');
  await act(async () => button(messages.Sessions.save)?.click());
  await settle();
  expect(f.update).toHaveBeenCalledExactlyOnceWith('session', {
    criteria: [],
    expectedRevision: 4,
  });
});

it.each([
  ['revision_conflict', 'This session was changed elsewhere (revision 5). Reload first.'],
  ['invalid', 'A meeting has no completion criteria.'],
])('keeps what was typed when the save is refused (%s) and says why', async (error, message) => {
  const f = await mountCriteria();
  f.update.mockResolvedValue({ ok: false, error, message });
  await openCriteria(f.actionsMenu);
  await type(criteriaBox(), 'Docs mention the flag');
  await act(async () => button(messages.Sessions.save)?.click());
  await settle(600);
  expect(criteriaBox()?.value).toBe('Docs mention the flag');
  const alert = criteriaBox()?.closest('[role="dialog"]')?.querySelector('[role="alert"]');
  // The words rename uses for the same refusal.
  expect(alert?.textContent).toBe(messages.Sessions.failed.replace('{message}', message));
});

it('says on the field when the criteria pass the limits, and saves nothing then', async () => {
  const f = await mountCriteria();
  await openCriteria(f.actionsMenu);
  const box = criteriaBox();
  expect(box?.getAttribute('aria-invalid')).toBeNull();
  expect(box?.closest('[role="dialog"]')?.textContent).not.toMatch(/\b20\b|\b200\b/);
  await type(box, Array.from({ length: 21 }, (_, index) => `Line ${index}`).join('\n'));
  expect(box?.getAttribute('aria-invalid')).toBe('true');
  expect(describedError(box)).toBe(criteria.tooMany.replace('{max}', '20'));
  await act(async () => button(messages.Sessions.save)?.click());
  await type(box, 'x'.repeat(201));
  expect(describedError(box)).toBe(criteria.tooLong.replace('{line}', '1').replace('{max}', '200'));
  await act(async () => button(messages.Sessions.save)?.click());
  await settle();
  expect(f.update).not.toHaveBeenCalled();
});

it('adds a line on Enter, also while composing, and does not save', async () => {
  const f = await mountCriteria();
  await openCriteria(f.actionsMenu);
  for (const isComposing of [false, true]) {
    const enter = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
      isComposing,
    });
    await act(async () => criteriaBox()?.dispatchEvent(enter));
    expect(enter.defaultPrevented).toBe(false);
  }
  await settle();
  expect(f.update).not.toHaveBeenCalled();
  expect(criteriaBox()).toBeTruthy();
});

it.each(['actionsMenu', 'pathMenu'] as const)(
  'returns focus to the menu it was opened from (%s) when it closes',
  async (opener) => {
    const f = await mountCriteria();
    const trigger = f[opener];
    await openCriteria(trigger);
    await act(async () => button(messages.Sessions.cancel)?.click());
    await settle(600);
    expect(criteriaBox()).toBeNull();
    expect(document.activeElement).toBe(trigger);
  },
);

// A save refused for its revision reads the session again (docs/specs/workbench.md#세션-완료-기준).
const stale = {
  ok: false,
  error: 'revision_conflict',
  message: 'This session was changed elsewhere (revision 5). Reload first.',
};
const stored = (change: Partial<WorkSession>) => ({
  ...session,
  revision: 5,
  criteria: ['The build passes'],
  ...change,
});
/** What the dialog says beside the field: failures and notices alike. */
const dialogNotes = () =>
  [
    ...(criteriaBox()
      ?.closest('[role="dialog"]')
      ?.querySelectorAll('[role="alert"], [role="status"]') ?? []),
  ].map((node) => node.textContent);

it('saves once more with the new revision when only something else changed, and says nothing', async () => {
  const f = await mountCriteria();
  const read = services.repository.getSession as Mock;
  // Renamed elsewhere while the dialog was open; its criteria are as it opened with.
  read.mockResolvedValue(stored({ title: 'Renamed elsewhere' }));
  f.update.mockResolvedValueOnce(stale).mockResolvedValueOnce({ ok: true, session });
  await openCriteria(f.actionsMenu);
  await type(criteriaBox(), 'The build passes\nDocs mention the flag');
  await act(async () => button(messages.Sessions.save)?.click());
  await settle();
  expect(read).toHaveBeenCalledExactlyOnceWith('session');
  expect(f.update.mock.calls).toEqual([
    ['session', { criteria: ['The build passes', 'Docs mention the flag'], expectedRevision: 4 }],
    ['session', { criteria: ['The build passes', 'Docs mention the flag'], expectedRevision: 5 }],
  ]);
  expect(dialogNotes()).toEqual([]);
  await settle(600);
  expect(criteriaBox()).toBeNull();
});

it('says the criteria changed elsewhere and saves nothing more until Save is pressed again', async () => {
  const f = await mountCriteria();
  const read = services.repository.getSession as Mock;
  read.mockResolvedValue(stored({ revision: 6, criteria: ['Someone else wrote this'] }));
  f.update.mockResolvedValueOnce(stale).mockResolvedValueOnce({ ok: true, session });
  await openCriteria(f.actionsMenu);
  await type(criteriaBox(), 'Docs mention the flag');
  await act(async () => button(messages.Sessions.save)?.click());
  await settle(600);
  expect(f.update).toHaveBeenCalledOnce();
  // Not a failure: what happened, with the typed text still there.
  expect(dialogNotes()).toEqual([criteria.changedElsewhere]);
  expect(criteriaBox()?.value).toBe('Docs mention the flag');
  await settle(300);
  expect(f.update).toHaveBeenCalledOnce();
  // Pressing Save again replaces them, against the revision just read.
  await act(async () => button(messages.Sessions.save)?.click());
  await settle();
  expect(f.update).toHaveBeenLastCalledWith('session', {
    criteria: ['Docs mention the flag'],
    expectedRevision: 6,
  });
  expect(read).toHaveBeenCalledOnce();
  await settle(600);
  expect(criteriaBox()).toBeNull();
});

it('retries a refused save at most once and then says it failed', async () => {
  const f = await mountCriteria();
  const read = services.repository.getSession as Mock;
  read.mockResolvedValue(stored({ title: 'Renamed elsewhere' }));
  const again = {
    ...stale,
    message: 'This session was changed elsewhere (revision 6). Reload first.',
  };
  f.update.mockResolvedValueOnce(stale).mockResolvedValue(again);
  await openCriteria(f.actionsMenu);
  await type(criteriaBox(), 'Docs mention the flag');
  await act(async () => button(messages.Sessions.save)?.click());
  await settle(600);
  expect(f.update).toHaveBeenCalledTimes(2);
  expect(read).toHaveBeenCalledOnce();
  expect(dialogNotes()).toEqual([messages.Sessions.failed.replace('{message}', again.message)]);
  expect(criteriaBox()?.value).toBe('Docs mention the flag');
});

it('says the save failed and keeps the text when the session cannot be read again', async () => {
  const f = await mountCriteria();
  const read = services.repository.getSession as Mock;
  read.mockRejectedValue(new Error('The server cannot be reached.'));
  f.update.mockResolvedValue(stale);
  await openCriteria(f.actionsMenu);
  await type(criteriaBox(), 'Docs mention the flag');
  await act(async () => button(messages.Sessions.save)?.click());
  await settle(600);
  expect(f.update).toHaveBeenCalledOnce();
  expect(dialogNotes()).toEqual([
    messages.Sessions.failed.replace('{message}', 'The server cannot be reached.'),
  ]);
  expect(criteriaBox()?.value).toBe('Docs mention the flag');
});
