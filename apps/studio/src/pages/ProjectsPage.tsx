import { DEFAULT_PROJECT_ID, type ProjectSummary } from '@corral/core';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'use-intl';
import { projectName, projectOfRun, projectsChanged, useCurrentProject } from '../projects.ts';
import { projectsRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { createDemoExamples } from '../templates.ts';

/** /projects (CR-010): every project, a new one, and archived ones on request. */
export function ProjectsPage() {
  const t = useTranslations('Projects');
  const tw = useTranslations('Workspace');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { projects, corrals, runs } = projectsRoute.useLoaderData();
  const { repository, workspaces, mode } = useServices();
  const [folder, setFolder] = useState('');
  const router = useRouter();
  const navigate = useNavigate();
  const current = useCurrentProject();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const archivedCount = projects.filter((p) => p.archivedAt).length;
  const shown = projects.filter((p) => showArchived || !p.archivedAt);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const result = await repository.createProject({ name, description });
    if (!result.ok) return setError(t('failed', { message: result.message }));
    projectsChanged();
    // 02-UX-Spec §1: start with a folder or from material alone. A folder that cannot be
    // linked leaves the project made; the project page says why and offers to link again.
    if (workspaces && folder.trim())
      await workspaces.bind(result.project.projectId, folder.trim()).catch(() => undefined);
    await navigate({
      to: '/projects/$projectId',
      params: { projectId: result.project.projectId },
    });
  };
  const setArchived = async (project: ProjectSummary, archived: boolean) => {
    const result = await repository.updateProject(project.projectId, {
      archived,
      expectedRevision: project.revision,
    });
    if (!result.ok) return setError(t('failed', { message: result.message }));
    projectsChanged();
    await router.invalidate();
  };

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <h2 className="text-lg font-semibold">{t('heading')}</h2>
      <p className="text-sm text-muted">{t('intro')}</p>
      <form
        onSubmit={create}
        aria-label={t('new')}
        className="flex flex-wrap items-end gap-2 rounded-md border border-line bg-raised p-3"
      >
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
        {workspaces ? (
          <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
            {t('folderOptional')}
            <input
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
              spellCheck={false}
              aria-describedby="folder-hint"
              className="rounded border border-line bg-surface px-2 py-1 font-mono text-sm"
            />
            <span id="folder-hint" className="text-muted">
              {t('folderHint')}
            </span>
          </label>
        ) : null}
        <button
          type="submit"
          className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent"
        >
          {t('create')}
        </button>
      </form>
      {mode === 'browser' ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={async () => {
              const first = await createDemoExamples(repository, {
                projects: [t('exampleProject1'), t('exampleProject2')],
                sessions: [
                  t('exampleSession1'),
                  t('exampleSession2'),
                  t('exampleSession3'),
                  t('exampleSession4'),
                  t('exampleSession5'),
                  t('exampleSession6'),
                ],
                teamName: tw('newName'),
              });
              projectsChanged();
              if (first)
                await navigate({ to: '/projects/$projectId', params: { projectId: first } });
            }}
            className="rounded border border-accent px-2 py-1 text-accent"
          >
            {t('examples')}
          </button>
          <span className="text-muted">{t('examplesHint')}</span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ul aria-label={t('heading')} className="flex flex-col gap-2">
        {shown.map((project) => {
          const label = projectName(project, t('defaultName'));
          const corralCount = corrals.filter((c) => c.projectId === project.projectId).length;
          const runCount = runs.filter(
            (r) => projectOfRun(r, corrals) === project.projectId,
          ).length;
          return (
            <li
              key={project.projectId}
              aria-current={project.projectId === current ? 'true' : undefined}
              className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-raised p-3 ${
                project.projectId === current ? 'border-accent' : 'border-line'
              }`}
            >
              <div className="flex min-w-0 flex-col">
                <Link
                  to="/projects/$projectId"
                  params={{ projectId: project.projectId }}
                  className="font-medium underline-offset-4 hover:underline"
                >
                  {label}
                </Link>
                {project.description ? (
                  <span className="text-xs text-muted">{project.description}</span>
                ) : null}
                <span className="text-xs text-muted">
                  {t('counts', { corrals: corralCount, runs: runCount })} ·{' '}
                  {tw('updated', { time: format.relativeTime(new Date(project.updatedAt), now) })}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                {project.archivedAt ? (
                  <span className="rounded-full border border-line px-2 py-0.5 text-muted">
                    {t('archived')}
                  </span>
                ) : null}
                {project.projectId === DEFAULT_PROJECT_ID ? null : (
                  <button
                    type="button"
                    aria-label={`${project.archivedAt ? t('restore') : t('archive')}: ${label}`}
                    onClick={() => void setArchived(project, !project.archivedAt)}
                    className="rounded border border-line px-2 py-1"
                  >
                    {project.archivedAt ? t('restore') : t('archive')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
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
    </main>
  );
}
