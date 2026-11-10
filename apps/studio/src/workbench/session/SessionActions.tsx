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
import { Ellipsis, FileDiff, PanelRight, Terminal } from '@corral/react/icons';
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
import { PANE_CATALOG, type SessionPanel } from '../panels/registry.ts';
import { RenameSessionDialog } from '../RenameSessionDialog.tsx';
import { TopbarActions, useTopbarLayout } from '../TopbarSlot.tsx';
import { SessionCriteriaDialog } from './SessionCriteriaDialog.tsx';

/**
 * The control a dialog was opened from: for a menu item (this menu's, the path's or another's),
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
 * The session's own actions, in the top bar: changes, the side panel, and a menu. In the bar's
 * last tier the changes, terminal and side panel fold into the menu (topbarTier.ts).
 */
export function SessionActions({
  session,
  corrals,
  team,
  changes,
  panel,
  onPanel,
  fileViewerOpen,
  onToggleFileViewer,
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
  fileViewerOpen: boolean;
  onToggleFileViewer: (open: boolean) => void;
}) {
  useShortcutBindings();
  const t = useTranslations('Sessions');
  const tw = useTranslations('Workbench');
  const td = useTranslations('Desktop');
  const { repository } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  // The saved lines and the revision they were read at, while the criteria dialog is open; the
  // control it was opened from outlasts it, to take focus back.
  const [criteria, setCriteria] = useState<{ lines: string[]; revision: number } | null>(null);
  const criteriaOpener = useRef<HTMLElement | null>(null);
  const editCriteria = () => {
    criteriaOpener.current = focusOrigin();
    setCriteria({ lines: session.criteria ?? [], revision: session.revision });
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
  // Saved against the revision the dialog opened with: a change made elsewhere since is refused,
  // never overwritten. A run already started keeps the criteria it started with.
  const saveCriteria = async (lines: string[], expectedRevision: number) => {
    const result = await repository.updateSession(session.sessionId, {
      criteria: lines,
      expectedRevision,
    });
    if (!result.ok) return t('failed', { message: result.message });
    projectsChanged();
    await router.invalidate();
    return null;
  };
  const tcmd = useTranslations('Commands');
  const tdock = useTranslations('Docking');
  const { workspaces, terminals } = useServices();
  const panelGroup = tcmd('groups.panel');
  const sessionGroup = tcmd('groups.session');
  useRegisterCommands('session', [
    {
      id: 'panel:toggle',
      title: tcmd('togglePanel'),
      group: panelGroup,
      shortcutId: 'view.panel',
      shortcut: shortcutLabel('view.panel'),
      run: () => onToggleFileViewer(!fileViewerOpen),
    },
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
  ]);
  const changeCount = changes?.length ?? 0;
  const fileViewerLabel = tdock(fileViewerOpen ? 'closeFileViewer' : 'openFileViewer');
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
      {terminals && !folded ? (
        <Tooltip content={tdock('terminal')}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={tdock('terminal')}
            onClick={() => onPanel('terminal')}
          >
            <Terminal />
          </Button>
        </Tooltip>
      ) : null}
      {folded ? null : (
        <Tooltip content={fileViewerLabel} shortcut={shortcutLabel('view.panel')}>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={fileViewerLabel}
            aria-pressed={fileViewerOpen}
            onClick={() => onToggleFileViewer(!fileViewerOpen)}
          >
            <PanelRight />
          </Button>
        </Tooltip>
      )}
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
              {terminals ? (
                <MenuItem onClick={() => onPanel('terminal')}>{tdock('terminal')}</MenuItem>
              ) : null}
              <MenuItem onClick={() => onToggleFileViewer(!fileViewerOpen)}>
                {fileViewerLabel}
              </MenuItem>
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
        </MenuPopup>
      </Menu>
      <RenameSessionDialog
        title={renaming}
        onSave={(title) => update({ title })}
        onClose={() => setRenaming(null)}
      />
      <SessionCriteriaDialog
        criteria={criteria?.lines ?? null}
        opener={criteriaOpener}
        onSave={(lines) =>
          criteria ? saveCriteria(lines, criteria.revision) : Promise.resolve(null)
        }
        onClose={() => setCriteria(null)}
      />
    </TopbarActions>
  );
}
