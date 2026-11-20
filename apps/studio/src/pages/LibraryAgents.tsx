import { canonicalJson, type LibraryAgent, type LibraryAgentRole } from '@corral/contracts';
import { type AgentLibraryResult, agentDescription } from '@corral/core';
import {
  addAgent,
  createEditorStore,
  createRunSession,
  type EditorStore,
  emptyDraft,
  firstSentence,
  RoleForm,
  StudioStoresProvider,
} from '@corral/react';
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
  EmptyState,
  Input,
  KitCardDescription,
  KitCardTitle,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@corral/react/design-kit';
import { useEffect, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFormatter, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../services.tsx';
import { ABOVE_CHOSEN_TABLE_ROW, CHOSEN_TABLE_ROW } from '../workbench/chosenRow.ts';
import { HarnessRoleSettings } from '../workbench/HarnessRoleSettings.tsx';
import { operationId } from '../workbench/harness/Target.tsx';
import { RoleSkills, useSkillLabel } from '../workbench/RoleSkills.tsx';
import { RoleTools } from '../workbench/RoleTools.tsx';
import { useImageProfiles } from '../workbench/useImageProfiles.ts';
import { useModelProfiles } from '../workbench/useModels.ts';
import { useSessionAge } from '../workbench/useSessionAge.ts';

type LibraryError = Extract<AgentLibraryResult, { ok: false }>['error'];
type Catalog = { state: 'loading' | 'failed' } | { state: 'ready'; items: LibraryAgent[] };
interface WorkingCopy {
  original: LibraryAgent | null;
  baseline: LibraryAgentRole;
  editor: EditorStore;
  nodeId: string;
  opener: HTMLElement;
}
const blank: LibraryAgentRole = {
  name: '',
  prompt: '',
  modelProfile: 'model-a',
  outputContract: 'text',
  allowedWorkTools: ['write_artifact'],
  allowedCollaborationTools: ['submit_result', 'ask_user', 'update_plan'],
};

function workingCopy(original: LibraryAgent | null, opener: HTMLElement): WorkingCopy | null {
  const baseline = original?.role ?? blank;
  const added = addAgent(emptyDraft(), { role: baseline }, { kind: 'empty' });
  if (!added.ok || !added.nodeId) return null;
  return {
    original,
    baseline,
    editor: createEditorStore(added.draft),
    nodeId: added.nodeId,
    opener,
  };
}

function OriginalDialog({
  copy,
  projectId,
  onClose,
  onSaved,
}: {
  copy: WorkingCopy;
  projectId: string;
  onClose(refreshList: boolean): void;
  onSaved(agent: LibraryAgent): void;
}) {
  const t = useTranslations();
  const { agents, transport } = useServices();
  const [session] = useState(() => createRunSession(transport));
  const [operation] = useState(operationId);
  const [current, setCurrent] = useState(copy);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LibraryError | null>(null);
  const [stale, setStale] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const profiles = useModelProfiles();
  const imageProfiles = useImageProfiles();
  // This private definition has exactly one role. Team inputs, output and placement never leave it.
  const role = useStore(current.editor, (state) => state.draft.definition.roles[0]);
  if (!role) throw new Error('Missing agent in the private editor');
  const { id: _id, origin: _origin, ...fields } = role;
  const valid = Boolean(fields.name.trim() && fields.prompt.trim());
  /** What is saved: the description without surrounding blanks. */
  function original(): LibraryAgentRole {
    const { description, ...rest } = fields;
    return description?.trim() ? { ...rest, description: description.trim() } : rest;
  }

  function close() {
    if (busy) return;
    if (canonicalJson(fields) !== canonicalJson(current.baseline)) setDiscarding(true);
    else onClose(error !== null || current !== copy);
  }
  async function save() {
    if (busy || !valid) return;
    setBusy(true);
    try {
      const result = current.original
        ? await agents.update(projectId, current.original.agentId, {
            expectedRevision: current.original.revision,
            role: original(),
          })
        : await agents.create(projectId, { role: original(), operationId: operation });
      if (result.ok) onSaved(result.agent);
      else {
        setError(result.error);
        if (result.error === 'revision_conflict') setStale(true);
      }
    } catch {
      setError('storage_unavailable');
    } finally {
      setBusy(false);
    }
  }
  async function reloadOriginal() {
    if (!current.original || busy) return;
    setBusy(true);
    try {
      const original = await agents.get(projectId, current.original.agentId);
      const next = original && workingCopy(original, copy.opener);
      if (next) {
        setCurrent(next);
        setStale(false);
        setError(null);
      } else setError(original ? 'invalid' : 'not_found');
    } catch {
      setError('storage_unavailable');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open, event) => {
        if (!open) {
          event.cancel();
          close();
        }
      }}
    >
      <DialogPopup size="lg" finalFocus={() => copy.opener}>
        <DialogHeader>
          <DialogTitle>
            {t(
              discarding
                ? 'Library.agents.discardTitle'
                : current.original
                  ? 'Library.agents.editTitle'
                  : 'Library.agents.create',
            )}
          </DialogTitle>
        </DialogHeader>
        <div hidden={discarding} inert={busy} className="min-w-0">
          <StudioStoresProvider editor={current.editor} session={session}>
            <RoleForm
              editor={current.editor}
              nodeId={current.nodeId}
              variant="original"
              profiles={profiles}
              imageProfiles={imageProfiles}
              roleSkills={(role, nodeId, { revealPolicy }) => (
                <RoleSkills
                  revealPolicy={revealPolicy}
                  mode="original"
                  projectId={projectId}
                  targetLabel={role.name}
                  roleId={role.id}
                  harness={role.harness}
                  mcpTools={role.mcpTools}
                  value={role.skills}
                  onApply={(skills) => current.editor.getState().updateNode(nodeId, { skills })}
                />
              )}
              roleTools={(role, nodeId, { revealPolicy }) => (
                <RoleTools
                  key={nodeId}
                  role={role}
                  projectId={projectId}
                  mode="original"
                  targetLabel={role.name}
                  revealPolicy={revealPolicy}
                  onApply={(mcpTools) => current.editor.getState().updateNode(nodeId, { mcpTools })}
                />
              )}
              roleSettings={(agent, nodeId) => (
                <HarnessRoleSettings role={agent} nodeId={nodeId} projectId={projectId} />
              )}
            />
          </StudioStoresProvider>
        </div>
        {error && !discarding ? (
          <div role="alert" className="grid gap-2 text-body text-destructive">
            {t(`Library.agents.errors.${error}`)}
            {stale ? (
              <Button
                className="justify-self-start"
                variant="tertiary"
                disabled={busy}
                onClick={() => void reloadOriginal()}
              >
                {t('Library.agents.reload')}
              </Button>
            ) : null}
          </div>
        ) : null}
        <DialogFooter>
          {discarding ? (
            <>
              <Button
                variant="tertiary"
                onClick={() => onClose(error !== null || current !== copy)}
              >
                {t('SettingsDialog.discard')}
              </Button>
              <Button onClick={() => setDiscarding(false)}>
                {t('SettingsDialog.keepEditing')}
              </Button>
            </>
          ) : (
            <>
              <Button variant="tertiary" onClick={close} disabled={busy}>
                {t('Workspace.cancel')}
              </Button>
              <Button onClick={() => void save()} disabled={!valid || stale || busy}>
                {t('Library.agents.save')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

export function LibraryAgents({
  projectId,
  initialAgent,
  toolbar,
  archivedProject = false,
}: {
  projectId: string;
  initialAgent?: string | undefined;
  toolbar: HTMLElement | null;
  archivedProject?: boolean;
}) {
  const t = useTranslations();
  const format = useFormatter();
  const ago = useSessionAge();
  const { agents } = useServices();
  const [catalog, setCatalog] = useState<Catalog>({ state: 'loading' });
  const [version, refresh] = useReducer((n: number) => n + 1, 0);
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const [selection, select] = useState(initialAgent);
  const linkTarget = useRef(initialAgent);
  const skillLabel = useSkillLabel();
  const [copy, setCopy] = useState<WorkingCopy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LibraryError | null>(null);
  const duplicateRequest = useRef<{ source: LibraryAgent; operation: string } | null>(null);

  useEffect(() => {
    void version;
    let active = true;
    setCatalog({ state: 'loading' });
    void agents.list(projectId).then(
      (items) => {
        if (!active) return;
        if (
          linkTarget.current &&
          items.find((item) => item.agentId === linkTarget.current)?.archivedAt
        )
          setArchived(true);
        linkTarget.current = undefined;
        setCatalog({ state: 'ready', items });
      },
      () => active && setCatalog({ state: 'failed' }),
    );
    return () => {
      active = false;
    };
  }, [agents, projectId, version]);

  function open(original: LibraryAgent | null, opener: HTMLElement) {
    const draft = workingCopy(original, opener);
    setError(draft ? null : 'invalid');
    setCopy(draft);
  }
  function saved(agent: LibraryAgent) {
    setCopy(null);
    setSearch('');
    select(agent.agentId);
    refresh();
  }
  async function change(source: LibraryAgent, action: 'archive' | 'duplicate') {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      let result: AgentLibraryResult;
      if (action === 'duplicate') {
        if (duplicateRequest.current?.source !== source)
          duplicateRequest.current = { source, operation: operationId() };
        result = await agents.create(projectId, {
          role: { ...source.role, name: t('Workspace.duplicateName', { name: source.role.name }) },
          operationId: duplicateRequest.current.operation,
        });
      } else {
        result = await agents.update(projectId, source.agentId, {
          archived: !source.archivedAt,
          expectedRevision: source.revision,
        });
      }
      if (result.ok) {
        duplicateRequest.current = null;
        saved(result.agent);
      } else setError(result.error);
    } catch {
      setError('storage_unavailable');
    } finally {
      setBusy(false);
    }
  }
  const items = catalog.state === 'ready' ? catalog.items : [];
  const query = search.trim().toLocaleLowerCase();
  const filtered = items.filter(
    ({ role, archivedAt }) =>
      (archived || !archivedAt) &&
      (!query ||
        role.name.toLocaleLowerCase().includes(query) ||
        !!agentDescription(role)?.toLocaleLowerCase().includes(query) ||
        role.prompt.toLocaleLowerCase().includes(query)),
  );
  const index = filtered.findIndex((item) => item.agentId === selection);
  const chosen = filtered[index];
  const chosenDescription = chosen && agentDescription(chosen.role);
  const skills = chosen?.role.skills ?? [];
  const names = skills.flatMap((ref) => skillLabel(ref) ?? []);
  const missing = skills.length - names.length;
  const create =
    !archivedProject &&
    toolbar &&
    createPortal(
      <Button size="compact" disabled={busy} onClick={(event) => open(null, event.currentTarget)}>
        {t('Library.agents.create')}
      </Button>,
      toolbar,
    );
  return (
    <div className="@container grid min-w-0 gap-4">
      {create}
      {items.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3">
          <Input
            aria-label={t('Library.agents.search')}
            placeholder={t('Library.agents.search')}
            className="min-w-0 flex-1 sm:max-w-72"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Switch
            label={t('Resources.showArchived')}
            checked={archived}
            onToggle={() => setArchived(!archived)}
          />
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-body text-destructive">
          {t(`Library.agents.errors.${error}`)}
          {(error === 'revision_conflict' || error === 'not_found') && (
            <Button
              variant="tertiary"
              onClick={() => {
                setError(null);
                refresh();
              }}
            >
              {t('Resources.reload')}
            </Button>
          )}
        </div>
      ) : null}
      {catalog.state === 'loading' ? (
        <p role="status" className="text-body text-muted-foreground">
          {t('Library.agents.loading')}
        </p>
      ) : catalog.state === 'failed' ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-body text-destructive">
          {t('Library.agents.loadFailed')}
          <Button variant="tertiary" onClick={refresh}>
            {t('Library.retry')}
          </Button>
        </div>
      ) : filtered.length === 0 ? (
        <EmptyState
          title={t(
            !items.length
              ? 'Library.agents.empty'
              : query
                ? 'Library.agents.noMatches'
                : 'Library.agents.onlyArchived',
          )}
          action={
            !items.length && !archivedProject ? (
              <Button variant="tertiary" onClick={(e) => open(null, e.currentTarget)}>
                {t('Library.agents.create')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div
          className={
            chosen
              ? 'grid min-w-0 items-start gap-6 @3xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]'
              : 'min-w-0'
          }
        >
          <Table aria-label={t('Library.view.agents')}>
            <TableHeader>
              <TableRow className={index === 0 ? ABOVE_CHOSEN_TABLE_ROW : undefined}>
                <TableHead className="w-1/4">{t('Inspector.label')}</TableHead>
                <TableHead>{t('Inspector.description')}</TableHead>
                <TableHead className="w-px whitespace-nowrap">{t('Library.view.skills')}</TableHead>
                <TableHead className="w-px whitespace-nowrap">
                  {t('Library.agents.updated')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((agent, i) => (
                <TableRow
                  key={agent.agentId}
                  index={i}
                  data-selected={i === index}
                  className={
                    i === index
                      ? CHOSEN_TABLE_ROW
                      : i + 1 === index
                        ? ABOVE_CHOSEN_TABLE_ROW
                        : undefined
                  }
                >
                  <TableCell className="max-w-0">
                    <button
                      type="button"
                      aria-pressed={i === index}
                      disabled={busy}
                      className="block w-full break-words text-left text-foreground after:absolute after:inset-0 after:content-['']"
                      onClick={() => {
                        select(agent.agentId);
                        setError(null);
                      }}
                    >
                      {agent.role.name}
                      {agent.archivedAt ? (
                        <small className="block text-caption text-muted-foreground">
                          {t('Projects.archived')}
                        </small>
                      ) : null}
                    </button>
                  </TableCell>
                  <TableCell className="max-w-0 truncate">
                    {agentDescription(agent.role) ?? firstSentence(agent.role.prompt)}
                  </TableCell>
                  <TableCell>{agent.role.skills?.length ?? 0}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    <time dateTime={agent.updatedAt}>{ago(agent.updatedAt)}</time>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {chosen ? (
            <section
              aria-label={t('Library.agents.detail')}
              className="grid min-w-0 content-start gap-4"
            >
              {/* As in the Teams and Skills details: the name, what can be done, then what it holds.
                  The description reads as the name's own line, so it takes no heading. */}
              <div className="grid gap-1">
                <h2>
                  <KitCardTitle>{chosen.role.name}</KitCardTitle>
                </h2>
                {chosenDescription ? (
                  <KitCardDescription className="whitespace-pre-wrap break-words">
                    {chosenDescription}
                  </KitCardDescription>
                ) : null}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="tertiary"
                  disabled={busy}
                  onClick={(event) => open(chosen, event.currentTarget)}
                >
                  {t('Library.teams.edit')}
                </Button>
                {!archivedProject && (
                  <Button
                    variant="tertiary"
                    disabled={busy}
                    onClick={() => void change(chosen, 'duplicate')}
                  >
                    {t('Workspace.duplicate')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  disabled={busy}
                  onClick={() => void change(chosen, 'archive')}
                >
                  {t(chosen.archivedAt ? 'Projects.restore' : 'Projects.archive')}
                </Button>
              </div>
              <section className="grid gap-1">
                <h3 className="text-subtitle">{t('Inspector.base')}</h3>
                <p className="whitespace-pre-wrap break-words text-body">{chosen.role.prompt}</p>
              </section>
              {names.length ? (
                <section className="grid gap-1">
                  <h3 className="text-subtitle">{t('Library.view.skills')}</h3>
                  <p className="break-words text-body">
                    {format.list(names, { type: 'unit' })}
                    {missing ? ` · ${t('Library.agents.skillCount', { count: missing })}` : null}
                  </p>
                </section>
              ) : (
                <p className="text-body text-muted-foreground">
                  {t('Library.agents.skillCount', { count: skills.length })}
                </p>
              )}
            </section>
          ) : null}
        </div>
      )}
      {copy ? (
        <OriginalDialog
          copy={copy}
          projectId={projectId}
          onClose={(refreshList) => {
            setCopy(null);
            if (refreshList) refresh();
          }}
          onSaved={saved}
        />
      ) : null}
    </div>
  );
}
