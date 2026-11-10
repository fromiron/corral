import type {
  InboxItemView,
  SessionEvidenceView,
  WorkspaceBindingView,
  WorktreeView,
} from '@corral/client';
import {
  type CorralSummary,
  DEFAULT_PROJECT_ID,
  type ProjectSummary,
  type RunSummary,
  type WorkSession,
} from '@corral/core';
import {
  Banner,
  BannerActions,
  BannerTitle,
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
  fontWeights,
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
import { ArrowRight, ChevronDown, Ellipsis, MessageCircle, Pin, Users } from '@corral/react/icons';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { type FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectName, projectsChanged, setCurrentProject } from '../projects.ts';
import { workspaceRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { createFromTemplate, useTemplateText, WORKSPACE_TEMPLATES } from '../templates.ts';
import { CriteriaField } from '../workbench/CriteriaField.tsx';
import { NewMeetingDialog } from '../workbench/NewMeeting.tsx';
import { useSettingsNavigation, workHref } from '../workbench/navigation.ts';
import {
  EMPTY_DRAFT,
  type NewSessionDraft,
  newSessionDraftKey,
} from '../workbench/newSessionDraft.ts';
import { ProjectMaterials } from '../workbench/ProjectMaterials.tsx';
import { isSendKey, usePreferences } from '../workbench/preferences.ts';
import { RunList } from '../workbench/RunList.tsx';
import { readCriteria } from '../workbench/sessionCriteria.ts';
import { writeDraft } from '../workbench/sessionDraft.ts';
import {
  type AttentionReason,
  type SessionFact,
  type SessionGroupId,
  type SessionGroupRow,
  sessionFacts,
  sessionGroups,
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
  const inbox = useProjectInbox(projectId);
  const inboxItems = inbox.items;
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
            {...(project.description ? { description: project.description } : {})}
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
                  <div className="flex flex-wrap items-center gap-2">
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
                    <ProjectMenu project={project} onError={(message) => setErrors([message])} />
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
                <SessionList sessions={sessions} runs={runs} inbox={inbox} archived={archived} />
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

interface ProjectInbox {
  items: InboxItemView[];
  /** The latest read failed; `items` are what the last good read found, or none. */
  failed: boolean;
  /** Each session's recorded check, decision and applying, by session. */
  evidence: ReadonlyMap<string, SessionEvidenceView>;
  /** The latest evidence read failed; `evidence` is then empty, never the last values. */
  evidenceFailed: boolean;
  /** Reads both again. */
  retry: () => void;
}

const NO_EVIDENCE: ReadonlyMap<string, SessionEvidenceView> = new Map();

/**
 * The project's pending items, as the header counts them and the Sessions tab groups them, and
 * its sessions' recorded facts, read on the same schedule (docs/specs/features/session-evidence.md).
 */
function useProjectInbox(projectId: string): ProjectInbox {
  const { workspaces, mode } = useServices();
  const [items, setItems] = useState<InboxItemView[]>([]);
  const [failed, setFailed] = useState(false);
  const [evidence, setEvidence] = useState(NO_EVIDENCE);
  const [evidenceFailed, setEvidenceFailed] = useState(false);
  const reload = useRef<() => void>(() => {});
  // Only a server workspace records checks, decisions and applying; the demo has none to read.
  const recorded = mode === 'server';
  useEffect(() => {
    setItems([]);
    setFailed(false);
    setEvidence(NO_EVIDENCE);
    setEvidenceFailed(false);
    reload.current = () => {};
    if (!workspaces) return;
    let live = true;
    // Reads overlap (the timer, a retry): an older answer never replaces a newer one.
    const latest = <T,>(read: () => Promise<T>, shown: (value: T) => void, lost: () => void) => {
      let sent = 0;
      let answered = 0;
      return () => {
        const id = ++sent;
        const current = () => live && id > answered;
        new Promise<T>((resolve) => resolve(read())).then(
          (value) => {
            if (!current()) return;
            answered = id;
            shown(value);
          },
          () => {
            if (!current()) return;
            answered = id;
            lost();
          },
        );
      };
    };
    const inbox = latest(
      () => workspaces.inbox(projectId),
      (list) => {
        setItems(list);
        setFailed(false);
      },
      () => setFailed(true),
    );
    // A failed read drops what an earlier one said: a fact that cannot be read is not shown.
    const facts = recorded
      ? latest(
          () => workspaces.sessionEvidence(projectId),
          (list) => {
            setEvidence(new Map(list.map((item) => [item.sessionId, item])));
            setEvidenceFailed(false);
          },
          () => {
            setEvidence(NO_EVIDENCE);
            setEvidenceFailed(true);
          },
        )
      : () => {};
    const load = () => {
      inbox();
      facts();
    };
    reload.current = load;
    load();
    const timer = setInterval(load, 5000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [workspaces, projectId, recorded]);
  const retry = useCallback(() => reload.current(), []);
  return { items, failed, evidence, evidenceFailed, retry };
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

/** The project's "more" menu: rename, archive or restore, and the way to all projects. */
function ProjectMenu({
  project,
  onError,
}: {
  project: ProjectSummary;
  onError: (message: string) => void;
}) {
  const t = useTranslations('Projects');
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
  const templateText = useTemplateText();
  const { repository } = useServices();
  const { sendKey } = usePreferences();
  const navigate = useNavigate();
  const router = useRouter();
  const startButton = useRef<HTMLButtonElement>(null);
  const creating = useRef(false);
  const active = useRef(true);
  const automatic = useRef(false);
  const [draft, saveDraft] = useRemembered<NewSessionDraft>(
    newSessionDraftKey(projectId),
    EMPTY_DRAFT,
  );
  const title = typeof draft?.title === 'string' ? draft.title : '';
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const objective = typeof draft?.objective === 'string' ? draft.objective : '';
  const corralId = typeof draft?.corralId === 'string' ? draft.corralId : '';
  // As typed, one per line; trimmed and without blank lines only when sent.
  const criteria = typeof draft?.criteria === 'string' ? draft.criteria : '';
  const edit = (change: Partial<NewSessionDraft>) =>
    saveDraft({ title, objective, corralId, criteria, ...change });
  const criteriaField = useRef<HTMLTextAreaElement>(null);
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
  const hasDetails = Boolean(title || objective || corralId || criteria.trim());
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    if (creating.current) return;
    // Criteria past a limit say so on their field; nothing is made or sent.
    const sentCriteria = readCriteria(criteria);
    if (!sentCriteria) {
      setDetailsOpen(true);
      criteriaField.current?.focus();
      return;
    }
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
        const made = await createFromTemplate(repository, id, templateText, projectId);
        if (!made.ok) return setError(made.message);
        teamId = made.corralId;
      }
      const result = await repository.createSession({
        projectId,
        title: title.trim() || (objective.trim() ? '' : t('new')),
        autoTitle: !title.trim() && !objective.trim(),
        objective,
        ...(sentCriteria.length ? { criteria: sentCriteria } : {}),
        corralId: teamId || null,
      });
      if (!result.ok) return setError(result.message);
      writeDraft(result.session.sessionId, objective);
      projectsChanged();
      // A completed background creation must not dismiss the person's settings or retarget work.
      if (!active.current || router.state.location.search.settings) return;
      if (JSON.stringify(draftRef.current) === submittedDraft) saveDraft(EMPTY_DRAFT);
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
            <MenuItem onClick={() => setDetailsOpen(true)}>{tw('detailsFirst')}</MenuItem>
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
                    if (!creating.current) edit({ corralId: value });
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
                    onChange={(value) => edit({ title: value })}
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
                    onChange={(e) => edit({ objective: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.nativeEvent.isComposing || e.keyCode === 229) return;
                      if (isSendKey(e, sendKey)) {
                        e.preventDefault();
                        void create();
                      }
                    }}
                  />
                </label>
                {/* A work session's criteria; Enter adds a line here, it never starts. */}
                <CriteriaField
                  id={`new-session-criteria-${projectId}`}
                  fieldRef={criteriaField}
                  disabled={saving}
                  value={criteria}
                  onChange={(value) => edit({ criteria: value })}
                />
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
          <EmptyState title={t('noCopies')} text={t('noCopiesText')} />
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

/** Groups a person closes less often than they open; the others start open. */
const START_COLLAPSED: readonly SessionGroupId[] = ['cancelled', 'empty'];

/**
 * The project's work sessions and meetings, grouped by state (docs/specs/workbench.md#세션-목록의-
 * 상태와-처리할-항목) and searchable. Without any, one empty state names what a session is; the
 * header's New conversation starts the first, and a missing model is the one other step.
 */
function SessionList({
  sessions,
  runs,
  inbox,
  archived,
}: {
  sessions: WorkSession[];
  runs: RunSummary[];
  inbox: ProjectInbox;
  /** An archived project starts nothing. */
  archived: boolean;
}) {
  const t = useTranslations('Sessions');
  const navigation = useSettingsNavigation();
  const { mode, live, models } = useServices();
  const profiles = useModelProfiles();
  const needsModel =
    mode === 'server' &&
    live &&
    models !== null &&
    profiles !== null &&
    !profiles.some((profile) => profile.available);
  const id = useId();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
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
  // While searching every group opens; what is closed then lasts only until the search ends.
  const searching = needle !== '';
  const [collapsed, setCollapsed] = useState<ReadonlySet<SessionGroupId>>(
    () => new Set(START_COLLAPSED),
  );
  const [closedInSearch, setClosedInSearch] = useState<ReadonlySet<SessionGroupId>>(
    () => new Set(),
  );
  const [wasSearching, setWasSearching] = useState(searching);
  if (wasSearching !== searching) {
    setWasSearching(searching);
    setClosedInSearch(new Set());
  }
  const closed = searching ? closedInSearch : collapsed;
  // The disclosure owns its open state; this follows it, so a render never undoes a toggle.
  const toggled = (group: SessionGroupId, open: boolean) => {
    if (open !== closed.has(group)) return;
    (searching ? setClosedInSearch : setCollapsed)((previous) => {
      const next = new Set(previous);
      if (open) next.delete(group);
      else next.add(group);
      return next;
    });
  };
  const archivedCount = sessions.filter((x) => x.archivedAt).length;
  const none = sessions.length === archivedCount && !showArchived;
  const groups = sessionGroups(
    sessions.filter(
      (x) =>
        (showArchived || !x.archivedAt) &&
        (!needle || `${x.title}\n${x.objective}`.toLowerCase().includes(needle)),
    ),
    runs,
    inbox.items,
  );
  // Rows keep room for the pin when any is shown, so pinned or not their meta ends together.
  const pinSlot = groups.some((group) => group.rows.some((row) => row.session.pinned));
  const loadFailed =
    inbox.failed && inbox.evidenceFailed
      ? 'reviewAndEvidenceLoadFailed'
      : inbox.failed
        ? 'reviewLoadFailed'
        : inbox.evidenceFailed
          ? 'evidenceLoadFailed'
          : null;
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
        </div>
      ) : null}
      {loadFailed ? (
        // The groups below are then by run state, or the last items read: no review group is not
        // "nothing to review", and rows without facts are not "nothing recorded". One line says
        // what could not be read, and one retry reads both again.
        <Banner status="error" size="compact">
          <BannerTitle>{t(loadFailed)}</BannerTitle>
          <BannerActions>
            <Button variant="tertiary" size="compact" onClick={inbox.retry}>
              {t('retry')}
            </Button>
          </BannerActions>
        </Banner>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
      {none ? (
        <div className="grid justify-items-center gap-4">
          <div className="w-full">
            <EmptyState title={t('emptyTitle')} text={t('emptyText')} />
          </div>
          {needsModel && !archived ? (
            <Button variant="tertiary" render={<Link {...navigation.link('models')} />}>
              {t('connectModel')}
            </Button>
          ) : null}
        </div>
      ) : groups.length === 0 ? (
        <p className="px-2 py-2 text-body text-muted-foreground">{t('noMatches')}</p>
      ) : (
        // One column for the rows and one for their action, shared by every row of every group
        // (subgrid through each disclosure's content), so the meta's right edge is the same
        // whether or not a row, or its group, can be archived. Narrow rows keep their own.
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-4">
          {groups.map((group) => (
            <details
              key={group.id}
              open={!closed.has(group.id)}
              onToggle={(event) => toggled(group.id, event.currentTarget.open)}
              className="col-span-full grid grid-cols-subgrid details-content:col-span-full details-content:grid details-content:grid-cols-subgrid"
            >
              {/* Headed like the Needs you groups; the row's inset lines the name up with them. */}
              <SessionGroupSummary>
                <SessionGroupHeading
                  id={`${id}-${group.id}`}
                  name={t(`listState.${group.id}`)}
                  count={group.rows.length}
                />
              </SessionGroupSummary>
              <ul
                aria-labelledby={`${id}-${group.id}`}
                className="col-span-full mt-1 grid grid-cols-subgrid"
              >
                {group.rows.map((row) => (
                  <SessionRow
                    key={row.session.sessionId}
                    row={row}
                    facts={sessionFacts(inbox.evidence.get(row.session.sessionId))}
                    runs={runs}
                    attention={inbox.items}
                    pinSlot={pinSlot}
                    archivable={Boolean(row.session.archivedAt) || group.id === 'empty'}
                    archiving={archiving !== null}
                    onArchive={(session) => void setArchived(session, !session.archivedAt)}
                  />
                ))}
              </ul>
            </details>
          ))}
        </div>
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

/** A group's disclosure header, inset like a row so its name sits over the rows' icons. */
function SessionGroupSummary({ children }: { children: React.ReactNode }) {
  const size = useSize();
  return (
    <summary
      className={cn(
        'col-span-full',
        size.variant === 'compact' ? 'min-h-6 px-1.5' : 'min-h-7 px-2',
      )}
    >
      {children}
    </summary>
  );
}

/**
 * The kit SectionLabel's look one level under the tab's Sessions heading: the kit copy draws an
 * h2 only.
 */
function SessionGroupHeading({ id, name, count }: { id: string; name: string; count: number }) {
  const size = useSize();
  return (
    <h3
      className={cn(size.type.caption, 'm-0 flex items-center gap-2 text-muted-foreground')}
      style={{ fontVariationSettings: fontWeights.semibold }}
    >
      <span id={id}>{name}</span>
      <span className="tabular-nums">{count}</span>
    </h3>
  );
}

/**
 * One session: its title, then its recorded facts (docs/specs/features/session-evidence.md) and
 * only what its group does not already say (docs/specs/workbench.md#세션-목록의-상태와-처리할-항목):
 * why it needs attention, or what there is to review; then its runs and when it last changed,
 * worded as the sidebar words it. Pinned is the sidebar's pin, at the row's end.
 */
function SessionRow({
  row: { session: x, attention: reasons, review },
  facts,
  runs,
  attention,
  pinSlot,
  archivable,
  archiving,
  onArchive,
}: {
  row: SessionGroupRow;
  /** Check · decision · applied, as recorded; none when they could not be read. */
  facts: SessionFact[];
  runs: RunSummary[];
  attention: InboxItemView[];
  /** Some listed row is pinned: every row keeps the pin's room. */
  pinSlot: boolean;
  archivable: boolean;
  archiving: boolean;
  onArchive: (session: WorkSession) => void;
}) {
  const status = useTranslations('Status');
  const t = useTranslations('Sessions');
  const ti = useTranslations('Inbox');
  const ago = useSessionAge();
  const size = useSize();
  const terminal = uncertainSessionTerminal(x.sessionId, attention);
  const Icon = x.meeting ? Users : MessageCircle;
  const runCount = runs.filter((r) => r.sessionId === x.sessionId).length;
  const reason = (value: AttentionReason) =>
    value === 'uncertain_terminal'
      ? t('terminalNeedsAttention')
      : value === 'uncertain_write'
        ? ti('kind.uncertain_write')
        : status(value);
  return (
    // Narrow, the meta sits under the title, so only the row's own action takes room from it.
    <li className="col-span-full flex items-center gap-2 sm:grid sm:grid-cols-subgrid">
      <Link
        to="/sessions/$sessionId"
        params={{ sessionId: x.sessionId }}
        search={terminal ? { panel: 'terminal', terminal } : { compose: true }}
        data-session-kind={x.meeting ? 'meeting' : 'session'}
        className={cn(
          'flex min-w-0 flex-1 items-center rounded-md transition-colors hover:bg-hover',
          // The row takes the density's control height, as sidebar and table rows do.
          size.variant === 'compact' ? 'min-h-7 gap-2 px-1.5 py-1' : 'min-h-9 gap-2.5 px-2 py-1.5',
        )}
      >
        <Icon aria-hidden size={size.icon} className="shrink-0 text-muted-foreground" />
        {x.meeting ? <span className="sr-only">{t('meeting')}</span> : null}
        {/* Narrow: the facts and time take a second line under the title. */}
        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <span className={cn('min-w-0 truncate text-foreground', size.type.body)}>{x.title}</span>
          <span
            className={cn(
              'min-w-0 text-muted-foreground sm:shrink-0 sm:text-right',
              size.type.caption,
            )}
          >
            {[
              ...facts.map((fact) => t(`fact.${fact}`)),
              ...reasons.map(reason),
              // What there is to review, by kind: never a count or a request's text.
              ...review.map((kind) => ti(`kind.${kind}`)),
              runCount ? t('runCount', { count: runCount }) : null,
              ago(x.updatedAt),
            ]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </span>
        {pinSlot ? (
          <span className="flex w-3 shrink-0 justify-center">
            {x.pinned ? (
              <Pin
                role="img"
                aria-label={t('pinned')}
                size={12}
                className="shrink-0 text-muted-foreground"
              />
            ) : null}
          </span>
        ) : null}
      </Link>
      {archivable ? (
        <Button
          variant="ghost"
          size="compact"
          disabled={archiving}
          aria-label={t(x.archivedAt ? 'restoreNamed' : 'archiveEmpty', { title: x.title })}
          onClick={() => onArchive(x)}
        >
          {t(x.archivedAt ? 'restoreSession' : 'archive')}
        </Button>
      ) : null}
    </li>
  );
}
