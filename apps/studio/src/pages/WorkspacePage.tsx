import {
  type CorralSummary,
  DEFAULT_PROJECT_ID,
  type ProjectSummary,
  type RunSummary,
  type WorkSession,
} from '@corral/core';
import { arrangeDraft, draftLayout, emptyDraft, importDocuments, StatusBadge } from '@corral/react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { type ChangeEvent, type FormEvent, useEffect, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'use-intl';
import { projectName, projectsChanged, setCurrentProject } from '../projects.ts';
import { workspaceRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { TeamDraftDialog } from '../TeamDraftDialog.tsx';
import { createFromTemplate, WORKSPACE_TEMPLATES } from '../templates.ts';
import { InboxSection, WorkFolderSection } from './FilesViews.tsx';
import { GettingStarted } from './GettingStarted.tsx';
import { WorkbenchLayout } from './Workbench.tsx';

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

  return (
    <WorkbenchLayout
      main={
        <main className="min-h-0 flex-1 overflow-auto">
          <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
            <ProjectHeader project={project} onError={(message) => setErrors([message])} />
            <InboxSection projectId={projectId} />
            <WorkFolderSection projectId={projectId} />
            <SessionsSection
              key={newSession ? 'new' : 'list'}
              openForm={Boolean(newSession)}
              projectId={projectId}
              archived={archived}
              sessions={sessions}
              corrals={corrals}
              runs={runs}
            />
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="corrals" className="text-lg font-semibold">
                {t('heading')}
              </h2>
              <div className={`flex items-center gap-2 ${archived ? 'hidden' : ''}`}>
                <label className="cursor-pointer rounded-md border border-line px-3 py-1.5 text-sm focus-within:outline-2 focus-within:outline-accent">
                  {t('import')}
                  <input
                    type="file"
                    accept=".json,application/json"
                    multiple
                    onChange={onImport}
                    className="sr-only"
                  />
                </label>
                <button
                  type="button"
                  onClick={openNew}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
                >
                  {t('new')}
                </button>
              </div>
            </div>
            <p className="text-xs text-muted">
              {mode === 'server'
                ? t('storedOnServer')
                : persistent
                  ? t('storedLocally')
                  : t('notPersistent')}
            </p>
            <p className="text-xs text-muted">{t('importHint')}</p>
            <GettingStarted
              corrals={totals.corrals}
              runs={totals.runs}
              onDraft={() => setDrafting(true)}
            />
            {errors.length > 0 ? (
              <div role="alert" className="rounded-md border border-danger p-3 text-sm text-danger">
                <p>{t('importFailed')}</p>
                <ul className="list-disc pl-5">
                  {errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {corrals.length === 0 ? (
              <div className="flex flex-col gap-1 rounded-md border border-dashed border-line p-4">
                <p className="text-sm font-medium">{t('empty')}</p>
                <p className="text-sm text-muted">{t('emptyHint')}</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2" aria-label={t('heading')}>
                {corrals.map((corral) => (
                  <li
                    key={corral.corralId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-raised p-3"
                  >
                    <div className="flex flex-col">
                      <Link
                        to="/corrals/$corralId/edit"
                        params={{ corralId: corral.corralId }}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {corral.name}
                      </Link>
                      <span className="text-xs text-muted">
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
                    <div className="flex items-center gap-2 text-xs">
                      <MoveCorral
                        name={corral.name}
                        current={projectId}
                        projects={projects}
                        onMove={(to) => void move(corral.corralId, to)}
                      />
                      <button
                        type="button"
                        onClick={() => duplicate(corral.corralId, corral.name)}
                        className="rounded border border-line px-2 py-1"
                      >
                        {t('duplicate')}
                      </button>
                      {confirming === corral.corralId ? (
                        <>
                          <button
                            type="button"
                            onClick={() => remove(corral.corralId)}
                            className="rounded border border-danger px-2 py-1 text-danger"
                          >
                            {t('confirmDelete')}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirming(null)}
                            className="rounded border border-line px-2 py-1"
                          >
                            {t('cancel')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirming(corral.corralId)}
                          className="rounded border border-line px-2 py-1"
                        >
                          {t('delete')}
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <section
              aria-labelledby="goal-heading"
              hidden={archived}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-accent/60 bg-raised p-3"
            >
              <div className="flex flex-col gap-1">
                <h2 id="goal-heading" className="text-sm font-semibold">
                  {t('template.goal.name')}
                </h2>
                <p className="text-xs text-muted">{t('template.goal.body')}</p>
              </div>
              <button
                type="button"
                onClick={() => setDrafting(true)}
                className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
              >
                {t('draftFromGoal')}
              </button>
            </section>
            <section
              aria-labelledby="templates-heading"
              hidden={archived}
              className="flex flex-col gap-2"
            >
              <h2 id="templates-heading" className="text-lg font-semibold">
                {t('templatesHeading')}
              </h2>
              <div className="grid gap-2 sm:grid-cols-3">
                {WORKSPACE_TEMPLATES.map((id) => (
                  <article
                    key={id}
                    aria-labelledby={`template-${id}`}
                    className="flex flex-col gap-2 rounded-md border border-line bg-raised p-3"
                  >
                    <h3 id={`template-${id}`} className="text-sm font-semibold">
                      {t(`template.${id}.name`)}
                    </h3>
                    <p className="flex-1 text-xs text-muted">{t(`template.${id}.body`)}</p>
                    <button
                      type="button"
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
                      className="self-start rounded-md border border-accent px-2 py-1 text-xs text-accent"
                    >
                      {t('useTemplate')}
                    </button>
                  </article>
                ))}
              </div>
            </section>
            <section aria-labelledby="runs-heading" className="flex flex-col gap-2">
              <h2 id="runs-heading" className="text-lg font-semibold">
                {t('runsHeading')}
              </h2>
              {picked.length === 2 ? (
                <button
                  type="button"
                  onClick={() =>
                    void navigate({ to: '/compare', search: { a: picked[0], b: picked[1] } })
                  }
                  className="self-start rounded-md border border-accent px-3 py-1.5 text-sm text-accent"
                >
                  {tc('choose', { count: 2 })}
                </button>
              ) : null}
              {runs.length === 0 ? (
                <p className="text-sm text-muted">{t('runsEmpty')}</p>
              ) : (
                <ul className="flex flex-col gap-1" aria-labelledby="runs-heading">
                  {runs.map((run) => {
                    const corral = corrals.find((c) => c.corralId === run.corralId);
                    return (
                      <li
                        key={run.runId}
                        className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2 text-sm"
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
                          className="font-mono text-xs underline"
                        >
                          {run.runId}
                        </Link>
                        <span className="text-xs text-muted">
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
            {drafting ? <TeamDraftDialog onClose={closeDraft} projectId={projectId} /> : null}
          </div>
        </main>
      }
    />
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
      <p className="text-xs text-muted">{t('label')}</p>
      {editing ? (
        <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs">
            {t('nameLabel')}
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              required
              className="rounded border border-line bg-surface px-2 py-1 text-sm"
            />
          </label>
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
            {t('descriptionLabel')}
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              className="rounded border border-line bg-surface px-2 py-1 text-sm"
            />
          </label>
          <button
            type="submit"
            className="rounded border border-accent px-2 py-1 text-xs text-accent"
          >
            {t('save')}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="rounded border border-line px-2 py-1 text-xs"
          >
            {t('cancel')}
          </button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="project-heading" className="text-xl font-semibold">
            {shown}
          </h2>
          {project.archivedAt ? (
            <span className="rounded-full border border-line px-2 py-0.5 text-xs text-muted">
              {t('archived')}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => {
              setName(shown);
              setDescription(project.description);
              setEditing(true);
            }}
            className="rounded border border-line px-2 py-0.5 text-xs"
          >
            {t('rename')}
          </button>
          {project.projectId === DEFAULT_PROJECT_ID ? null : (
            <button
              type="button"
              onClick={() => void update({ archived: !project.archivedAt })}
              className="rounded border border-line px-2 py-0.5 text-xs"
            >
              {project.archivedAt ? t('restore') : t('archive')}
            </button>
          )}
          <Link to="/projects" className="text-xs underline">
            {t('allProjects')}
          </Link>
        </div>
      )}
      {project.description && !editing ? (
        <p className="text-sm text-muted">{project.description}</p>
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
    <select
      aria-label={t('moveTo', { name })}
      value=""
      onChange={(event) => event.target.value && onMove(event.target.value)}
      className="rounded border border-line bg-surface px-1 py-1"
    >
      <option value="">{t('moveChoose')}</option>
      {targets.map((p) => (
        <option key={p.projectId} value={p.projectId}>
          {projectName(p, t('defaultName'))}
        </option>
      ))}
    </select>
  );
}

/** The project's work sessions (CR-011): pinned first, searchable, and a new one. */
function SessionsSection({
  openForm = false,
  projectId,
  archived,
  sessions,
  corrals,
  runs,
}: {
  openForm?: boolean;
  projectId: string;
  archived: boolean;
  sessions: WorkSession[];
  corrals: CorralSummary[];
  runs: RunSummary[];
}) {
  const t = useTranslations('Sessions');
  const tw = useTranslations('Workspace');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { repository } = useServices();
  const navigate = useNavigate();
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(openForm);
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [corralId, setCorralId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const needle = query.trim().toLowerCase();
  const archivedCount = sessions.filter((x) => x.archivedAt).length;
  const shown = sessions.filter(
    (x) =>
      (showArchived || !x.archivedAt) &&
      (!needle || `${x.title}\n${x.objective}`.toLowerCase().includes(needle)),
  );
  const team = corrals.some((c) => c.corralId === corralId)
    ? corralId
    : (corrals[0]?.corralId ?? '');

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const result = await repository.createSession({
      projectId,
      title,
      objective,
      corralId: team || null,
    });
    if (!result.ok) return setError(result.message);
    await navigate({ to: '/sessions/$sessionId', params: { sessionId: result.session.sessionId } });
  };

  return (
    <section aria-labelledby="sessions-heading" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sessions-heading" className="text-lg font-semibold">
          {t('heading')}
        </h2>
        <div className="flex items-center gap-2">
          {sessions.length > 0 ? (
            <input
              type="search"
              aria-label={t('search')}
              placeholder={t('search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="rounded border border-line bg-surface px-2 py-1 text-sm"
            />
          ) : null}
          {archived ? null : (
            <button
              type="button"
              aria-expanded={creating}
              onClick={() => setCreating(!creating)}
              className="rounded-md border border-accent px-3 py-1.5 text-sm text-accent"
            >
              {t('new')}
            </button>
          )}
        </div>
      </div>
      {creating ? (
        <form
          onSubmit={create}
          aria-label={t('new')}
          className="flex flex-col gap-2 rounded-md border border-line bg-raised p-3"
        >
          <label className="flex flex-col gap-1 text-xs">
            {t('objectiveLabel')}
            <textarea
              value={objective}
              rows={2}
              onChange={(e) => setObjective(e.target.value)}
              className="rounded border border-line bg-surface px-2 py-1 text-sm"
            />
          </label>
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
              {t('titleLabel')}
              <input
                value={title}
                maxLength={120}
                onChange={(e) => setTitle(e.target.value)}
                className="rounded border border-line bg-surface px-2 py-1 text-sm"
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t('teamLabel')}
              <select
                value={team}
                onChange={(e) => setCorralId(e.target.value)}
                className="rounded border border-line bg-surface px-2 py-1 text-sm"
              >
                {corrals.length === 0 ? <option value="">{t('noTeam')}</option> : null}
                {corrals.map((c) => (
                  <option key={c.corralId} value={c.corralId}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="submit"
              disabled={!title.trim() && !objective.trim()}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
            >
              {t('create')}
            </button>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </form>
      ) : null}
      {sessions.length === 0 ? (
        <p className="text-sm text-muted">{t('empty')}</p>
      ) : (
        <ul aria-label={t('heading')} className="flex flex-col gap-1">
          {shown.map((x) => (
            <li
              key={x.sessionId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line bg-raised px-3 py-2"
            >
              <div className="flex min-w-0 flex-col">
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: x.sessionId }}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {x.title}
                </Link>
                <span className="text-xs text-muted">
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
              </div>
            </li>
          ))}
        </ul>
      )}
      {archivedCount > 0 ? (
        <button
          type="button"
          aria-pressed={showArchived}
          onClick={() => setShowArchived(!showArchived)}
          className="self-start text-xs underline"
        >
          {showArchived ? t('hideArchived') : t('showArchived', { count: archivedCount })}
        </button>
      ) : null}
    </section>
  );
}
