import type { HarnessOverrides, RoleRunOverrides } from '@corral/contracts';
import type { CorralRecord } from '@corral/core';
import {
  ApprovalPanel,
  ArtifactViewer,
  createRunSession,
  exportDefinition,
  ReinsPanel,
  RunControls,
  type RunSessionStore,
  RunView,
  type SavedRevision,
  StudioStoresProvider,
  TeamEditor,
  useSteerTarget,
  useStudioStores,
} from '@corral/react';
import { Button, KitBadge, Select } from '@corral/react/design-kit';
import { Activity, Play, Redo2, Undo2 } from '@corral/react/icons';
import { Link, useBlocker, useNavigate, useRouter } from '@tanstack/react-router';
import { type ReactNode, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { DemoGuide } from '../demo/DemoGuide.tsx';
import { DEMO_TEMPLATE_IDS, type DemoTemplateId } from '../demo/templates.ts';
import { useModelPrices } from '../prices.ts';
import { projectsChanged, setCurrentProject } from '../projects.ts';
import { demoRoute, editorRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import {
  blocksLeaving,
  discardEditorCopy,
  type EditorWorkingCopy,
  editorWorkingCopy,
  ownsSaveShortcut,
  saveEditorCopy,
} from '../workbench/editorDraft.ts';
import { HarnessRoleSettings } from '../workbench/HarnessRoleSettings.tsx';
import { LoopRecipeSettings } from '../workbench/LoopRecipeSettings.tsx';
import { MarkdownAgentImport } from '../workbench/MarkdownAgentImport.tsx';
import { settingsInteractionBlocked, settingsOnlyTransition } from '../workbench/navigation.ts';
import { panelKey } from '../workbench/panels/registry.ts';
import { RunBreakpoints } from '../workbench/RunBreakpoints.tsx';
import { RunHarnessOverrides } from '../workbench/RunHarnessOverrides.tsx';
import { RunRoleOverrides } from '../workbench/RunRoleOverrides.tsx';
import { useModelProfiles } from '../workbench/useModels.ts';
import { useRunMode } from '../workbench/useRunMode.ts';
import { useRunStats } from '../workbench/useRunStats.ts';
import { useSavedTeams } from '../workbench/useSavedTeams.ts';

export function EditorPage() {
  const record = editorRoute.useLoaderData();
  const services = useServices();
  const { repository } = services;
  const { fromRun, fromVersion, fromSession } = editorRoute.useSearch();
  // the header shows the Corral's project, and `/` returns to it.
  useEffect(() => setCurrentProject(record.projectId), [record.projectId]);
  const copy = useMemo(() => editorWorkingCopy(repository, record), [repository, record]);
  return (
    <Editor
      key={panelKey(services, {
        kind: 'graph',
        projectId: record.projectId,
        corralId: record.corralId,
      })}
      record={record}
      workingCopy={copy}
      startFrom={
        fromRun && fromVersion
          ? { runId: fromRun, artifactVersionId: fromVersion, label: fromVersion }
          : null
      }
      fromSession={fromSession ?? null}
    />
  );
}

/**
 * A saved team as a dock tab: the same editor and working copy
 * as its route, so a draft and its undo history are one whichever way it was opened. It edits the
 * saved team; the next run of the session uses the saved revision, and runs already started keep
 * theirs. Test runs stay on the route; session runs are controlled from the dock's run controls.
 */
export function TeamDesign({ corralId }: { corralId: string }) {
  const t = useTranslations('Docking');
  const te = useTranslations('Editor');
  const services = useServices();
  const { repository } = services;
  const [record, setRecord] = useState<CorralRecord | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    repository.get(corralId).then(
      (found) => live && setRecord(found),
      () => live && setRecord(null),
    );
    return () => {
      live = false;
    };
  }, [repository, corralId]);
  const copy = useMemo(
    () => (record ? editorWorkingCopy(repository, record) : null),
    [repository, record],
  );
  if (record === undefined) return <p className="p-4 text-sm text-muted-foreground">…</p>;
  if (!record || !copy)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        {t('unknownPanel')}
      </p>
    );
  return (
    <Editor
      key={panelKey(services, {
        kind: 'graph',
        projectId: record.projectId,
        corralId: record.corralId,
      })}
      record={record}
      workingCopy={copy}
      inSession
      toolbar={<span className="text-xs text-muted-foreground">{te('appliesNextRun')}</span>}
    />
  );
}

export function DemoPage() {
  const { record, template } = demoRoute.useLoaderData();
  const services = useServices();
  const { repository } = services;
  const copy = useMemo(() => editorWorkingCopy(repository, record), [repository, record]);
  return (
    <Editor
      key={panelKey(services, {
        kind: 'graph',
        projectId: record.projectId,
        corralId: record.corralId,
      })}
      record={record}
      workingCopy={copy}
      toolbar={<TemplatePicker current={template} />}
      guide={
        template === 'research-team'
          ? (session, onSteer) => (
              <DemoGuide session={session} corralId={record.corralId} onSteer={onSteer} />
            )
          : undefined
      }
    />
  );
}

/** Switches the demo between its templates. */
function TemplatePicker({ current }: { current: DemoTemplateId }) {
  const t = useTranslations('Demo');
  const navigate = useNavigate();
  return (
    <div className="flex items-center gap-2 text-xs">
      <span aria-hidden="true" className="text-muted-foreground">
        {t('template')}
      </span>
      <Select
        variant="chip"
        label={t('template')}
        value={current}
        onValueChange={(template) => {
          void navigate({
            to: '/demo',
            search: (search) =>
              template === 'starter' ? { ...search, template } : { ...search, template: undefined },
          });
        }}
        options={DEMO_TEMPLATE_IDS.map((id) => ({ value: id, label: t(`templates.${id}`) }))}
      />
    </div>
  );
}

type GuideSlot = (session: RunSessionStore, onSteer: (executionId: string) => void) => ReactNode;

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

type StartFromChoice = { runId: string; artifactVersionId: string; label: string };

function Editor({
  record,
  toolbar,
  guide,
  startFrom = null,
  inSession = false,
  fromSession = null,
  workingCopy,
}: {
  record: CorralRecord;
  /** Extra controls for the header (the demo's template picker). */
  toolbar?: ReactNode;
  /** A guide shown above the run controls (the demo team's guide). */
  guide?: GuideSlot | undefined;
  /** A version the next run starts from, chosen on a Run page. */
  startFrom?: StartFromChoice | null;
  /** Inside a session's workbench: runs start from the session, so no run controls here. */
  inSession?: boolean;
  /** Opened from this session: show the way back and when edits apply. */
  fromSession?: string | null;
  workingCopy: EditorWorkingCopy;
}) {
  const t = useTranslations('Editor');
  const c = useTranslations('TeamEditor');
  const router = useRouter();
  const navigate = useNavigate();
  const services = useServices();
  const { editor, saved, saving, message } = useStore(workingCopy);
  const { repository, mode, live } = services;
  const session = useMemo(() => {
    const key = JSON.stringify([record.projectId, record.corralId]);
    let view = services.editorSessions.get(key);
    if (!view) {
      view = createRunSession(services.transport);
      services.editorSessions.set(key, view);
    }
    return view;
  }, [services, record.projectId, record.corralId]);
  const profiles = useModelProfiles();
  const draft = useStore(editor, (s) => s.draft);
  const canUndo = useStore(editor, (s) => s.canUndo);
  const canRedo = useStore(editor, (s) => s.canRedo);
  const teams = useSavedTeams(record, draft.definition);
  const [runOpen, setRunOpen] = useState(Boolean(startFrom || guide));
  const [statsOn, setStatsOn] = useState(false);
  const revision = saved.record.definitionRevision;
  const runStats = useRunStats(services.transport, statsOn, record.corralId, revision);
  const runId = useId();
  // Undo back to the saved draft returns the same object, so identity is the dirty check.
  const dirty = saving || draft !== saved.draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const shell = useRef<HTMLDivElement>(null);

  useBlocker({
    shouldBlockFn: ({ current, next }) => {
      if (
        !blocksLeaving(dirtyRef.current, inSession) ||
        next.pathname.startsWith('/settings') ||
        settingsOnlyTransition(current, next)
      )
        return false;
      if (!window.confirm(t('leaveUnsaved'))) return true;
      discardEditorCopy(repository, record);
      return false;
    },
    enableBeforeUnload: () => dirtyRef.current,
  });

  /** Saves the draft; resolves to the saved record, or null when saving failed. */
  const save = useCallback(async (): Promise<CorralRecord | null> => {
    const result = await saveEditorCopy(workingCopy, repository, {
      noChanges: t('noChanges'),
      saved: (changed) => t('savedResult', { definition: String(changed.definition) }),
    });
    if (result?.wrote) {
      projectsChanged();
      await router.invalidate();
    }
    return result?.record ?? null;
  }, [repository, router, t, workingCopy]);

  // The local server runs saved revisions only, so a run saves first.
  const beforeStart =
    mode === 'server'
      ? async () => {
          const record = await save();
          return record
            ? { corralId: record.corralId, definitionRevision: record.definitionRevision }
            : null;
        }
      : undefined;

  // The last place pressed stands in for focus when nothing has it.
  const pressed = useRef<Element | null>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      pressed.current = event.target instanceof Element ? event.target : null;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (settingsInteractionBlocked()) return;
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
        return;
      const focused =
        document.activeElement && document.activeElement !== document.body
          ? document.activeElement
          : pressed.current;
      if (!ownsSaveShortcut(inSession, shell.current, focused)) return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [save, inSession]);

  const exportFile = () =>
    download(`${record.corralId}.corral.json`, exportDefinition(editor.getState().draft));

  return (
    <StudioStoresProvider editor={editor} session={session}>
      <div
        ref={shell}
        className={`grid h-full min-h-0 ${fromSession ? 'grid-rows-[auto_auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]'}`}
      >
        {fromSession ? (
          <div
            data-testid="from-session"
            className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-4 py-1.5 text-caption"
          >
            <Link
              to="/sessions/$sessionId"
              params={{ sessionId: fromSession }}
              className="font-medium hover:underline"
            >
              ← {t('backToSession')}
            </Link>
            <span className="text-muted-foreground">{t('appliesNextRun')}</span>
          </div>
        ) : null}
        <header className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border py-1.5 pr-3 pl-4">
          <h1 className="min-w-0 truncate text-body font-semibold text-foreground">
            {draft.definition.name}
          </h1>
          <span className="text-caption text-muted-foreground" data-testid="revisions">
            {t('revisions', { definition: saved.record.definitionRevision })}
          </span>
          <span aria-live="polite">
            <KitBadge size="compact" color={dirty ? 'amber' : 'gray'}>
              {saving ? c('saving') : dirty ? c('unsaved') : c('saved')}
            </KitBadge>
          </span>
          {message ? (
            <p
              role={message.error ? 'alert' : 'status'}
              className={`min-w-0 truncate text-caption ${message.error ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {message.text}
            </p>
          ) : null}
          <span className="grow" />
          {runStats.status === 'off' ? null : (
            <span
              role="status"
              className={`text-caption ${runStats.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}
            >
              {runStats.status === 'loading'
                ? c('stats.loading')
                : runStats.status === 'failed'
                  ? c('stats.failed')
                  : runStats.stats.runs.length
                    ? c('stats.summary', { revision, count: runStats.stats.runs.length })
                    : c('stats.empty', { revision })}
            </span>
          )}
          <Button
            variant="tertiary"
            size="compact"
            aria-pressed={statsOn}
            onClick={() => setStatsOn((on) => !on)}
          >
            <Activity /> {c('stats.toggle')}
          </Button>
          {toolbar}
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={c('undo')}
            disabled={!canUndo}
            onClick={() => editor.getState().undo()}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={c('redo')}
            disabled={!canRedo}
            onClick={() => editor.getState().redo()}
          >
            <Redo2 />
          </Button>
          <MarkdownAgentImport editor={editor} profiles={profiles} projectId={record.projectId} />
          <Button type="button" onClick={exportFile} variant="tertiary" size="compact">
            {t('export')}
          </Button>
          {inSession ? null : (
            <Button
              variant="tertiary"
              size="compact"
              aria-controls={runId}
              aria-expanded={runOpen}
              onClick={() => setRunOpen((open) => !open)}
            >
              <Play /> {c(runOpen ? 'hideRun' : 'testRun')}
            </Button>
          )}
          <Button
            variant="primary"
            size="compact"
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
          >
            {saving ? t('saving') : t('save')}
          </Button>
        </header>
        <div
          className={`grid min-h-0 ${runOpen && !inSession ? 'grid-cols-[minmax(0,1fr)_minmax(320px,400px)]' : 'grid-cols-1'}`}
        >
          <TeamEditor
            editor={editor}
            profiles={profiles}
            teams={teams.references}
            resolveTeam={teams.resolve}
            onOpenTeam={(corralId) =>
              void navigate({ to: '/corrals/$corralId/edit', params: { corralId } })
            }
            runStats={
              runStats.status === 'ready'
                ? { stats: runStats.stats, definition: saved.record.definition }
                : null
            }
            onOpenRun={(runId) => void navigate({ to: '/runs/$runId', params: { runId } })}
            loopSettings={(node) => (
              <LoopRecipeSettings
                key={`${node.id}:${node.reviewRecipe?.revision ?? 0}`}
                node={node}
                projectId={record.projectId}
              />
            )}
            roleSettings={(role, nodeId) => (
              <HarnessRoleSettings
                key={nodeId}
                role={role}
                nodeId={nodeId}
                projectId={record.projectId}
              />
            )}
          />
          {inSession ? null : (
            <aside
              id={runId}
              aria-label={c('testRun')}
              hidden={!runOpen}
              className="min-h-0 overflow-auto border-l border-border p-3"
            >
              <RunSide
                startDisabled={saving}
                projectId={record.projectId}
                onStarted={() => setRunOpen(true)}
                beforeStart={beforeStart}
                liveAvailable={live}
                guide={guide}
                initialStartFrom={startFrom}
              />
            </aside>
          )}
        </div>
      </div>
    </StudioStoresProvider>
  );
}

function RunSide({
  startDisabled,
  projectId,
  onStarted,
  beforeStart,
  liveAvailable,
  guide,
  initialStartFrom,
}: {
  projectId: string;
  startDisabled: boolean;
  onStarted: () => void;
  beforeStart?: (() => Promise<SavedRevision | null>) | undefined;
  liveAvailable: boolean;
  guide?: GuideSlot | undefined;
  initialStartFrom: StartFromChoice | null;
}) {
  const t = useTranslations('Editor');
  const n = useTranslations('Navigation');
  const { session, editor } = useStudioStores();
  const definition = useStore(editor, (state) => state.draft.definition);
  const runMode = useRunMode(projectId, 'corral', definition.id);
  const profiles = useModelProfiles();
  const [roleOverrides, setRoleOverrides] = useState<RoleRunOverrides>({});
  const [breakpoints, setBreakpoints] = useState<string[]>([]);
  const roles = definition.roles.map((role) => ({
    roleId: role.id,
    name: role.name,
    profileId: role.modelProfile,
    ...(role.reasoning ? { reasoning: role.reasoning } : {}),
    ...(role.harness ? { harness: role.harness } : {}),
  }));
  const key = JSON.stringify([projectId, definition.id, roles]);
  const [selection, setSelection] = useState<{ key: string; value: HarnessOverrides } | null>(null);
  const harnessOverrides = selection?.key === key ? selection.value : {};
  const runId = useStore(session, (s) => s.runId);
  const [chosen, setChosen] = useState<string | null>(null);
  const target = useSteerTarget(session, chosen);
  const [viewing, setViewing] = useState<string | null>(null);
  const prices = useModelPrices();
  // the next run's starting point, until it starts or the person clears it.
  const [startFrom, setStartFrom] = useState<StartFromChoice | null>(initialStartFrom);
  const [setupOpen, setSetupOpen] = useState(true);
  const chooseStartFrom = (value: StartFromChoice) => {
    setStartFrom(value);
    setSetupOpen(true);
  };
  return (
    <section aria-labelledby="run-heading" className="flex flex-col gap-3">
      {guide?.(session, setChosen)}
      <p className="text-xs text-muted-foreground">{n('directRunHint')}</p>
      <details
        open={setupOpen}
        onToggle={(event) => setSetupOpen(event.currentTarget.open)}
        className="rounded-lg fill-group p-3"
      >
        <summary className="cursor-pointer text-sm font-medium">{n('prepareExecution')}</summary>
        <p className="my-2 text-xs text-muted-foreground">{n('runOverridesHint')}</p>
        <RunRoleOverrides
          roles={roles}
          profiles={profiles}
          value={roleOverrides}
          onChange={setRoleOverrides}
        />
        <RunHarnessOverrides
          roles={roles}
          projectId={projectId}
          value={harnessOverrides}
          onChange={(value) => setSelection({ key, value })}
        />
        <RunBreakpoints nodes={definition.nodes} value={breakpoints} onChange={setBreakpoints} />
      </details>
      {runMode.error ? <p role="alert">{t('modeSaveFailed')}</p> : null}
      <RunControls
        startDisabled={startDisabled}
        mode={runMode.mode}
        onModeChange={runMode.select}
        harnessOverrides={harnessOverrides}
        roleOverrides={roleOverrides}
        breakpoints={breakpoints.filter((id) => definition.nodes.some((node) => node.id === id))}
        onStarted={() => {
          setSetupOpen(false);
          onStarted();
          setChosen(null);
          setSelection(null);
          setRoleOverrides({});
          setBreakpoints([]);
          setViewing(null);
          setStartFrom(null);
        }}
        liveAvailable={liveAvailable}
        startFrom={startFrom}
        onClearStartFrom={() => setStartFrom(null)}
        {...(beforeStart ? { beforeStart } : {})}
      />
      <RunView
        session={session}
        onSteer={setChosen}
        onStartFrom={chooseStartFrom}
        prices={prices}
      />
      <ApprovalPanel session={session} onOpenArtifact={setViewing} />
      {viewing ? (
        <ArtifactViewer
          session={session}
          versionId={viewing}
          onClose={() => setViewing(null)}
          onStartFrom={chooseStartFrom}
        />
      ) : null}
      {runId ? (
        <Link
          to="/runs/$runId"
          params={{ runId }}
          // Keep the execution chosen here: the Run page opens on the same one.
          search={chosen ? { execution: chosen } : {}}
          className="text-xs underline"
        >
          {t('openRun')}
        </Link>
      ) : null}
      <ReinsPanel session={session} target={target} />
    </section>
  );
}
