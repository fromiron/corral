import type { FileChangeView } from '@corral/client';
import type { CorralSummary, WorkSession } from '@corral/core';
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Tooltip,
} from '@corral/react/design-kit';
import { Ellipsis, FileDiff, PanelBottom, PanelRight } from '@corral/react/icons';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type AppCommand, useRegisterCommands } from '../../commandRegistry.ts';
import { WORKSPACE_CHANGED } from '../../pages/FilesViews.tsx';
import { projectsChanged } from '../../projects.ts';
import { useServices } from '../../services.tsx';
import { useShortcutBindings } from '../../shortcutBindings.ts';
import { shortcutLabel } from '../../shortcuts.ts';
import { ChatDensityMenu } from '../ChatView.tsx';
import { forgetDeletedTree } from '../fileTreeState.ts';
import { deviceStorage, forgetPanelMemory } from '../panel/memory.ts';
import { PANE_CATALOG, type SessionPanel } from '../panels/registry.ts';
import { RenameSessionDialog } from '../RenameSessionDialog.tsx';
import { SessionDeletionDialog } from '../SessionDeletionDialog.tsx';
import { TopbarActions, useTopbarLayout } from '../TopbarSlot.tsx';
import { type CriteriaSave, SessionCriteriaDialog } from './SessionCriteriaDialog.tsx';

const sameLines = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((line, index) => line === b[index]);

/**
 * The control a dialog was opened from: for a menu item (this menu's or another's),
 * the trigger of its menu, which stays when the item is gone; else whatever had focus.
 */
function focusOrigin(): HTMLElement | null {
  const active = document.activeElement;
  const focused = active instanceof HTMLElement && active !== document.body ? active : null;
  const menu = focused ? focused.closest('[role="menu"]') : document.querySelector('[role="menu"]');
  if (!menu?.id) return focused;
  return (
    [...document.querySelectorAll<HTMLElement>('[aria-controls]')].find(
      (control) => control.getAttribute('aria-controls') === menu.id,
    ) ?? focused
  );
}

/**
 * The session's own actions, in the top bar: changes, the bottom dock's button, the panel's
 * toggle and a menu. In the bar's last tier the changes fold into the menu (topbarTier.ts); the
 * two toggles never do.
 */
export function SessionActions({
  session,
  corrals,
  team,
  changes,
  panel,
  onPanel,
  panelToggle,
  dockToggle,
  onEditTeam,
}: {
  session: WorkSession;
  corrals: CorralSummary[];
  team: CorralSummary | null;
  /** Opens the saved team as a dock tab; false when it could not, so the route opens it. */
  onEditTeam: (corralId: string) => boolean;
  changes: FileChangeView[] | null;
  panel: SessionPanel | undefined;
  onPanel: (panel: SessionPanel | undefined) => void;
  /**
   * The panel beside the conversation: pressed while it is on screen. Null when the
   * conversation has no tab open and nothing it could open (features/session-panel.md).
   */
  panelToggle: { pressed: boolean; onToggle: () => void } | null;
  /**
   * The bottom dock under the conversation and the panel: pressed while it is open (withdrawn
   * included). Its dot says a running terminal, or one whose end needs confirming, is off
   * screen while the dock is closed (features/session-panel.md 하단 도크). Null without terminals.
   */
  dockToggle?: {
    pressed: boolean;
    dot: 'running' | 'warning' | null;
    onToggle: () => void;
  } | null;
}) {
  useShortcutBindings();
  const t = useTranslations('Sessions');
  const tw = useTranslations('Workbench');
  const td = useTranslations('Desktop');
  const { repository, sessionDeletion } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  // The saved lines the criteria dialog opened with, while it is open; the control it was opened
  // from outlasts it, to take focus back. `criteriaBase` is what a save is checked against: the
  // stored lines as last read and their revision.
  const [criteria, setCriteria] = useState<string[] | null>(null);
  const criteriaOpener = useRef<HTMLElement | null>(null);
  const criteriaBase = useRef<{ lines: string[]; revision: number }>({ lines: [], revision: 0 });
  const editCriteria = () => {
    criteriaOpener.current = focusOrigin();
    const lines = session.criteria ?? [];
    criteriaBase.current = { lines, revision: session.revision };
    setCriteria(lines);
  };
  const folded = useTopbarLayout().tools === 'menu';
  const update = async (change: {
    corralId?: string | null;
    pinned?: boolean;
    archived?: boolean;
    title?: string;
  }) => {
    const result = await repository.updateSession(session.sessionId, {
      ...change,
      expectedRevision: session.revision,
    });
    if (!result.ok) {
      setError(t('failed', { message: result.message }));
      return false;
    }
    setError(null);
    projectsChanged();
    await router.invalidate();
    return true;
  };
  // Saved against the revision last read (docs/specs/workbench.md#세션-완료-기준). Refused for
  // that revision, the session is read again: if only something else changed (its name, its pin)
  // the save is tried once more with the new revision; if the criteria themselves changed
  // elsewhere, the dialog says so and the next Save replaces them. Never more than one retry per
  // press. A run already started keeps the criteria it started with.
  const saveCriteria = async (lines: string[]): Promise<CriteriaSave> => {
    const sessionId = session.sessionId;
    const base = criteriaBase.current;
    if (sameLines(lines, base.lines)) return { kind: 'saved' };
    const write = (expectedRevision: number) =>
      repository.updateSession(sessionId, { criteria: lines, expectedRevision });
    const saved = async () => {
      projectsChanged();
      await router.invalidate();
      return { kind: 'saved' } as const;
    };
    const failed = (message: string) =>
      ({ kind: 'failed', message: t('failed', { message }) }) as const;
    const first = await write(base.revision);
    if (first.ok) return saved();
    if (first.error !== 'revision_conflict') return failed(first.message);
    let current: WorkSession | null;
    try {
      current = await repository.getSession(sessionId);
    } catch (failure) {
      return failed(failure instanceof Error ? failure.message : String(failure));
    }
    if (!current) return failed(first.message);
    const stored = current.criteria ?? [];
    criteriaBase.current = { lines: stored, revision: current.revision };
    if (!sameLines(stored, base.lines))
      return { kind: 'notice', message: t('criteria.changedElsewhere') };
    const second = await write(current.revision);
    return second.ok ? saved() : failed(second.message);
  };
  const tcmd = useTranslations('Commands');
  const tdock = useTranslations('Docking');
  const { workspaces } = useServices();
  const panelGroup = tcmd('groups.panel');
  const sessionGroup = tcmd('groups.session');
  const tpanel = useTranslations('SessionPanel');
  const tterm = useTranslations('Terminals');
  useRegisterCommands('session', [
    ...(panelToggle
      ? [
          {
            id: 'panel:toggle',
            title: tpanel('toggle'),
            group: panelGroup,
            shortcutId: 'view.panel',
            shortcut: shortcutLabel('view.panel'),
            run: panelToggle.onToggle,
          } satisfies AppCommand,
        ]
      : []),
    ...(dockToggle
      ? [
          {
            id: 'dock:toggle',
            title: tpanel('dockToggle'),
            group: panelGroup,
            shortcutId: 'view.dock',
            shortcut: shortcutLabel('view.dock'),
            run: dockToggle.onToggle,
          } satisfies AppCommand,
        ]
      : []),
    // Every pane from the one catalog: its dock name, its `/` name and the words other screens
    // use for it (#70, #86).
    ...PANE_CATALOG.map(
      (entry): AppCommand => ({
        id: `panel:${entry.view}`,
        title: tcmd('openPanel', { panel: tdock(entry.view) }),
        group: panelGroup,
        keywords: [...entry.aliases, entry.slash],
        slash: entry.slash,
        run: () => onPanel(entry.view),
      }),
    ),
    {
      id: 'git:commit',
      title: tcmd('gitCommit'),
      group: sessionGroup,
      keywords: ['git', 'commit', 'stage'],
      disabled: !workspaces,
      hint: workspaces ? undefined : tw('serverOnly'),
      run: () => {
        onPanel('git');
        // The commit box appears once the Git pane has read the index.
        let tries = 0;
        const focus = () => {
          const box = document.getElementById('git-commit-message');
          if (box) box.focus();
          else if (++tries < 40) window.setTimeout(focus, 50);
        };
        focus();
      },
    },
    {
      id: 'session:review',
      title: tcmd('review'),
      group: sessionGroup,
      slash: 'review',
      disabled: !workspaces,
      hint: workspaces ? undefined : tw('serverOnly'),
      run: () =>
        navigate({ to: '/sessions/$sessionId/review', params: { sessionId: session.sessionId } }),
    },
    {
      id: 'session:copy',
      title: tcmd('makeCopy'),
      group: sessionGroup,
      slash: 'copy',
      disabled: !workspaces,
      hint: workspaces ? undefined : tw('serverOnly'),
      run: async () => {
        if (!workspaces) return;
        try {
          const existing = await workspaces.worktree(session.sessionId).catch(() => null);
          if (existing && !existing.missing) return setError(tcmd('copyExists'));
          await workspaces.createWorktree(session.sessionId);
          window.dispatchEvent(new Event(WORKSPACE_CHANGED));
          onPanel('changes');
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        }
      },
    },
    {
      id: 'session:rename',
      title: tcmd('rename'),
      group: sessionGroup,
      slash: 'rename',
      run: () => setRenaming(session.title),
    },
    {
      id: 'session:criteria',
      title: t('criteria.label'),
      group: sessionGroup,
      run: editCriteria,
    },
    {
      id: 'session:pin',
      title: session.pinned ? tcmd('unpin') : tcmd('pin'),
      group: sessionGroup,
      slash: session.pinned ? 'unpin' : 'pin',
      run: () => void update({ pinned: !session.pinned }),
    },
    {
      id: 'session:archive',
      title: session.archivedAt ? tcmd('restore') : tcmd('archive'),
      group: sessionGroup,
      slash: session.archivedAt ? 'restore' : 'archive',
      run: () => void update({ archived: !session.archivedAt }),
    },
    ...(sessionDeletion
      ? [
          {
            id: 'session:delete',
            title: tcmd('deleteSession'),
            group: sessionGroup,
            slash: 'delete',
            run: () => setDeleting(true),
          },
        ]
      : []),
  ]);
  const changeCount = changes?.length ?? 0;
  return (
    // The selected team is read from the composer's chip and this menu's team line, not the bar.
    <TopbarActions>
      {error ? (
        <p role="alert" className="max-w-64 truncate text-caption text-danger" title={error}>
          {error}
        </p>
      ) : null}
      {folded ? null : changeCount > 0 ? (
        <Button
          variant="ghost"
          size="compact"
          aria-pressed={panel === 'changes'}
          onClick={() => onPanel(panel === 'changes' ? undefined : 'changes')}
          className="gap-1.5 text-muted-foreground"
        >
          <FileDiff />
          {tw('sessionChangeCount', { count: changeCount })}
        </Button>
      ) : null}
      {/* The bottom dock's button never folds into the menu, in any panel state. */}
      {dockToggle ? (
        <Tooltip content={tpanel('dock')} shortcut={shortcutLabel('view.dock')}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={tpanel('dock')}
            aria-pressed={dockToggle.pressed}
            aria-description={
              dockToggle.dot
                ? tterm(dockToggle.dot === 'warning' ? 'uncertainTab' : 'runningTab')
                : undefined
            }
            data-session-dock-toggle=""
            className="relative"
            onClick={dockToggle.onToggle}
          >
            <PanelBottom />
            {dockToggle.dot ? (
              <span
                aria-hidden="true"
                data-dock-dot={dockToggle.dot}
                className={`absolute top-1 right-1 size-1.5 rounded-full ${
                  dockToggle.dot === 'warning' ? 'bg-warning' : 'bg-emphasis'
                }`}
              />
            ) : null}
          </Button>
        </Tooltip>
      ) : null}
      {/* The panel's toggle never folds into the menu. */}
      {panelToggle ? (
        <Tooltip content={tpanel('toggle')} shortcut={shortcutLabel('view.panel')}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={tpanel('toggle')}
            aria-pressed={panelToggle.pressed}
            data-session-panel-toggle=""
            onClick={panelToggle.onToggle}
          >
            <PanelRight />
          </Button>
        </Tooltip>
      ) : null}
      <Menu>
        <Tooltip content={td('sessionActions', { title: session.title })}>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-compact"
                aria-label={td('sessionActions', { title: session.title })}
              />
            }
          >
            <Ellipsis />
          </MenuTrigger>
        </Tooltip>
        <MenuPopup align="end" className="min-w-52">
          {/* The page's display choice leads its menu. */}
          <ChatDensityMenu />
          <MenuSeparator />
          {folded ? (
            <>
              {changeCount > 0 ? (
                <MenuItem onClick={() => onPanel(panel === 'changes' ? undefined : 'changes')}>
                  {tw('sessionChangeCount', { count: changeCount })}
                </MenuItem>
              ) : null}
              <MenuSeparator />
            </>
          ) : null}
          <MenuItem onClick={() => setRenaming(session.title)}>{td('rename')}</MenuItem>
          <MenuItem onClick={editCriteria}>{t('criteria.label')}</MenuItem>
          <MenuSub>
            <MenuSubTrigger>
              {t('chooseTeam')}
              <span className="ml-auto max-w-40 truncate pl-3 text-caption text-muted-foreground">
                {team
                  ? `${team.name} · r${team.definitionRevision}`
                  : session.corralId
                    ? t('selectedTeamUnavailable')
                    : t('autoTeam')}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup
                value={session.corralId ?? ''}
                onValueChange={(value) => void update({ corralId: String(value) || null })}
              >
                <MenuRadioItem value="" closeOnClick>
                  {t('autoTeam')}
                </MenuRadioItem>
                {session.corralId && !team ? (
                  <MenuRadioItem value={session.corralId} disabled>
                    {t('selectedTeamUnavailable')}
                  </MenuRadioItem>
                ) : null}
                {corrals.map((c) => (
                  <MenuRadioItem key={c.corralId} value={c.corralId} closeOnClick>
                    {c.name}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          {team ? (
            <MenuItem
              onClick={() => {
                if (!onEditTeam(team.corralId))
                  void navigate({
                    to: '/corrals/$corralId/edit',
                    params: { corralId: team.corralId },
                    search: { fromSession: session.sessionId },
                  });
              }}
            >
              {t('editTeam')}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => void update({ pinned: !session.pinned })}>
            {session.pinned ? t('unpin') : t('pin')}
          </MenuItem>
          <MenuItem onClick={() => void update({ archived: !session.archivedAt })}>
            {session.archivedAt ? t('restore') : t('archive')}
          </MenuItem>
          {sessionDeletion ? (
            <MenuItem onClick={() => setDeleting(true)}>{t('delete')}</MenuItem>
          ) : null}
        </MenuPopup>
      </Menu>
      <RenameSessionDialog
        title={renaming}
        onSave={(title) => update({ title })}
        onClose={() => setRenaming(null)}
      />
      <SessionCriteriaDialog
        criteria={criteria}
        opener={criteriaOpener}
        onSave={saveCriteria}
        onClose={() => setCriteria(null)}
      />
      <SessionDeletionDialog
        open={deleting}
        sessionId={session.sessionId}
        projectId={session.projectId}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          // A deleted conversation's panel is not remembered on this device either.
          forgetPanelMemory(deviceStorage(), session.sessionId);
          forgetDeletedTree(deviceStorage(), session.sessionId);
          projectsChanged();
          void router.invalidate();
          void navigate({
            to: '/projects/$projectId',
            params: { projectId: session.projectId },
          });
        }}
      />
    </TopbarActions>
  );
}
