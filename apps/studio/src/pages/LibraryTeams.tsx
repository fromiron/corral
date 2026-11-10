import { type CorralSummary, isReadOnlyTeam, type ProjectSummary } from '@corral/core';
import { emptyDraft, importDefinition } from '@corral/react';
import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  EmptyState,
  fontWeights,
  KitCardTitle,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  SectionLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tooltip,
} from '@corral/react/design-kit';
import { ChevronRight, Info } from '@corral/react/icons';
import { Link, useNavigate } from '@tanstack/react-router';
import { type ChangeEvent, useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { projectName, projectsChanged } from '../projects.ts';
import { useServices } from '../services.tsx';
import { TeamDraftDialog } from '../TeamDraftDialog.tsx';
import { TemplateCopyDialog } from '../TemplateCopyDialog.tsx';
import {
  roleSteps,
  templateDefinition,
  useTemplateText,
  WORKSPACE_TEMPLATES,
  type WorkspaceTemplateId,
} from '../templates.ts';
import { ABOVE_CHOSEN_TABLE_ROW, CHOSEN_TABLE_ROW } from '../workbench/chosenRow.ts';
import { chooseNewSessionTeam } from '../workbench/newSessionDraft.ts';
import { useSessionAge } from '../workbench/useSessionAge.ts';

// The library's saved teams and templates for one project (docs/specs/features/library.md).
// Creating, importing, duplicating, moving and deleting use the existing Corral API.

function Errors({ errors }: { errors: string[] }) {
  const t = useTranslations('Workspace');
  if (errors.length === 0) return null;
  return (
    <div role="alert" className="flex flex-col gap-1 text-body text-destructive">
      <p>{t('importFailed')}</p>
      <ul className="list-disc pl-5">
        {errors.map((error) => (
          <li key={error}>{error}</li>
        ))}
      </ul>
    </div>
  );
}

export function LibraryTeams({
  projectId,
  project,
  projects,
  corrals,
  onChanged,
  onBrowseTemplates,
}: {
  projectId: string;
  project: ProjectSummary | undefined;
  projects: ProjectSummary[];
  corrals: CorralSummary[];
  onChanged: () => void;
  /** Switches the library to its Templates tab. */
  onBrowseTemplates: () => void;
}) {
  const t = useTranslations('Workspace');
  const tl = useTranslations('Library');
  const ts = useTranslations('Sessions');
  const tp = useTranslations('Projects');
  const { repository, persistent, mode } = useServices();
  const navigate = useNavigate();
  const ago = useSessionAge();
  const importInput = useRef<HTMLInputElement>(null);
  const [selection, select] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const teams = corrals.filter((corral) => corral.projectId === projectId);
  const selected = teams.find((corral) => corral.corralId === selection) ?? teams[0];
  const chosenIndex = selected ? teams.indexOf(selected) : -1;
  const archived = Boolean(project?.archivedAt);

  const work = async (action: () => Promise<string[] | undefined>) => {
    setBusy(true);
    setErrors([]);
    try {
      const failed = await action();
      if (failed?.length) setErrors(failed);
    } catch (failure) {
      setErrors([failure instanceof Error ? failure.message : String(failure)]);
    } finally {
      setBusy(false);
    }
  };

  const openNew = () =>
    work(async () => {
      const draft = emptyDraft('untitled', t('newName'));
      const result = await repository.save({
        definition: draft.definition,
        expectedDefinitionRevision: null,
        projectId,
      });
      if (!result.ok) return [result.message];
      await navigate({
        to: '/corrals/$corralId/edit',
        params: { corralId: result.record.corralId },
      });
    });

  const onImport = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    void work(async () => {
      if (!file) return ['Choose a definition file (.corral.json).'];
      const imported = importDefinition(await file.text());
      if (!imported.ok) return imported.errors;
      const result = await repository.save({
        definition: imported.draft.definition,
        expectedDefinitionRevision: null,
        projectId,
      });
      if (!result.ok) return [result.message];
      await navigate({
        to: '/corrals/$corralId/edit',
        params: { corralId: result.record.corralId },
      });
    });
  };

  const duplicate = (corral: CorralSummary) =>
    work(async () => {
      const result = await repository.duplicate(
        corral.corralId,
        t('duplicateName', { name: corral.name }),
      );
      if (!result.ok) return [result.message];
      select(result.record.corralId);
      onChanged();
    });

  const move = (corral: CorralSummary, to: string) =>
    work(async () => {
      const result = await repository.moveCorral(corral.corralId, to);
      if (!result.ok) return [result.message];
      onChanged();
    });

  const remove = (corral: CorralSummary) =>
    work(async () => {
      await repository.remove(corral.corralId);
      setConfirming(null);
      select(null);
      onChanged();
    });

  // The team's own conversation starts at once, like the sidebar's new conversation.
  const startWith = (corral: CorralSummary) =>
    work(async () => {
      const result = await repository.createSession({
        projectId,
        title: ts('new'),
        autoTitle: true,
        objective: '',
        corralId: corral.corralId,
      });
      if (!result.ok) return [result.message];
      projectsChanged();
      await navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: result.session.sessionId },
      });
    });

  const storage =
    mode === 'server' ? t('storedOnServer') : persistent ? t('storedLocally') : t('notPersistent');
  const importButton = (
    <>
      <Tooltip content={t('importHint')} className="max-w-xs">
        <Button
          variant={teams.length ? 'tertiary' : 'ghost'}
          size={teams.length ? 'compact' : 'default'}
          disabled={busy}
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
        onChange={onImport}
        aria-label={t('import')}
        aria-description={t('importHint')}
        tabIndex={-1}
        className="hidden"
      />
    </>
  );
  return (
    <div className="flex flex-col gap-6">
      {teams.length ? (
        // The list's actions; the Teams tab above already names the list and counts it.
        <div className="flex min-h-9 flex-wrap items-center justify-end gap-2">
          {/* Where teams are kept is worth knowing once, not a line under the list. */}
          <Tooltip content={storage} className="max-w-xs">
            <Button variant="ghost" size="icon-compact" aria-label={tl('teams.storage')}>
              <Info aria-hidden />
            </Button>
          </Tooltip>
          {archived ? null : (
            <>
              {importButton}
              <Button size="compact" disabled={busy} onClick={() => void openNew()}>
                {t('new')}
              </Button>
            </>
          )}
        </div>
      ) : null}
      {archived ? (
        <p role="note" className="text-body text-warning">
          {tp('archivedNote')}
        </p>
      ) : null}
      <Errors errors={errors} />
      {teams.length === 0 ? (
        <div className="grid justify-items-center gap-4">
          <div className="w-full">
            <EmptyState title={t('empty')} />
          </div>
          {archived ? null : (
            <div className="flex flex-wrap justify-center gap-2">
              <Button disabled={busy} onClick={() => void openNew()}>
                {t('new')}
              </Button>
              <Button variant="tertiary" onClick={onBrowseTemplates}>
                {tl('teams.browseTemplates')}
              </Button>
              {importButton}
            </div>
          )}
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <Table aria-label={tl('teams.list')}>
            <TableHeader>
              <TableRow className={chosenIndex === 0 ? ABOVE_CHOSEN_TABLE_ROW : undefined}>
                <TableHead>{tl('teams.name')}</TableHead>
                <TableHead>{tl('teams.version')}</TableHead>
                <TableHead>{tl('teams.updated')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {teams.map((corral, index) => {
                const chosen = index === chosenIndex;
                return (
                  <TableRow
                    key={corral.corralId}
                    index={index}
                    data-selected={chosen}
                    className={
                      chosen
                        ? CHOSEN_TABLE_ROW
                        : index === chosenIndex - 1
                          ? ABOVE_CHOSEN_TABLE_ROW
                          : undefined
                    }
                  >
                    <TableCell className="max-w-0 w-1/2">
                      {/* The row's one control; it stretches over the row for the pointer. */}
                      <button
                        type="button"
                        aria-pressed={chosen}
                        onClick={() => select(corral.corralId)}
                        className="block w-full truncate rounded-sm text-left text-foreground after:absolute after:inset-0 after:content-['']"
                        style={chosen ? { fontVariationSettings: fontWeights.semibold } : undefined}
                      >
                        {corral.name}
                      </button>
                    </TableCell>
                    <TableCell>
                      {t('revisions', {
                        definition: corral.definitionRevision,
                        nodes: corral.nodeCount,
                      })}
                    </TableCell>
                    <TableCell>{ago(corral.updatedAt)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          {selected ? (
            <section
              key={selected.corralId}
              aria-label={tl('teams.detail')}
              className="flex flex-col gap-3"
            >
              {/* The name heads it; its version, size and save time are on its row. */}
              <h2>
                <KitCardTitle>{selected.name}</KitCardTitle>
              </h2>
              <div className="flex flex-col items-stretch gap-2">
                {archived ? null : (
                  <Button disabled={busy} onClick={() => void startWith(selected)}>
                    {tl('teams.newConversation')}
                  </Button>
                )}
                <Button
                  variant="tertiary"
                  render={
                    <Link to="/corrals/$corralId/edit" params={{ corralId: selected.corralId }} />
                  }
                >
                  {tl('teams.edit')}
                </Button>
                <Button variant="tertiary" disabled={busy} onClick={() => void duplicate(selected)}>
                  {t('duplicate')}
                </Button>
                <MoveCorral
                  name={selected.name}
                  current={projectId}
                  projects={projects}
                  onMove={(to) => void move(selected, to)}
                />
                {confirming === selected.corralId ? (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="destructive-outline"
                      size="compact"
                      disabled={busy}
                      onClick={() => void remove(selected)}
                    >
                      {t('confirmDelete')}
                    </Button>
                    <Button variant="ghost" size="compact" onClick={() => setConfirming(null)}>
                      {t('cancel')}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost-destructive"
                    size="compact"
                    className="self-start"
                    onClick={() => setConfirming(selected.corralId)}
                  >
                    {t('delete')}
                  </Button>
                )}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

/** Moves a Corral to another active project; its finished runs stay where they ran. */
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
  // A button beside Edit and Duplicate; its menu lists where the team can go.
  return (
    <Menu>
      <MenuTrigger render={<Button variant="tertiary" />}>{t('moveChoose')}</MenuTrigger>
      <MenuPopup align="start" aria-label={t('moveTo', { name })} className="min-w-52">
        {targets.map((p) => (
          <MenuItem key={p.projectId} onClick={() => onMove(p.projectId)}>
            {projectName(p, t('defaultName'))}
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Team templates for the project, and the "draft a team from a goal" dialog while the address
 * asks for it (the library's toolbar opens it).
 */
export function LibraryTemplates({
  projectId,
  project,
  corrals,
  drafting,
  onDraftClosed,
}: {
  projectId: string;
  project: ProjectSummary | undefined;
  corrals: CorralSummary[];
  drafting: boolean;
  onDraftClosed: () => void;
}) {
  const t = useTranslations('Workspace');
  const tp = useTranslations('Projects');
  const format = useFormatter();
  const text = useTemplateText();
  const navigate = useNavigate();
  const [copyTemplate, setCopyTemplate] = useState<WorkspaceTemplateId | null>(null);
  // Each card shows the team its template makes: the roles in order, and whether any may
  // change files or run commands.
  const templates = useMemo(
    () =>
      WORKSPACE_TEMPLATES.map((id) => {
        const definition = templateDefinition(id, id.replaceAll('-', '_'), text);
        return { id, steps: roleSteps(definition), readOnly: isReadOnlyTeam(definition) };
      }),
    [text],
  );
  // An archived project gets no new teams; restoring it brings the templates back.
  if (project?.archivedAt)
    return (
      <p role="note" className="text-body text-warning">
        {tp('archivedNote')}
      </p>
    );
  return (
    <>
      <div className="@container">
        <div className="grid gap-2 @2xl:grid-cols-2">
          {templates.map(({ id, steps, readOnly }) => (
            <article key={id} aria-labelledby={`template-${id}`}>
              <Card className="h-full">
                <CardHeader>
                  <h3 id={`template-${id}`}>
                    <KitCardTitle>{t(`template.${id}.name`)}</KitCardTitle>
                  </h3>
                  {readOnly ? (
                    <CardAction className="row-span-1">
                      <Badge variant="secondary" size="sm">
                        {t('readOnly')}
                      </Badge>
                    </CardAction>
                  ) : null}
                </CardHeader>
                {steps.length ? (
                  <CardContent>
                    <ol
                      aria-label={t('templateRoles')}
                      className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-caption text-muted-foreground"
                    >
                      {steps.map((names, index) => (
                        <li key={names.join()} className="flex items-center gap-1">
                          {index ? <ChevronRight aria-hidden className="size-3 shrink-0" /> : null}
                          {format.list(names, { type: 'conjunction' })}
                        </li>
                      ))}
                    </ol>
                  </CardContent>
                ) : null}
                <CardFooter className="mt-auto">
                  {id === 'blank' ? null : (
                    <Button
                      variant="tertiary"
                      aria-label={t('templateNewConversation', { name: t(`template.${id}.name`) })}
                      onClick={() => {
                        // The project's new conversation opens with this team chosen.
                        chooseNewSessionTeam(projectId, `template:${id}`);
                        void navigate({
                          to: '/projects/$projectId',
                          params: { projectId },
                          search: { newSession: true },
                        });
                      }}
                    >
                      {t('newConversation')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    aria-label={t('templateEditCopy', { name: t(`template.${id}.name`) })}
                    onClick={() => setCopyTemplate(id)}
                  >
                    {t('editCopy')}
                  </Button>
                </CardFooter>
              </Card>
            </article>
          ))}
        </div>
      </div>
      {copyTemplate ? (
        <TemplateCopyDialog
          template={copyTemplate}
          projectId={projectId}
          corrals={corrals}
          onClose={() => setCopyTemplate(null)}
          onSaved={async (corralId) => {
            await navigate({ to: '/corrals/$corralId/edit', params: { corralId } });
          }}
        />
      ) : null}
      {drafting ? <TeamDraftDialog onClose={onDraftClosed} projectId={projectId} /> : null}
    </>
  );
}
