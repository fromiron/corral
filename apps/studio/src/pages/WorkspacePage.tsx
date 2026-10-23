import {
  type CorralSummary,
  DEFAULT_PROJECT_ID,
  type ProjectSummary,
  type RunSummary,
  type WorkSession,
} from '@corral/core';
import { arrangeDraft, draftLayout, emptyDraft, importDocuments, StatusBadge } from '@corral/react';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  InputField,
  InputGroup,
  KitButton,
  KitCardTitle,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  Select,
  Textarea,
  Tooltip,
} from '@corral/react/design-kit';
import { Ellipsis } from '@corral/react/icons';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { type ChangeEvent, type FormEvent, useEffect, useRef, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'use-intl';
import { projectName, projectsChanged, setCurrentProject } from '../projects.ts';
import { workspaceRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { TeamDraftDialog } from '../TeamDraftDialog.tsx';
import { createFromTemplate, WORKSPACE_TEMPLATES } from '../templates.ts';
import { StartMeeting } from '../workbench/NewMeeting.tsx';
import { ProjectMaterials } from '../workbench/ProjectMaterials.tsx';
import { isSendKey, usePreferences } from '../workbench/preferences.ts';
import { writeDraft } from '../workbench/sessionDraft.ts';
import { InboxSection, WorkFolderSection } from './FilesViews.tsx';
import { GettingStarted } from './GettingStarted.tsx';
import { useRemembered, WorkbenchLayout } from './Workbench.tsx';

/** Fired by a template card to choose that team in the new-session box (UX-09). */
const START_WITH_TEMPLATE = 'corral:start-with-template';

/** A layout file is recognised by its shape; everything else is treated as a definition. */
function isLayoutFile(text: string): boolean {
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    return typeof value.layoutRevision === 'number' && typeof value.corralId === 'string';
  } catch {
    return false;
  }
}

export function WorkspacePage() {
  const t = useTranslations('Workspace');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { project, projects, corrals, runs, sessions, totals } = workspaceRoute.useLoaderData();
  const projectId = project.projectId;
  const archived = project.archivedAt !== null;
  useEffect(() => setCurrentProject(projectId), [projectId]);
  const { repository, persistent, mode } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const [errors, setErrors] = useState<string[]>([]);
  const importInput = useRef<HTMLInputElement>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  // Roadmap 16: two runs picked for comparison, oldest choice dropped past two.
  const [picked, setPicked] = useState<string[]>([]);
  const tc = useTranslations('Compare');
  const pick = (runId: string, on: boolean) =>
    setPicked(
      on
        ? [...picked.filter((id) => id !== runId), runId].slice(-2)
        : picked.filter((id) => id !== runId),
    );
  const { draft, newSession } = workspaceRoute.useSearch();
  const [drafting, setDrafting] = useState(Boolean(draft));
  const closeDraft = () => {
    setDrafting(false);
    if (draft)
      void navigate({
        to: '/projects/$projectId',
        params: { projectId },
        search: {},
        replace: true,
      });
  };

  const openNew = async () => {
    const draft = emptyDraft('untitled', t('newName'));
    const result = await repository.save({
      definition: draft.definition,
      layout: { nodes: draft.layout, viewport: draft.viewport },
      expectedDefinitionRevision: null,
      projectId,
    });
    if (!result.ok) return setErrors([result.message]);
    await navigate({ to: '/corrals/$corralId/edit', params: { corralId: result.record.corralId } });
  };

  const onImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const texts = await Promise.all([...(event.target.files ?? [])].map((file) => file.text()));
    event.target.value = '';
    const layout = texts.find(isLayoutFile);
    const definition = texts.find((text) => !isLayoutFile(text));
    if (!definition) return setErrors(['Choose a definition file (.corral.json).']);
    const imported = importDocuments(definition, layout);
    if (!imported.ok) return setErrors(imported.errors);
    // Without a layout file, arrange the nodes by the flow (roadmap 18).
    const draft = layout ? imported.draft : arrangeDraft(imported.draft);
    const layoutDoc = draftLayout(draft, 1);
    const result = await repository.save({
      definition: draft.definition,
      layout: { nodes: layoutDoc.nodes, viewport: layoutDoc.viewport },
      expectedDefinitionRevision: null,
      projectId,
    });
    if (!result.ok) return setErrors([result.message]);
    await navigate({ to: '/corrals/$corralId/edit', params: { corralId: result.record.corralId } });
  };

  const duplicate = async (corralId: string, name: string) => {
    const result = await repository.duplicate(corralId, t('duplicateName', { name }));
    if (!result.ok) return setErrors([result.message]);
    await router.invalidate();
  };

  const move = async (corralId: string, to: string) => {
    const result = await repository.moveCorral(corralId, to);
    if (!result.ok) return setErrors([result.message]);
    await router.invalidate();
  };

  const remove = async (corralId: string) => {
    await repository.remove(corralId);
    setConfirming(null);
    await router.invalidate();
  };

  const teamsPanel = (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="corrals" className="text-base font-semibold">
          {t('heading')}
        </h2>
        <div className={`flex items-center gap-2 ${archived ? 'hidden' : ''}`}>
          <Tooltip content={t('importHint')} className="max-w-xs">
            <Button
              variant="tertiary"
              onClick={() => importInput.current?.click()}
              aria-description={t('importHint')}
            >
              {t('import')}
            </Button>
          </Tooltip>
          <input
            ref={importInput}
            type="file"
            accept=".json,application/json"
            multiple
            onChange={onImport}
            aria-label={t('import')}
            aria-description={t('importHint')}
            tabIndex={-1}
            className="hidden"
          />
          <Button variant="tertiary" onClick={() => setDrafting(true)}>
            {t('draftFromGoal')}
          </Button>
          <Button onClick={openNew}>{t('new')}</Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {mode === 'server'
          ? t('storedOnServer')
          : persistent
            ? t('storedLocally')
            : t('notPersistent')}
      </p>
      {corrals.length === 0 ? (
        <div className="flex flex-col gap-1 rounded-lg border border-dashed border-line p-4">
          <p className="text-sm font-medium">{t('empty')}</p>
          <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
        </div>
      ) : (
        <ul className="flex flex-col" aria-label={t('heading')}>
          {corrals.map((corral) => (
            <li
              key={corral.corralId}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-line/50 py-2.5 last:border-b-0"
            >
              <div className="flex min-w-0 flex-col">
                <Link
                  to="/corrals/$corralId/edit"
                  params={{ corralId: corral.corralId }}
                  className="font-medium hover:underline"
                >
                  {corral.name}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {t('revisions', {
                    definition: corral.definitionRevision,
                    layout: corral.layoutRevision,
                    nodes: corral.nodeCount,
                  })}{' '}
                  ·{' '}
                  {t('updated', {
                    time: format.relativeTime(new Date(corral.updatedAt), now),
                  })}
                </span>
              </div>
              <div className="flex items-center gap-1 text-xs">
                <MoveCorral
                  name={corral.name}
                  current={projectId}
                  projects={projects}
                  onMove={(to) => void move(corral.corralId, to)}
                />
                <Button
                  variant="ghost-muted"
                  size="compact"
                  onClick={() => duplicate(corral.corralId, corral.name)}
                >
                  {t('duplicate')}
                </Button>
                {confirming === corral.corralId ? (
                  <>
                    <Button
                      variant="destructive-outline"
                      size="compact"
                      onClick={() => remove(corral.corralId)}
                    >
                      {t('confirmDelete')}
                    </Button>
                    <Button
                      variant="ghost-muted"
                      size="compact"
                      onClick={() => setConfirming(null)}
                    >
                      {t('cancel')}
                    </Button>
                  </>
                ) : (
                  <Button
                    variant="ghost-destructive"
                    size="compact"
                    onClick={() => setConfirming(corral.corralId)}
                  >
                    {t('delete')}
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <section
        aria-labelledby="templates-heading"
        hidden={archived}
        className="flex flex-col gap-2"
      >
        <h3 id="templates-heading" className="text-ui font-semibold">
          {t('templatesHeading')}
        </h3>
        <div className="grid gap-2 sm:grid-cols-3">
          {WORKSPACE_TEMPLATES.map((id) => (
            <article key={id} aria-labelledby={`template-${id}`}>
              <Card className="h-full">
                <CardHeader>
                  <h4 id={`template-${id}`}>
                    <KitCardTitle>{t(`template.${id}.name`)}</KitCardTitle>
                  </h4>
                  <CardDescription>{t(`template.${id}.body`)}</CardDescription>
                </CardHeader>
                <CardFooter className="mt-auto">
                  {id === 'blank' ? null : (
                    <Button
                      onClick={() =>
                        window.dispatchEvent(new CustomEvent(START_WITH_TEMPLATE, { detail: id }))
                      }
                    >
                      {t('startWithTemplate')}
                    </Button>
                  )}
                  <Button
                    variant="tertiary"
                    onClick={async () => {
                      const created = await createFromTemplate(
                        repository,
                        id,
                        t('newName'),
                        projectId,
                      );
                      if (!created.ok) return setErrors([created.message]);
                      await navigate({
                        to: '/corrals/$corralId/edit',
                        params: { corralId: created.corralId },
                      });
                    }}
                  >
                    {t('useTemplate')}
                  </Button>
                </CardFooter>
              </Card>
            </article>
          ))}
        </div>
      </section>
    </div>
  );

  const runsPanel = (
    <section aria-labelledby="runs-heading" className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <h2 id="runs-heading" className="text-base font-semibold">
          {t('runsHeading')}
        </h2>
        {picked.length === 2 ? (
          <Button
            variant="tertiary"
            size="compact"
            onClick={() =>
              void navigate({ to: '/compare', search: { a: picked[0], b: picked[1] } })
            }
          >
            {tc('choose', { count: 2 })}
          </Button>
        ) : null}
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('runsEmpty')}</p>
      ) : (
        <ul className="flex flex-col" aria-labelledby="runs-heading">
          {runs.map((run) => {
            const corral = corrals.find((c) => c.corralId === run.corralId);
            return (
              <li
                key={run.runId}
                className="flex flex-wrap items-center gap-3 border-b border-line/50 py-2 text-sm last:border-b-0"
              >
                <input
                  type="checkbox"
                  aria-label={tc('select', { runId: run.runId })}
                  checked={picked.includes(run.runId)}
                  onChange={(e) => pick(run.runId, e.target.checked)}
                />
                <StatusBadge status={run.status} />
                <Link
                  to="/runs/$runId"
                  params={{ runId: run.runId }}
                  className="font-mono text-xs hover:underline"
                >
                  {run.runId}
                </Link>
                <span className="text-xs text-muted-foreground">
                  {corral?.name ?? run.corralId} ·{' '}
                  {t('runStarted', {
                    time: format.relativeTime(new Date(run.startedAt), now),
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );

  return (
    <WorkbenchLayout
      main={
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 pt-10 pb-12">
            <ProjectHeader project={project} onError={(message) => setErrors([message])} />
            {archived ? null : (
              <>
                <StartSession
                  key={`${projectId}:${newSession ? 'new' : 'start'}`}
                  focus={Boolean(newSession)}
                  projectId={projectId}
                  corrals={corrals}
                />
                <StartMeeting projectId={projectId} />
                <GettingStarted runs={totals.runs} projectId={projectId} />
              </>
            )}
            <InboxSection projectId={projectId} />
            {errors.length > 0 ? (
              <div
                role="alert"
                className="rounded-lg border border-danger/50 p-3 text-sm text-danger"
              >
                <p>{t('importFailed')}</p>
                <ul className="list-disc pl-5">
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <ProjectTabs
              sessions={<SessionList sessions={sessions} runs={runs} />}
              teams={teamsPanel}
              folder={<WorkFolderSection projectId={projectId} />}
              materials={<ProjectMaterials key={projectId} projectId={projectId} />}
              runs={runsPanel}
              counts={{
                sessions: sessions.filter((x) => !x.archivedAt).length,
                teams: corrals.length,
                runs: runs.length,
              }}
              projectId={projectId}
            />
            {drafting ? <TeamDraftDialog onClose={closeDraft} projectId={projectId} /> : null}
          </div>
        </main>
      }
    />
  );
}

type ProjectTab = 'sessions' | 'teams' | 'folder' | 'materials' | 'runs';

/** The project's lists and settings, one at a time; the choice is remembered per project. */
function ProjectTabs({
  sessions,
  teams,
  folder,
  materials,
  runs,
  counts,
  projectId,
}: {
  sessions: React.ReactNode;
  teams: React.ReactNode;
  folder: React.ReactNode;
  materials: React.ReactNode;
  runs: React.ReactNode;
  counts: { sessions: number; teams: number; runs: number };
  projectId: string;
}) {
  const t = useTranslations('Projects');
  const location = useRouterState({ select: (s) => s.location.hash });
  const navigate = useNavigate({ from: '/projects/$projectId' });
  const tabs: ProjectTab[] = ['sessions', 'teams', 'folder', 'materials', 'runs'];
  const [saved, setTab] = useRemembered<ProjectTab | null>(`corral:project-tab:${projectId}`, null);
  // A saved tab or an explicit library link is an intentional choice. First visits start
  // with conversations; designing a Corral is never a prerequisite for sending a request.
  const tab: ProjectTab =
    location === 'corrals' ? 'teams' : saved && tabs.includes(saved) ? saved : 'sessions';
  const chooseTab = (value: ProjectTab) => {
    setTab(value);
    if (location === 'corrals')
      void navigate({ hash: '', search: (search) => search, replace: true });
  };
  const refs = useRef<Partial<Record<ProjectTab, HTMLButtonElement | null>>>({});
  const count = (value: ProjectTab) =>
    value === 'folder' || value === 'materials'
      ? null
      : counts[value as 'sessions' | 'teams' | 'runs'];
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label={t('sections')} className="flex flex-wrap gap-1">
        {tabs.map((value, index) => (
          <KitButton
            key={value}
            variant="ghost"
            size="compact"
            active={tab === value}
            ref={(el) => {
              refs.current[value] = el;
            }}
            type="button"
            role="tab"
            id={`project-tab-${value}`}
            aria-selected={tab === value}
            aria-controls={`project-panel-${value}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => chooseTab(value)}
            onKeyDown={(event) => {
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
              if (!step) return;
              event.preventDefault();
              const next = tabs[(index + step + tabs.length) % tabs.length] as ProjectTab;
              chooseTab(next);
              refs.current[next]?.focus();
            }}
          >
            {t(`tab.${value}`)}
            {count(value) ? (
              <span className="ml-1.5 text-caption text-muted-foreground">{count(value)}</span>
            ) : null}
          </KitButton>
        ))}
      </div>
      <div role="tabpanel" id={`project-panel-${tab}`} aria-labelledby={`project-tab-${tab}`}>
        {tab === 'sessions'
          ? sessions
          : tab === 'teams'
            ? teams
            : tab === 'folder'
              ? folder
              : tab === 'materials'
                ? materials
                : runs}
      </div>
    </div>
  );
}

/** The project's name and description, rename and archive (CR-010). */
function ProjectHeader({
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
    <section aria-labelledby="project-heading" className="flex flex-col gap-1">
      {editing ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <InputGroup className="w-full flex-1 sm:flex-row">
            <InputField
              index={0}
              label={t('nameLabel')}
              id="project-name"
              value={name}
              onChange={setName}
              maxLength={80}
              required
              className="min-w-0 sm:w-48"
            />
            <InputField
              index={1}
              label={t('descriptionLabel')}
              id="project-description"
              value={description}
              onChange={setDescription}
              maxLength={500}
              className="min-w-0 flex-1"
            />
          </InputGroup>
          <Button type="submit">{t('save')}</Button>
          <Button variant="ghost" onClick={() => setEditing(false)}>
            {t('cancel')}
          </Button>
        </form>
      ) : (
        <div className="flex items-center gap-2">
          <h2
            id="project-heading"
            className="min-w-0 truncate text-2xl font-semibold tracking-tight"
          >
            {shown}
          </h2>
          {project.archivedAt ? (
            <span className="rounded-full bg-subtle px-2 py-0.5 text-xs text-muted-foreground">
              {t('archived')}
            </span>
          ) : null}
          <Menu>
            <MenuTrigger
              render={
                <Button
                  variant="ghost-muted"
                  size="icon-compact"
                  aria-label={t('actions', { name: shown })}
                />
              }
            >
              <Ellipsis />
            </MenuTrigger>
            <MenuPopup align="start">
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
        </div>
      )}
      {project.description && !editing ? (
        <p className="text-sm text-muted-foreground">{project.description}</p>
      ) : null}
      {project.archivedAt ? (
        <p role="note" className="text-sm text-warning">
          {t('archivedNote')}
        </p>
      ) : null}
    </section>
  );
}

/** Moves a Corral to another active project; its finished runs stay here (CR-010). */
function MoveCorral({
  name,
  current,
  projects,
  onMove,
}: {
  name: string;
  current: string;
  projects: ProjectSummary[];
  onMove: (projectId: string) => void;
}) {
  const t = useTranslations('Projects');
  const targets = projects.filter((p) => p.projectId !== current && !p.archivedAt);
  if (targets.length === 0) return null;
  return (
    <Select
      label={t('moveTo', { name })}
      value=""
      variant="ghost"
      size="xs"
      onValueChange={(value) => value && onMove(value)}
      options={[
        { value: '', label: t('moveChoose') },
        ...targets.map((p) => ({ value: p.projectId, label: projectName(p, t('defaultName')) })),
      ]}
    />
  );
}

/**
 * Start a conversation directly. Optional details preserve the previous draft and selected
 * Corral; the purpose becomes an editable first request and nothing runs until it is sent.
 */
function StartSession({
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
  const box = useRef<HTMLTextAreaElement>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const creating = useRef(false);
  const active = useRef(true);
  const automatic = useRef(false);
  const [draft, saveDraft] = useRemembered(`corral:new-session:v1:${projectId}`, {
    title: '',
    objective: '',
    corralId: '',
  });
  const title = typeof draft?.title === 'string' ? draft.title : '';
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const objective = typeof draft?.objective === 'string' ? draft.objective : '';
  const corralId = typeof draft?.corralId === 'string' ? draft.corralId : '';
  const [detailsOpen, setDetailsOpen] = useState(Boolean(title || objective || corralId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // UX-09: a suggested team (a template) can be chosen here; it is made when the session starts,
  // so trying a team never needs the graph editor.
  const suggested = WORKSPACE_TEMPLATES.filter((id) => id !== 'blank');
  const isSuggested = (value: string) =>
    value.startsWith('template:') && suggested.includes(value.slice(9) as never);
  // CR-024: without a chosen team ('') the session starts in auto mode.
  const chooseTeam = (available: CorralSummary[]) =>
    available.some((c) => c.corralId === corralId) || isSuggested(corralId) ? corralId : '';
  const team = chooseTeam(corrals);
  const selectedTeamName = isSuggested(team)
    ? tw(`template.${team.slice(9) as (typeof suggested)[number]}.name`)
    : corrals.find((corral) => corral.corralId === team)?.name;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  // "Start a session with this team" on a template card picks it here.
  useEffect(() => {
    const pick = (event: Event) => {
      if (creating.current) return;
      const id = (event as CustomEvent<string>).detail;
      saveDraft({ title, objective, corralId: `template:${id}` });
      setDetailsOpen(true);
      startButton.current?.scrollIntoView({ block: 'center' });
      startButton.current?.focus();
    };
    window.addEventListener(START_WITH_TEMPLATE, pick);
    return () => window.removeEventListener(START_WITH_TEMPLATE, pick);
  });

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

  // The explicit new-session link opens the composer once; it never starts a Run.
  // biome-ignore lint/correctness/useExhaustiveDependencies: later form edits must not create another session
  useEffect(() => {
    if (!focus || automatic.current) return;
    automatic.current = true;
    void create();
  }, [focus]);

  return (
    <form onSubmit={create} aria-label={t('new')}>
      <Card>
        <CardHeader>
          <h2>
            <KitCardTitle>{tw('chatHeading')}</KitCardTitle>
          </h2>
          <CardDescription>{tw('chatHint')}</CardDescription>
          <CardAction>
            <Button ref={startButton} type="submit" disabled={saving}>
              {tw('startChat')}
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent>
          <Accordion
            value={detailsOpen ? 'details' : ''}
            onValueChange={(value: string) => setDetailsOpen(value === 'details')}
            className="w-full"
          >
            <AccordionItem value="details" highlight="trigger">
              <AccordionTrigger>
                <span>{n('sessionDetails')}</span>
                {selectedTeamName ? (
                  <span className="ml-2 text-foreground">{selectedTeamName}</span>
                ) : null}
              </AccordionTrigger>
              <AccordionContent>
                <div className="flex flex-col gap-3">
                  <p className="text-caption text-muted-foreground">{tw('optionalCorralsHint')}</p>
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
                      ref={box}
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
                  <p className="text-caption text-muted-foreground">{n('optionalPurposeHint')}</p>
                </div>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </CardContent>
        {error ? (
          <CardFooter>
            <p role="alert" className="text-body text-destructive">
              {error}
            </p>
          </CardFooter>
        ) : null}
      </Card>
    </form>
  );
}

/** The project's work sessions (CR-011): pinned first, searchable. */
function SessionList({ sessions, runs }: { sessions: WorkSession[]; runs: RunSummary[] }) {
  const t = useTranslations('Sessions');
  const tw = useTranslations('Workspace');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const needle = query.trim().toLowerCase();
  const archivedCount = sessions.filter((x) => x.archivedAt).length;
  const shown = sessions
    .filter(
      (x) =>
        (showArchived || !x.archivedAt) &&
        (!needle || `${x.title}\n${x.objective}`.toLowerCase().includes(needle)),
    )
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
  return (
    <section aria-labelledby="sessions-heading" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sessions-heading" className="sr-only">
          {t('heading')}
        </h2>
        {sessions.length > 0 ? (
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
        ) : null}
      </div>
      {sessions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <ul aria-label={t('heading')} className="flex flex-col">
          {shown.map((x) => (
            <li key={x.sessionId}>
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: x.sessionId }}
                className="flex items-baseline justify-between gap-3 rounded-md px-2 py-2 hover:bg-subtle"
              >
                <span className="min-w-0 truncate text-sm font-medium">{x.title}</span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {[
                    x.pinned ? t('pinned') : null,
                    x.archivedAt ? t('archived') : null,
                    t('runCount', {
                      count: runs.filter((r) => r.sessionId === x.sessionId).length,
                    }),
                    tw('updated', { time: format.relativeTime(new Date(x.updatedAt), now) }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {archivedCount > 0 ? (
        <Button
          variant="ghost-muted"
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
