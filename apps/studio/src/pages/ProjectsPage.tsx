import { DEFAULT_PROJECT_ID, type ProjectSummary } from '@corral/core';
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  InputField,
  InputGroup,
  KitBadge,
  Page,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
} from '@corral/react/design-kit';
import { Link, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'use-intl';
import { desktop } from '../desktop.tsx';
import { projectName, projectOfRun, projectsChanged, useCurrentProject } from '../projects.ts';
import { projectsRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { createDemoExamples } from '../templates.ts';
import { ABOVE_CHOSEN_TABLE_ROW, CHOSEN_TABLE_ROW } from '../workbench/chosenRow.ts';
import { type GitCloneDraft, GitCloneFolder } from '../workbench/GitCloneFolder.tsx';

const NO_CLONE: GitCloneDraft = { source: '', destination: '' };

/**
 * /projects: every project, listed first, and archived ones on request. A new project is made in
 * a dialog opened from the page's one primary action (docs/specs/workbench.md).
 */
export function ProjectsPage() {
  const t = useTranslations('Projects');
  const tw = useTranslations('Workspace');
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const { projects, corrals, runs } = projectsRoute.useLoaderData();
  const { repository, workspaces, mode } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const current = useCurrentProject();
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  // The new project's fields live with the page, so a dialog closed by accident keeps them.
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [folder, setFolder] = useState('');
  const [clone, setClone] = useState<GitCloneDraft>(NO_CLONE);
  const [createError, setCreateError] = useState<string | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const nameField = useRef<HTMLDivElement>(null);
  // New project in the sidebar's Corral menu opens here with the dialog ready to type a name.
  const hash = useRouterState({ select: (state) => state.location.hash });
  useEffect(() => {
    if (hash === 'new-project') setCreating(true);
  }, [hash]);
  const close = () => {
    setCreating(false);
    // The menu's link opens the dialog again only if the address changes back to it.
    if (hash === 'new-project') void navigate({ to: '/projects', hash: '', replace: true });
  };
  const archivedCount = projects.filter((p) => p.archivedAt).length;
  const shown = projects.filter((p) => showArchived || !p.archivedAt);
  const chosenIndex = shown.findIndex((p) => p.projectId === current);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setCreateError(null);
    const result = await repository.createProject({ name, description });
    if (!result.ok) return setCreateError(t('failed', { message: result.message }));
    projectsChanged();
    // start with a folder or from material alone. A folder that cannot be
    // linked leaves the project made; the project page says why and offers to link again.
    if (workspaces && folder.trim())
      await workspaces.bind(result.project.projectId, folder.trim()).catch(() => undefined);
    setName('');
    setDescription('');
    setFolder('');
    setClone(NO_CLONE);
    setCreating(false);
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
  const makeExamples = async () => {
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
    if (first) await navigate({ to: '/projects/$projectId', params: { projectId: first } });
  };

  return (
    <main className="flex min-h-0 flex-1 flex-col">
      <Page
        title={t('heading')}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <Button ref={trigger} onClick={() => setCreating(true)}>
              {t('new')}
            </Button>
            {mode === 'browser' ? (
              <Tooltip content={t('examplesHint')} className="max-w-xs">
                <Button
                  variant="tertiary"
                  aria-description={t('examplesHint')}
                  onClick={() => void makeExamples()}
                >
                  {t('examples')}
                </Button>
              </Tooltip>
            ) : null}
          </div>
        }
      >
        {error ? (
          <p role="alert" className="text-body text-destructive">
            {error}
          </p>
        ) : null}
        {/* The default project is always listed, so the table is never empty. */}
        <div className="min-w-0 overflow-x-auto">
          <Table aria-label={t('heading')}>
            <TableHeader>
              <TableRow className={chosenIndex === 0 ? ABOVE_CHOSEN_TABLE_ROW : undefined}>
                <TableHead>{t('column.name')}</TableHead>
                <TableHead className="max-md:hidden">{t('column.contents')}</TableHead>
                <TableHead>{t('column.saved')}</TableHead>
                <TableHead>
                  <span className="sr-only">{t('column.actions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((project, index) => {
                const label = projectName(project, t('defaultName'));
                const corralCount = corrals.filter((c) => c.projectId === project.projectId).length;
                const runCount = runs.filter(
                  (r) => projectOfRun(r, corrals) === project.projectId,
                ).length;
                const chosen = index === chosenIndex;
                return (
                  <TableRow
                    key={project.projectId}
                    index={index}
                    className={
                      chosen
                        ? CHOSEN_TABLE_ROW
                        : index === chosenIndex - 1
                          ? ABOVE_CHOSEN_TABLE_ROW
                          : undefined
                    }
                  >
                    <TableCell className="w-1/2 max-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        <Link
                          to="/projects/$projectId"
                          params={{ projectId: project.projectId }}
                          aria-current={chosen ? 'true' : undefined}
                          className="min-w-0 truncate rounded-sm text-foreground hover:underline"
                        >
                          {label}
                        </Link>
                        {project.archivedAt ? (
                          <KitBadge variant="dot" size="compact" color="gray">
                            {t('archived')}
                          </KitBadge>
                        ) : null}
                      </div>
                      {project.description ? (
                        <p className="m-0 truncate text-caption text-muted-foreground">
                          {project.description}
                        </p>
                      ) : null}
                    </TableCell>
                    <TableCell className="max-md:hidden">
                      {t('counts', { corrals: corralCount, runs: runCount })}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {format.relativeTime(new Date(project.updatedAt), now)}
                    </TableCell>
                    <TableCell className="text-right">
                      {project.projectId === DEFAULT_PROJECT_ID ? null : (
                        <Button
                          type="button"
                          variant="ghost"
                          size="compact"
                          aria-label={`${project.archivedAt ? t('restore') : t('archive')}: ${label}`}
                          onClick={() => void setArchived(project, !project.archivedAt)}
                        >
                          {project.archivedAt ? t('restore') : t('archive')}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        {archivedCount > 0 ? (
          <Button
            type="button"
            variant="ghost"
            size="compact"
            aria-pressed={showArchived}
            onClick={() => setShowArchived(!showArchived)}
            className="justify-self-start"
          >
            {showArchived ? t('hideArchived') : t('showArchived', { count: archivedCount })}
          </Button>
        ) : null}
      </Page>
      <Dialog open={creating} onOpenChange={(open) => (open ? setCreating(true) : close())}>
        <DialogPopup
          className="w-[min(95vw,560px)]"
          initialFocus={() => nameField.current?.querySelector('input') ?? true}
          finalFocus={trigger}
        >
          <form id="new-project" onSubmit={create} aria-label={t('new')}>
            <DialogHeader>
              <DialogTitle>{t('new')}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <div className="flex flex-col gap-3">
                <InputGroup className="w-full">
                  <InputField
                    ref={nameField}
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
                  {workspaces && mode === 'server' && !desktop ? (
                    <InputField
                      index={2}
                      label={t('folderOptional')}
                      value={folder}
                      onChange={setFolder}
                      spellCheck={false}
                    />
                  ) : null}
                </InputGroup>
                {workspaces && !(mode === 'server' && !desktop) ? (
                  <div className="flex flex-col gap-1 text-caption">
                    <span id="folder-label">{t('folderOptional')}</span>
                    <div className="flex min-w-0 items-center gap-2 text-body">
                      <output
                        className="min-w-0 flex-1 truncate text-muted-foreground"
                        title={mode === 'browser' ? undefined : folder || undefined}
                        aria-labelledby="folder-label"
                      >
                        {folder
                          ? mode === 'browser'
                            ? t('exampleFolder')
                            : folder
                          : t('noFolder')}
                      </output>
                      {mode === 'browser' && folder ? null : (
                        <Button
                          type="button"
                          variant="tertiary"
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
                  </div>
                ) : null}
                {mode === 'server' && workspaces ? (
                  <GitCloneFolder onSelect={setFolder} draft={clone} onDraftChange={setClone} />
                ) : null}
                {createError ? (
                  <p role="alert" className="text-body text-destructive">
                    {createError}
                  </p>
                ) : null}
              </div>
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="tertiary" onClick={close}>
                {t('cancel')}
              </Button>
              <Button type="submit">{t('create')}</Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </main>
  );
}
