import { DEFAULT_PROJECT_ID, type ProjectSummary } from '@corral/core';
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardDescription,
  CardGroup,
  CardHeader,
  CardTitle,
  fontWeights,
  InputField,
  InputGroup,
} from '@corral/react/design-kit';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'use-intl';
import { desktop } from '../desktop.tsx';
import { projectName, projectOfRun, projectsChanged, useCurrentProject } from '../projects.ts';
import { projectsRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { createDemoExamples } from '../templates.ts';
import { GitCloneFolder } from '../workbench/GitCloneFolder.tsx';

/** /projects: every project, a new one, and archived ones on request. */
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
  // New project (the sidebar's Corral menu) opens here at the form, ready to type its name.
  const hash = useRouterState({ select: (state) => state.location.hash });
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (hash !== 'new-project') return;
    form.current?.scrollIntoView({ block: 'nearest' });
    form.current?.querySelector('input')?.focus();
  }, [hash]);
  const archivedCount = projects.filter((p) => p.archivedAt).length;
  const shown = projects.filter((p) => showArchived || !p.archivedAt);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    const result = await repository.createProject({ name, description });
    if (!result.ok) return setError(t('failed', { message: result.message }));
    projectsChanged();
    // start with a folder or from material alone. A folder that cannot be
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
      <h2 className="text-title" style={{ fontVariationSettings: fontWeights.semibold }}>
        {t('heading')}
      </h2>
      <p className="text-body text-muted-foreground">{t('intro')}</p>
      {mode === 'server' && workspaces ? <GitCloneFolder onSelect={setFolder} /> : null}
      <form
        ref={form}
        id="new-project"
        onSubmit={create}
        aria-label={t('new')}
        className="flex flex-col gap-3"
      >
        <InputGroup className="w-full">
          <InputField
            index={0}
            label={t('nameLabel')}
            value={name}
            onChange={setName}
            maxLength={80}
            required
          />
          <InputField
            index={1}
            label={t('descriptionLabel')}
            value={description}
            onChange={setDescription}
            maxLength={500}
          />
          {workspaces ? (
            <div className="flex flex-col gap-1 text-caption">
              {mode === 'server' && !desktop ? (
                <InputField
                  index={2}
                  label={t('folderOptional')}
                  value={folder}
                  onChange={setFolder}
                  spellCheck={false}
                  aria-describedby="folder-hint"
                />
              ) : (
                <>
                  <span id="folder-label">{t('folderOptional')}</span>
                  <div className="flex min-w-0 items-center gap-2 text-body">
                    <output
                      className="min-w-0 flex-1 truncate text-muted-foreground"
                      title={mode === 'browser' ? undefined : folder || undefined}
                      aria-labelledby="folder-label"
                    >
                      {folder ? (mode === 'browser' ? t('exampleFolder') : folder) : t('noFolder')}
                    </output>
                    {mode === 'browser' && folder ? null : (
                      <Button
                        type="button"
                        variant="tertiary"
                        aria-describedby="folder-hint"
                        onClick={() => {
                          if (desktop) {
                            void desktop.pickFolder().then((chosen) => {
                              if (chosen) setFolder(chosen);
                            });
                            return;
                          }
                          setFolder('demo://example-repo');
                        }}
                      >
                        {mode === 'browser' ? t('linkExample') : t('chooseFolder')}
                      </Button>
                    )}
                    {folder ? (
                      <Button type="button" variant="ghost" onClick={() => setFolder('')}>
                        {t('clearFolder')}
                      </Button>
                    ) : null}
                  </div>
                </>
              )}
              <span id="folder-hint" className="text-muted-foreground">
                {t('folderHint')}
              </span>
            </div>
          ) : null}
        </InputGroup>
        <Button type="submit" variant="primary" className="self-start">
          {t('create')}
        </Button>
      </form>
      {mode === 'browser' ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Button
            type="button"
            variant="tertiary"
            onClick={async () => {
              const first = await createDemoExamples(repository, workspaces, {
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
          >
            {t('examples')}
          </Button>
          <span className="text-muted-foreground">{t('examplesHint')}</span>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <CardGroup orientation="inline" role="list" aria-label={t('heading')} fluidHover={false}>
        {shown.map((project) => {
          const label = projectName(project, t('defaultName'));
          const corralCount = corrals.filter((c) => c.projectId === project.projectId).length;
          const runCount = runs.filter(
            (r) => projectOfRun(r, corrals) === project.projectId,
          ).length;
          return (
            <Card
              key={project.projectId}
              role="listitem"
              selected={project.projectId === current}
              aria-current={project.projectId === current ? 'true' : undefined}
            >
              <CardHeader className="pr-4">
                <CardTitle>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: project.projectId }}
                    className="underline-offset-4 hover:underline"
                    style={{ fontVariationSettings: fontWeights.semibold }}
                  >
                    {label}
                  </Link>
                </CardTitle>
                {project.description ? (
                  <CardDescription>{project.description}</CardDescription>
                ) : null}
                <CardDescription>
                  {t('counts', { corrals: corralCount, runs: runCount })} ·{' '}
                  {tw('updated', { time: format.relativeTime(new Date(project.updatedAt), now) })}
                </CardDescription>
                <CardAction className="flex items-center gap-2">
                  {project.archivedAt ? <Badge variant="secondary">{t('archived')}</Badge> : null}
                  {project.projectId === DEFAULT_PROJECT_ID ? null : (
                    <Button
                      type="button"
                      variant="ghost"
                      aria-label={`${project.archivedAt ? t('restore') : t('archive')}: ${label}`}
                      onClick={() => void setArchived(project, !project.archivedAt)}
                    >
                      {project.archivedAt ? t('restore') : t('archive')}
                    </Button>
                  )}
                </CardAction>
              </CardHeader>
            </Card>
          );
        })}
      </CardGroup>
      {archivedCount > 0 ? (
        <Button
          type="button"
          variant="ghost"
          aria-pressed={showArchived}
          onClick={() => setShowArchived(!showArchived)}
          className="self-start"
        >
          {showArchived ? t('hideArchived') : t('showArchived', { count: archivedCount })}
        </Button>
      ) : null}
    </main>
  );
}
