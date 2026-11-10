import type { InboxItemView, WorkspaceBindingView, WorktreeView } from '@corral/client';
import {
  type CorralSummary,
  DEFAULT_PROJECT_ID,
  type ProjectSummary,
  type RunSummary,
  type WorkSession,
} from '@corral/core';
import {
  Button,
  cn,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  EmptyState,
  InputField,
  InputGroup,
  KitBadge,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  Page,
  SectionLabel,
  Select,
  TabItem,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TabPanel,
  Tabs,
  TabsList,
  Textarea,
  useSize,
} from '@corral/react/design-kit';
import { ArrowRight, ChevronDown, Ellipsis, MessageCircle, Users } from '@corral/react/icons';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { type FormEvent, useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectName, projectsChanged, setCurrentProject } from '../projects.ts';
import { workspaceRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { createFromTemplate, WORKSPACE_TEMPLATES } from '../templates.ts';
import { NewMeetingDialog } from '../workbench/NewMeeting.tsx';
import { useSettingsNavigation, workHref } from '../workbench/navigation.ts';
import { newSessionDraftKey } from '../workbench/newSessionDraft.ts';
import { ProjectMaterials } from '../workbench/ProjectMaterials.tsx';
import { isSendKey, usePreferences } from '../workbench/preferences.ts';
import { RunList } from '../workbench/RunList.tsx';
import { writeDraft } from '../workbench/sessionDraft.ts';
import {
  latestSessionRun,
  sessionListState,
  uncertainSessionTerminal,
} from '../workbench/sessionList.ts';
import { useModelProfiles } from '../workbench/useModels.ts';
import { useSessionAge } from '../workbench/useSessionAge.ts';
import { WORKSPACE_CHANGED } from '../workbench/workspaceEvents.ts';
import { useRemembered, WorkbenchLayout } from './Workbench.tsx';

// A project's workspace (docs/specs/workbench.md#전역-셸과-화면-틀): the kit page frame with the
// project's name, folder state, pending count and actions, then Sessions · Runs · Environment ·
// Instructions & memory. Teams live in the library.

export function WorkspacePage() {
  const t = useTranslations('Workspace');
  const tp = useTranslations('Projects');
  const tm = useTranslations('Meetings');
  const { project, corrals, runs, sessions } = workspaceRoute.useLoaderData();
  const projectId = project.projectId;
  const archived = project.archivedAt !== null;
  useEffect(() => setCurrentProject(projectId), [projectId]);
  const navigate = useNavigate();
  const href = useRouterState({ select: (state) => state.location.href });
  const [errors, setErrors] = useState<string[]>([]);
  const inboxItems = useProjectInbox(projectId);
  const folder = useFolder(projectId);
  // Roadmap 16: two runs picked for comparison, oldest choice dropped past two.
  const [picked, setPicked] = useState<string[]>([]);
  const tc = useTranslations('Compare');
  const pick = (runId: string, on: boolean) =>
    setPicked(
      on
        ? [...picked.filter((id) => id !== runId), runId].slice(-2)
        : picked.filter((id) => id !== runId),
    );
  const { newSession } = workspaceRoute.useSearch();
  const [meeting, setMeeting] = useState(false);
  const shown = projectName(project, tp('defaultName'));
  const inboxReturn = workHref(href);

  const runsPanel = (
    <section aria-labelledby="runs-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="runs-heading" className="sr-only">
          {t('runsHeading')}
        </h2>
        {picked.length === 2 ? (
          <Button
            variant="tertiary"
            size="compact"
            className="ml-auto"
            onClick={() =>
              void navigate({ to: '/compare', search: { a: picked[0], b: picked[1] } })
            }
          >
            {tc('choose', { count: 2 })}
          </Button>
        ) : null}
      </div>
      {runs.length === 0 ? (
        <p className="text-body text-muted-foreground">{t('runsEmpty')}</p>
      ) : (
        <RunList runs={runs} sessions={sessions} picked={picked} onPick={pick} />
      )}
    </section>
  );

  return (
    <WorkbenchLayout
      main={
        <main className="flex min-h-0 flex-1 flex-col">
          <Page
            title={shown}
            toolbar={
              <div className="flex flex-col gap-3">
                {/* State on the left, the ways to start and the project's menu on the right. */}
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
                  <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-2">
                    {archived ? (
                      <KitBadge variant="dot" size="compact" color="gray">
                        {tp('archived')}
                      </KitBadge>
                    ) : null}
                    <FolderBadge folder={folder} />
                    {inboxItems.length > 0 ? (
                      <Button
                        variant="ghost"
                        size="compact"
                        render={
                          <Link to="/inbox" search={inboxReturn ? { returnTo: inboxReturn } : {}} />
                        }
                      >
                        {t('pending', { count: inboxItems.length })}
                        <ArrowRight aria-hidden />
                      </Button>
                    ) : null}
                  </div>
                  {/* The row fills from its end, so when it wraps New conversation takes the
                      first line alone and the menu stays beside New meeting; the reversed order
                      and direction cancel out, so it still reads left to right in source order. */}
                  <div className="flex flex-row-reverse flex-wrap-reverse items-center justify-end gap-2 [&>*]:order-2 [&>:first-child]:order-3 [&>:last-child]:order-1">
                    {archived ? null : (
                      <>
                        <NewConversation
                          key={`${projectId}:${newSession ? 'new' : 'start'}`}
                          focus={Boolean(newSession)}
                          projectId={projectId}
                          corrals={corrals}
                        />
                        <Button variant="secondary" onClick={() => setMeeting(true)}>
                          <Users aria-hidden />
                          {tm('new')}
                        </Button>
                      </>
                    )}
                    <ProjectMenu
                      project={project}
                      returnTo={href}
                      onError={(message) => setErrors([message])}
                    />
                  </div>
                </div>
                {project.archivedAt ? (
                  <p role="note" className="text-body text-warning">
                    {tp('archivedNote')}
                  </p>
                ) : null}
                {errors.length > 0 ? (
                  <div role="alert" className="text-body text-destructive">
                    {errors.map((error) => (
                      <p key={error}>{error}</p>
                    ))}
                  </div>
                ) : null}
              </div>
            }
          >
            <ProjectTabs
              projectId={projectId}
              counts={{ sessions: sessions.filter((x) => !x.archivedAt).length, runs: runs.length }}
              sessions={
                <SessionList
                  sessions={sessions}
                  runs={runs}
                  attention={inboxItems}
                  archived={archived}
                />
              }
              runs={runsPanel}
              environment={
                <EnvironmentPanel projectId={projectId} folder={folder} sessions={sessions} />
              }
              materials={<ProjectMaterials key={projectId} projectId={projectId} />}
            />
            {meeting ? (
              <NewMeetingDialog projectId={projectId} onClose={() => setMeeting(false)} />
            ) : null}
          </Page>
        </main>
      }
    />
  );
}

/** The project's pending items, as the Sessions tab's pending actions count them. */
function useProjectInbox(projectId: string) {
  const { workspaces } = useServices();
  const [items, setItems] = useState<InboxItemView[]>([]);
  useEffect(() => {
    setItems([]);
    if (!workspaces) return;
    let live = true;
    const load = () =>
      workspaces.inbox(projectId).then(
        (list) => {
          if (live) setItems(list);
        },
        () => {},
      );
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workspaces, projectId]);
  return items;
}

type Folder =
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'failed' }
  | { state: 'ready'; binding: WorkspaceBindingView };

/** The linked source folder; a failed read is "unknown", never "no folder". */
function useFolder(projectId: string): Folder {
  const { workspaces } = useServices();
  const [folder, setFolder] = useState<Folder>({ state: 'loading' });
  const reload = useCallback(async () => {
    if (!workspaces) return setFolder({ state: 'none' });
    try {
      const binding = await workspaces.binding(projectId);
      setFolder(binding ? { state: 'ready', binding } : { state: 'none' });
    } catch {
      setFolder({ state: 'failed' });
    }
  }, [workspaces, projectId]);
  useEffect(() => {
    void reload();
    // Linking, unlinking or trusting in the settings dialog changes what this shows.
    const changed = () => void reload();
    window.addEventListener(WORKSPACE_CHANGED, changed);
    return () => window.removeEventListener(WORKSPACE_CHANGED, changed);
  }, [reload]);
  return folder;
}

function folderState(folder: Folder) {
  if (folder.state !== 'ready') return folder.state === 'failed' ? 'unknown' : folder.state;
  return folder.binding.missing ? 'missing' : !folder.binding.trusted ? 'untrusted' : 'ready';
}

const FOLDER_TONE = {
  loading: 'gray',
  none: 'gray',
  unknown: 'gray',
  missing: 'red',
  untrusted: 'amber',
  ready: 'green',
} as const;

function FolderBadge({ folder }: { folder: Folder }) {
  const t = useTranslations('Workspace.folder');
  if (folder.state === 'loading') return null;
  const state = folderState(folder);
  return (
    <KitBadge variant="dot" size="compact" color={FOLDER_TONE[state]}>
      {t(state)}
    </KitBadge>
  );
}

type ProjectTab = 'sessions' | 'runs' | 'environment' | 'materials';
const TABS: ProjectTab[] = ['sessions', 'runs', 'environment', 'materials'];

/** The project's lists, one at a time; the choice is remembered per project. */
function ProjectTabs({
  projectId,
  counts,
  ...panels
}: Record<ProjectTab, React.ReactNode> & {
  projectId: string;
  counts: { sessions: number; runs: number };
}) {
  const t = useTranslations('Projects');
  const hash = useRouterState({ select: (s) => s.location.hash });
  const navigate = useNavigate({ from: '/projects/$projectId' });
  const [saved, setTab] = useRemembered<ProjectTab | null>(`corral:project-tab:${projectId}`, null);
  // A saved tab or an explicit runs link is an intentional choice. First visits start with
  // conversations; designing a Corral is never a prerequisite for sending a request.
  const tab: ProjectTab =
    hash === 'runs' ? 'runs' : saved && TABS.includes(saved) ? saved : 'sessions';
  const chooseTab = (value: ProjectTab) => {
    setTab(value);
    if (hash === 'runs') void navigate({ hash: '', search: (search) => search, replace: true });
  };
  const label = (value: ProjectTab) => {
    const name = t(`tab.${value}`);
    const count = value === 'sessions' || value === 'runs' ? counts[value] : 0;
    return count ? `${name} ${count}` : name;
  };
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => chooseTab(value as ProjectTab)}
      className="flex min-w-0 flex-col gap-4"
    >
      {/* The strip hugs its tabs and scrolls inside itself when the page is narrower. */}
      <TabsList
        aria-label={t('tabsLabel')}
        className="scrollbar-hide max-w-full self-start overflow-x-auto"
      >
        {TABS.map((value) => (
          <TabItem key={value} value={value} label={label(value)} />
        ))}
      </TabsList>
      <TabPanel value={tab} className="min-w-0">
        {panels[tab]}
      </TabPanel>
    </Tabs>
  );
}

/**
 * The project's "more" menu: rename, archive or restore, the way to all projects, and the task
 * board preview, which shows sample data and comes back here (docs/specs/features/feature-preview.md).
 */
function ProjectMenu({
  project,
  returnTo,
  onError,
}: {
  project: ProjectSummary;
  returnTo: string;
  onError: (message: string) => void;
}) {
  const t = useTranslations('Projects');
  const tw = useTranslations('Workspace');
  const { repository } = useServices();
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const shown = projectName(project, t('defaultName'));

  const update = async (change: { name?: string; description?: string; archived?: boolean }) => {
    const result = await repository.updateProject(project.projectId, {
      ...change,
      expectedRevision: project.revision,
    });
    if (!result.ok) return onError(t('failed', { message: result.message }));
    setEditing(false);
    projectsChanged();
    await router.invalidate();
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    void update({ name, description });
  };

  return (
    <>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon" aria-label={t('actions', { name: shown })} />}
        >
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-52">
          <MenuItem
            onClick={() => {
              setName(shown);
              setDescription(project.description);
              setEditing(true);
            }}
          >
            {t('rename')}
          </MenuItem>
          {project.projectId === DEFAULT_PROJECT_ID ? null : (
            <MenuItem onClick={() => void update({ archived: !project.archivedAt })}>
              {project.archivedAt ? t('restore') : t('archive')}
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem render={<Link to="/projects" />}>{t('allProjects')}</MenuItem>
          <MenuSeparator />
          <MenuItem
            render={
              <Link
                to="/preview/$feature"
                params={{ feature: 'task-board' }}
                search={{ returnTo }}
              />
            }
          >
            {tw('taskBoardPreview')}
            <KitBadge size="compact" color="gray" className="ml-auto">
              {tw('previewBadge')}
            </KitBadge>
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={editing} onOpenChange={(open) => !open && setEditing(false)}>
        <DialogPopup>
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>{t('rename')}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <InputGroup className="w-full">
                <InputField
                  index={0}
                  label={t('nameLabel')}
                  id="project-name"
                  value={name}
                  onChange={setName}
                  maxLength={80}
                  required
                />
                <InputField
                  index={1}
                  label={t('descriptionLabel')}
                  id="project-description"
                  value={description}
                  onChange={setDescription}
                  maxLength={500}
                />
              </InputGroup>
            </DialogPanel>
            <DialogFooter>
              <Button variant="tertiary" onClick={() => setEditing(false)}>
                {t('cancel')}
              </Button>
              <Button type="submit">{t('save')}</Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

/**
 * Starts a conversation at once. Its menu opens the name, purpose and team first; those details
 * are remembered for the project and nothing runs until the first request is sent.
 */
function NewConversation({
  focus,
  projectId,
  corrals,
}: {
  focus: boolean;
  projectId: string;
  corrals: CorralSummary[];
}) {
  const t = useTranslations('Sessions');
  const tw = useTranslations('Workspace');
  const n = useTranslations('Navigation');
  const { repository } = useServices();
  const { sendKey } = usePreferences();
  const navigate = useNavigate();
  const router = useRouter();
  const startButton = useRef<HTMLButtonElement>(null);
  const creating = useRef(false);
  const active = useRef(true);
  const automatic = useRef(false);
  const [draft, saveDraft] = useRemembered(newSessionDraftKey(projectId), {
    title: '',
    objective: '',
    corralId: '',
  });
  const title = typeof draft?.title === 'string' ? draft.title : '';
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const objective = typeof draft?.objective === 'string' ? draft.objective : '';
  const corralId = typeof draft?.corralId === 'string' ? draft.corralId : '';
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UX-09: a suggested team (a template) can be chosen here; it is made when the session starts,
  // so trying a team never needs the graph editor.
  const suggested = WORKSPACE_TEMPLATES.filter((id) => id !== 'blank');
  const isSuggested = (value: string) =>
    value.startsWith('template:') && suggested.includes(value.slice(9) as never);
  // without a chosen team ('') the session starts in auto mode.
  const chooseTeam = (available: CorralSummary[]) =>
    available.some((c) => c.corralId === corralId) || isSuggested(corralId) ? corralId : '';
  const team = chooseTeam(corrals);
  const hasDetails = Boolean(title || objective || corralId);
  // Saved details show on the way back to them while the form is closed: the name, else the
  // start of the purpose, else the team chosen (workbench.md, 세션 목록과 검색).
  const savedHint =
    title.trim() ||
    objective.trim().split('\n')[0]?.trim() ||
    corrals.find((c) => c.corralId === team)?.name ||
    (isSuggested(team) ? tw('suggestedTeam', { name: tw(`template.${team.slice(9)}.name`) }) : '');
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    if (creating.current) return;
    creating.current = true;
    const submittedDraft = JSON.stringify(draftRef.current);
    setSaving(true);
    setError(null);
    try {
      // A cached project loader may still predate an import when the new-session link opens.
      let teamId = focus
        ? chooseTeam((await repository.list()).filter((item) => item.projectId === projectId))
        : team;
      if (!active.current) return;
      if (isSuggested(teamId)) {
        const id = teamId.slice(9) as (typeof suggested)[number];
        const made = await createFromTemplate(repository, id, tw(`template.${id}.name`), projectId);
        if (!made.ok) return setError(made.message);
        teamId = made.corralId;
      }
      const result = await repository.createSession({
        projectId,
        title: title.trim() || (objective.trim() ? '' : t('new')),
        autoTitle: !title.trim() && !objective.trim(),
        objective,
        corralId: teamId || null,
      });
      if (!result.ok) return setError(result.message);
      writeDraft(result.session.sessionId, objective);
      projectsChanged();
      // A completed background creation must not dismiss the person's settings or retarget work.
      if (!active.current || router.state.location.search.settings) return;
      if (JSON.stringify(draftRef.current) === submittedDraft)
        saveDraft({ title: '', objective: '', corralId: '' });
      await navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: result.session.sessionId },
        replace: focus,
      });
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      creating.current = false;
      if (active.current) setSaving(false);
    }
  };

  // Saved details are never sent silently: with them, starting shows them first.
  const start = () => {
    if (hasDetails) setDetailsOpen(true);
    else void create();
  };

  // The explicit new-session link opens the composer once; it never starts a Run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: later form edits must not create another session
  useEffect(() => {
    if (!focus || automatic.current) return;
    automatic.current = true;
    start();
  }, [focus]);

  return (
    <>
      <div className="flex items-center gap-1">
        <Button disabled={saving} onClick={start}>
          {tw('newConversation')}
        </Button>
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="secondary"
                size="icon"
                disabled={saving}
                aria-label={tw('newConversationMenu')}
              />
            }
          >
            <ChevronDown />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem
              label={savedHint ? `${tw('detailsFirst')} · ${savedHint}` : tw('detailsFirst')}
              onClick={() => setDetailsOpen(true)}
            >
              {savedHint ? (
                <span className="flex w-full min-w-0 items-center gap-3">
                  <span className="shrink-0">{tw('detailsFirst')}</span>
                  <span
                    data-testid="new-conversation-draft"
                    className="ml-auto max-w-48 truncate text-caption text-muted-foreground"
                  >
                    {savedHint}
                  </span>
                </span>
              ) : (
                tw('detailsFirst')
              )}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
      {error && !detailsOpen ? (
        <p role="alert" className="basis-full text-body text-destructive">
          {error}
        </p>
      ) : null}
      <Dialog
        open={detailsOpen}
        onOpenChange={(open) => {
          if (!open && !saving) setDetailsOpen(false);
        }}
      >
        <DialogPopup initialFocus={startButton} className="w-[min(95vw,560px)]">
          <form onSubmit={create} aria-label={t('new')}>
            <DialogHeader>
              <DialogTitle>{tw('newConversation')}</DialogTitle>
              <DialogDescription>{n('optionalPurposeHint')}</DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-3">
                <Select
                  variant="chip"
                  disabled={saving}
                  label={t('teamLabel')}
                  value={team}
                  onValueChange={(value) => {
                    if (!creating.current) saveDraft({ title, objective, corralId: value });
                  }}
                  options={[
                    { value: '', label: t('autoTeam') },
                    ...corrals.map((c) => ({ value: c.corralId, label: c.name })),
                    ...suggested.map((id) => ({
                      value: `template:${id}`,
                      label: tw('suggestedTeam', { name: tw(`template.${id}.name`) }),
                      hint: tw(`template.${id}.body`),
                    })),
                  ]}
                />
                <InputGroup className="w-full">
                  <InputField
                    index={0}
                    label={n('sessionName')}
                    id={`new-session-title-${projectId}`}
                    disabled={saving}
                    value={title}
                    onChange={(value) => saveDraft({ title: value, objective, corralId })}
                  />
                </InputGroup>
                <label
                  htmlFor={`new-session-objective-${projectId}`}
                  className="flex flex-col gap-1 text-caption text-muted-foreground"
                >
                  <span className="pl-2.5">{t('objectiveLabel')}</span>
                  <Textarea
                    id={`new-session-objective-${projectId}`}
                    disabled={saving}
                    aria-label={t('objectiveLabel')}
                    placeholder={t('objectivePlaceholder')}
                    value={objective}
                    rows={3}
                    onChange={(e) => saveDraft({ title, objective: e.target.value, corralId })}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (isSendKey(e, sendKey)) {
                        e.preventDefault();
                        void create();
                      }
                    }}
                  />
                </label>
                {error ? (
                  <p role="alert" className="text-body text-destructive">
                    {error}
                  </p>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button ref={startButton} type="submit" disabled={saving}>
                {tw('startChat')}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}

type Copy =
  | { state: 'none' }
  | { state: 'unknown' }
  | {
      state: 'copy';
      worktree: WorktreeView;
      git: { branch: string | null; changed: number } | null;
    };

/** Each active session's working copy and its Git state; what cannot be read stays unknown. */
function useWorkingCopies(sessions: WorkSession[]) {
  const { workspaces } = useServices();
  const [copies, setCopies] = useState<Map<string, Copy> | null>(null);
  const ids = sessions
    .filter((session) => !session.archivedAt)
    .map((session) => session.sessionId)
    .join('\n');
  useEffect(() => {
    if (!workspaces) return setCopies(new Map());
    let live = true;
    setCopies(null);
    const read = async (sessionId: string): Promise<Copy> => {
      const worktree = await workspaces.worktree(sessionId).catch(() => undefined);
      if (worktree === undefined) return { state: 'unknown' };
      if (!worktree) return { state: 'none' };
      if (worktree.missing) return { state: 'copy', worktree, git: null };
      // A tab that was left starts no Git inspection.
      if (!live) return { state: 'unknown' };
      const status = await workspaces
        .gitStatus({ kind: 'session', id: sessionId })
        .catch(() => null);
      return {
        state: 'copy',
        worktree,
        git: status ? { branch: status.head.branch, changed: status.entries.length } : null,
      };
    };
    void (async () => {
      const queue = ids ? ids.split('\n') : [];
      const found = new Map<string, Copy>();
      // A few at a time: a project can hold hundreds of sessions.
      await Promise.all(
        Array.from({ length: Math.min(4, queue.length) }, async () => {
          const next = () => (live ? queue.shift() : undefined);
          for (let id = next(); id !== undefined; id = next()) found.set(id, await read(id));
        }),
      );
      if (live) setCopies(found);
    })();
    return () => {
      live = false;
    };
  }, [workspaces, ids]);
  return copies;
}

/** The source folder, and each session's working copy (path, branch, uncommitted, session). */
function EnvironmentPanel({
  projectId,
  folder,
  sessions,
}: {
  projectId: string;
  folder: Folder;
  sessions: WorkSession[];
}) {
  const t = useTranslations('Workspace.environment');
  const tf = useTranslations('Workspace.folder');
  const navigation = useSettingsNavigation();
  const copies = useWorkingCopies(sessions);
  const noInfo = t('noInfo');
  const binding = folder.state === 'ready' ? folder.binding : null;
  const rows = sessions.flatMap((session) => {
    const copy = copies?.get(session.sessionId);
    return copy && copy.state !== 'none' ? [{ session, copy }] : [];
  });
  return (
    <div className="flex flex-col gap-8">
      <section aria-label={t('folder')} className="flex flex-col gap-3">
        <SectionLabel>{t('folder')}</SectionLabel>
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* The folder's state is the header's badge; this section holds its details. */}
          <div className="flex min-w-0 flex-col gap-1">
            {folder.state === 'loading' ? (
              <p role="status" className="text-body text-muted-foreground">
                {tf('loading')}
              </p>
            ) : null}
            {binding ? (
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
                <dt className="text-muted-foreground">{t('path')}</dt>
                <dd className="break-all font-mono text-foreground">{binding.path}</dd>
                <dt className="text-muted-foreground">{t('branch')}</dt>
                <dd className="text-foreground">{binding.status?.branch ?? noInfo}</dd>
                <dt className="text-muted-foreground">{t('changes')}</dt>
                <dd className="text-foreground">
                  {binding.status ? t('changed', { count: binding.status.changed }) : noInfo}
                </dd>
              </dl>
            ) : null}
          </div>
          <Button
            variant="tertiary"
            size="compact"
            render={<Link {...navigation.link('workspace', projectId)} />}
          >
            {tf('settings')}
          </Button>
        </div>
      </section>
      <section aria-label={t('copies')} className="flex flex-col gap-3">
        <SectionLabel {...(copies ? { count: rows.length } : {})}>{t('copies')}</SectionLabel>
        {copies === null ? (
          <p role="status" className="text-body text-muted-foreground">
            {t('loading')}
          </p>
        ) : rows.length === 0 ? (
          <EmptyState title={t('noCopies')} />
        ) : (
          <Table aria-label={t('copies')}>
            <TableHeader>
              <TableRow>
                <TableHead>{t('session')}</TableHead>
                <TableHead>{t('path')}</TableHead>
                <TableHead>{t('branch')}</TableHead>
                <TableHead>{t('changes')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(({ session, copy }, index) => (
                <TableRow key={session.sessionId} index={index}>
                  <TableCell>
                    <Link
                      to="/sessions/$sessionId"
                      params={{ sessionId: session.sessionId }}
                      className="rounded-sm text-foreground hover:underline"
                    >
                      {session.title}
                    </Link>
                    {copy.state === 'copy' && copy.worktree.missing ? (
                      <KitBadge variant="dot" size="compact" color="red" className="ml-2">
                        {t('copyMissing')}
                      </KitBadge>
                    ) : null}
                  </TableCell>
                  {/* No API reports a copy's location; it is not guessed. */}
                  <TableCell>{noInfo}</TableCell>
                  <TableCell>
                    {copy.state === 'copy' && copy.git?.branch ? copy.git.branch : noInfo}
                  </TableCell>
                  <TableCell>
                    {copy.state === 'copy' && copy.git
                      ? t('changed', { count: copy.git.changed })
                      : noInfo}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </div>
  );
}

/**
 * The project's work sessions and meetings: pinned first, searchable. Without any, one empty
 * state names what a session is; the header's New conversation starts the first, and a missing
 * model is the one other step.
 */
function SessionList({
  sessions,
  runs,
  attention,
  archived,
}: {
  sessions: WorkSession[];
  runs: RunSummary[];
  attention: InboxItemView[];
  /** An archived project starts nothing. */
  archived: boolean;
}) {
  const status = useTranslations('Status');
  const t = useTranslations('Sessions');
  const tw = useTranslations('Workspace');
  const navigation = useSettingsNavigation();
  const { mode, live, models } = useServices();
  const profiles = useModelProfiles();
  const needsModel =
    mode === 'server' &&
    live &&
    models !== null &&
    profiles !== null &&
    !profiles.some((profile) => profile.available);
  const ago = useSessionAge();
  const size = useSize();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [stateFilter, setStateFilter] = useState('all');
  const [error, setError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const { repository } = useServices();
  const router = useRouter();
  const setArchived = async (session: WorkSession, archived: boolean) => {
    setArchiving(session.sessionId);
    setError(null);
    try {
      const current = await repository.getSession(session.sessionId);
      if (!current) throw new Error(t('listSessionUnavailable'));
      const result = await repository.updateSession(session.sessionId, {
        archived,
        expectedRevision: current.revision,
      });
      if (!result.ok) return setError(result.message);
      projectsChanged();
      await router.invalidate();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setArchiving(null);
    }
  };
  const needle = query.trim().toLowerCase();
  const archivedCount = sessions.filter((x) => x.archivedAt).length;
  const none = sessions.length === archivedCount && !showArchived;
  const shown = sessions
    .filter(
      (x) =>
        (showArchived || !x.archivedAt) &&
        (stateFilter === 'all' || sessionListState(x, runs, attention) === stateFilter) &&
        (!needle || `${x.title}\n${x.objective}`.toLowerCase().includes(needle)),
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  return (
    <section aria-labelledby="sessions-heading" className="flex flex-col gap-2">
      <h2 id="sessions-heading" className="sr-only">
        {t('heading')}
      </h2>
      {!none ? (
        <div className="flex flex-wrap items-center gap-2">
          <InputGroup className="max-w-64">
            <InputField
              index={0}
              type="search"
              label={t('search')}
              labelHidden
              placeholder={t('search')}
              value={query}
              onChange={setQuery}
            />
          </InputGroup>
          <Select
            label={t('statusFilter')}
            variant="chip"
            value={stateFilter}
            onValueChange={setStateFilter}
            options={[
              'all',
              'running',
              'attention',
              'completed',
              'cancelled',
              'ready',
              'empty',
            ].map((value) => ({
              value,
              label: t(`listState.${value}`),
            }))}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
      {none ? (
        <div className="grid justify-items-center gap-4">
          <div className="w-full">
            <EmptyState title={t('emptyTitle')} />
          </div>
          {needsModel && !archived ? (
            <Button variant="tertiary" render={<Link {...navigation.link('models')} />}>
              {t('connectModel')}
            </Button>
          ) : null}
        </div>
      ) : shown.length === 0 ? (
        <p className="px-2 py-2 text-body text-muted-foreground">{t('noMatches')}</p>
      ) : (
        // One column for the rows and one for their action, shared by every row (subgrid), so the
        // meta's right edge lines up whether or not a row can be archived.
        <ul aria-label={t('heading')} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2">
          {shown.map((x) => {
            const latest = latestSessionRun(x, runs);
            const terminal = uncertainSessionTerminal(x.sessionId, attention);
            const Icon = x.meeting ? Users : MessageCircle;
            const runCount = runs.filter((r) => r.sessionId === x.sessionId).length;
            return (
              <li key={x.sessionId} className="col-span-2 grid grid-cols-subgrid items-center">
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: x.sessionId }}
                  search={terminal ? { panel: 'terminal', terminal } : { compose: true }}
                  data-session-kind={x.meeting ? 'meeting' : 'session'}
                  className={cn(
                    'flex min-w-0 items-center rounded-md transition-colors hover:bg-hover',
                    // The row takes the density's control height, as sidebar and table rows do.
                    size.variant === 'compact'
                      ? 'min-h-7 gap-2 px-1.5 py-1'
                      : 'min-h-9 gap-2.5 px-2 py-1.5',
                  )}
                >
                  <Icon aria-hidden size={size.icon} className="shrink-0 text-muted-foreground" />
                  {x.meeting ? <span className="sr-only">{t('meeting')}</span> : null}
                  {/* Narrow: the state and time take a second line under the title. */}
                  <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                    <span className={cn('min-w-0 truncate text-foreground', size.type.body)}>
                      {x.title}
                    </span>
                    <span
                      className={cn(
                        'min-w-0 text-muted-foreground sm:shrink-0 sm:text-right',
                        size.type.caption,
                      )}
                    >
                      {[
                        x.pinned ? t('pinned') : null,
                        x.archivedAt ? t('archived') : null,
                        terminal ? t('terminalNeedsAttention') : null,
                        latest
                          ? status(latest.status)
                          : terminal
                            ? null
                            : t(`listState.${sessionListState(x, runs)}`),
                        // Without a run the state above already says so.
                        runCount ? t('runCount', { count: runCount }) : null,
                        tw('updated', { time: ago(x.updatedAt) }),
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                </Link>
                {x.archivedAt || sessionListState(x, runs, attention) === 'empty' ? (
                  <Button
                    variant="ghost"
                    size="compact"
                    disabled={archiving !== null}
                    aria-label={t(x.archivedAt ? 'restoreNamed' : 'archiveEmpty', {
                      title: x.title,
                    })}
                    onClick={() => void setArchived(x, !x.archivedAt)}
                  >
                    {t(x.archivedAt ? 'restoreSession' : 'archive')}
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      {archivedCount > 0 ? (
        <Button
          variant="ghost"
          size="compact"
          className="self-start"
          aria-pressed={showArchived}
          onClick={() => setShowArchived(!showArchived)}
        >
          {showArchived ? t('hideArchived') : t('showArchived', { count: archivedCount })}
        </Button>
      ) : null}
    </section>
  );
}
