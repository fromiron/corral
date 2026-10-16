import { draftLayout, emptyDraft, importDocuments, StatusBadge } from '@corral/react';
import { Link, useNavigate, useRouter } from '@tanstack/react-router';
import { type ChangeEvent, useState } from 'react';
import { useFormatter, useNow, useTranslations } from 'use-intl';
import { workspaceRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import { TeamDraftDialog } from '../TeamDraftDialog.tsx';
import { createFromTemplate, WORKSPACE_TEMPLATES } from '../templates.ts';

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
  const { corrals, runs } = workspaceRoute.useLoaderData();
  const { repository, persistent, mode } = useServices();
  const router = useRouter();
  const navigate = useNavigate();
  const [errors, setErrors] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const { draft } = workspaceRoute.useSearch();
  const [drafting, setDrafting] = useState(Boolean(draft));
  const closeDraft = () => {
    setDrafting(false);
    if (draft) void navigate({ to: '/', search: {}, replace: true });
  };

  const openNew = async () => {
    const draft = emptyDraft('untitled', t('newName'));
    const result = await repository.save({
      definition: draft.definition,
      layout: { nodes: draft.layout, viewport: draft.viewport },
      expectedDefinitionRevision: null,
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
    const layoutDoc = draftLayout(imported.draft, 1);
    const result = await repository.save({
      definition: imported.draft.definition,
      layout: { nodes: layoutDoc.nodes, viewport: layoutDoc.viewport },
      expectedDefinitionRevision: null,
    });
    if (!result.ok) return setErrors([result.message]);
    await navigate({ to: '/corrals/$corralId/edit', params: { corralId: result.record.corralId } });
  };

  const duplicate = async (corralId: string, name: string) => {
    const result = await repository.duplicate(corralId, t('duplicateName', { name }));
    if (!result.ok) return setErrors([result.message]);
    await router.invalidate();
  };

  const remove = async (corralId: string) => {
    await repository.remove(corralId);
    setConfirming(null);
    await router.invalidate();
  };

  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('heading')}</h2>
        <div className="flex items-center gap-2">
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
                  · {t('updated', { time: format.relativeTime(new Date(corral.updatedAt), now) })}
                </span>
              </div>
              <div className="flex items-center gap-2 text-xs">
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
      <section aria-labelledby="templates-heading" className="flex flex-col gap-2">
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
                  const created = await createFromTemplate(repository, id, t('newName'));
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
                    {t('runStarted', { time: format.relativeTime(new Date(run.startedAt), now) })}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      {drafting ? <TeamDraftDialog onClose={closeDraft} /> : null}
    </main>
  );
}
