import type { HarnessOverrides, RoleRunOverrides } from '@corral/contracts';
import type { CorralRecord } from '@corral/core';
import {
  ApprovalPanel,
  ArtifactViewer,
  CorralCanvas,
  createRunSession,
  EditorToolbar,
  exportDocuments,
  NodeInspector,
  NodePalette,
  ReinsPanel,
  RunControls,
  type RunSessionStore,
  RunView,
  type SavedRevision,
  StudioStoresProvider,
  useSteerTarget,
  useStudioStores,
  ValidationPanel,
} from '@corral/react';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { ReactFlowProvider } from '@xyflow/react';
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { DemoGuide } from '../demo/DemoGuide.tsx';
import { DEMO_TEMPLATE_IDS, type DemoTemplateId } from '../demo/templates.ts';
import { useModelPrices } from '../prices.ts';
import { setCurrentProject } from '../projects.ts';
import { demoRoute, editorRoute } from '../router.tsx';
import { useServices } from '../services.tsx';
import {
  discardEditorCopy,
  type EditorWorkingCopy,
  editorWorkingCopy,
} from '../workbench/editorDraft.ts';
import { HarnessRoleSettings } from '../workbench/HarnessRoleSettings.tsx';
import { LoopRecipeSettings } from '../workbench/LoopRecipeSettings.tsx';
import { RunHarnessOverrides } from '../workbench/RunHarnessOverrides.tsx';
import { RunRoleOverrides } from '../workbench/RunRoleOverrides.tsx';
import { TabRow } from '../workbench/TabRow.tsx';
import { useModelProfiles } from '../workbench/useModels.ts';
import { useRunMode } from '../workbench/useRunMode.ts';

export function EditorPage() {
  const record = editorRoute.useLoaderData();
  const { repository } = useServices();
  const { fromRun, fromVersion, fromSession } = editorRoute.useSearch();
  // CR-010: the header shows the Corral's project, and `/` returns to it.
  useEffect(() => setCurrentProject(record.projectId), [record.projectId]);
  const copy = useMemo(() => editorWorkingCopy(repository, record), [repository, record]);
  return (
    <Editor
      key={`${record.projectId}:${record.corralId}:${record.definitionRevision}:${record.layoutRevision}`}
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
 * The session's team in its workbench (02-UX-Spec §3 팀 설계). It edits the saved team: the next
 * run of the session uses the saved revision; runs already started keep theirs.
 */
export function TeamDesign({ corralId }: { corralId: string }) {
  const t = useTranslations('Workbench');
  const { repository } = useServices();
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
  if (record === undefined) return <p className="p-4 text-sm text-muted">…</p>;
  if (!record || !copy) return <p className="p-4 text-sm text-muted">{t('noTeam')}</p>;
  return (
    <Editor
      key={record.corralId}
      record={record}
      workingCopy={copy}
      inSession
      toolbar={<span className="text-xs text-muted">{t('teamNote')}</span>}
    />
  );
}

export function DemoPage() {
  const { record, template } = demoRoute.useLoaderData();
  const { repository } = useServices();
  const copy = useMemo(() => editorWorkingCopy(repository, record), [repository, record]);
  return (
    <Editor
      key={record.corralId}
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

/** Switches the demo between its templates (C-063). */
function TemplatePicker({ current }: { current: DemoTemplateId }) {
  const t = useTranslations('Demo');
  const navigate = useNavigate();
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="text-muted">{t('template')}</span>
      <select
        value={current}
        onChange={(event) => {
          const template = event.target.value as DemoTemplateId;
          void navigate({
            to: '/demo',
            search: (search) =>
              template === 'starter' ? { ...search, template } : { ...search, template: undefined },
          });
        }}
        className="rounded-md border border-line bg-surface px-2 py-1"
      >
        {DEMO_TEMPLATE_IDS.map((id) => (
          <option key={id} value={id}>
            {t(`templates.${id}`)}
          </option>
        ))}
      </select>
    </label>
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
  /** Extra controls for the toolbar (the demo's template picker). */
  toolbar?: ReactNode;
  /** A guide shown above the run controls (the demo team's guide). */
  guide?: GuideSlot | undefined;
  /** A version the next run starts from, chosen on a Run page (CR-007). */
  startFrom?: StartFromChoice | null;
  /** Inside a session's workbench: runs start from the session, so no run controls here. */
  inSession?: boolean;
  /** Opened from this session: show the way back and when edits apply (UX-10). */
  fromSession?: string | null;
  workingCopy: EditorWorkingCopy;
}) {
  const t = useTranslations('Editor');
  const n = useTranslations('Navigation');
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
  const selectedNodeId = useStore(editor, (state) => state.selectedNodeId);
  const [inspector, setInspector] = useState<'design' | 'run'>(
    startFrom || guide ? 'run' : 'design',
  );
  const showDesign = useCallback(() => setInspector('design'), []);
  useEffect(() => {
    if (selectedNodeId) showDesign();
  }, [selectedNodeId, showDesign]);
  // Undo back to the saved draft returns the same object, so identity is the dirty check.
  const dirty = saving || draft !== saved.draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useBlocker({
    shouldBlockFn: ({ next }) => {
      if (!dirtyRef.current || next.pathname.startsWith('/settings')) return false;
      if (!window.confirm(t('leaveUnsaved'))) return true;
      discardEditorCopy(repository, record);
      return false;
    },
    enableBeforeUnload: () => dirtyRef.current,
  });

  /** Saves the draft; resolves to the saved record, or null when saving failed. */
  const save = useCallback(async (): Promise<CorralRecord | null> => {
    const { saved, saving } = workingCopy.getState();
    if (saving) return null;
    const current = editor.getState().draft;
    if (current === saved.draft) {
      workingCopy.setState({ message: { text: t('noChanges'), error: false } });
      return saved.record;
    }
    workingCopy.setState({ saving: true });
    try {
      const result = await repository.save({
        definition: current.definition,
        layout: { nodes: current.layout, viewport: current.viewport },
        expectedDefinitionRevision: saved.record.definitionRevision,
      });
      if (!result.ok) {
        workingCopy.setState({ message: { text: result.message, error: true } });
        return null;
      }
      workingCopy.setState({
        saved: { record: result.record, draft: current },
        message: {
          text: t('savedResult', {
            definition: String(result.changed.definition),
            layout: String(result.changed.layout),
          }),
          error: false,
        },
      });
      return result.record;
    } catch (error) {
      workingCopy.setState({
        message: { text: error instanceof Error ? error.message : String(error), error: true },
      });
      return null;
    } finally {
      workingCopy.setState({ saving: false });
    }
  }, [editor, repository, t, workingCopy]);

  // The local server runs saved revisions only, so a run saves first (C-057).
  const beforeStart =
    mode === 'server'
      ? async () => {
          const record = await save();
          return record
            ? { corralId: record.corralId, definitionRevision: record.definitionRevision }
            : null;
        }
      : undefined;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 's')
        return;
      event.preventDefault();
      void save();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  const exportFiles = () => {
    const files = exportDocuments(editor.getState().draft, saved.record.layoutRevision);
    download(`${record.corralId}.corral.json`, files.definition);
    download(`${record.corralId}.layout.json`, files.layout);
  };

  return (
    <StudioStoresProvider editor={editor} session={session}>
      <ReactFlowProvider>
        <div className="editor-shell h-full">
          <div
            className={`editor-frame grid h-full ${fromSession ? 'grid-rows-[auto_auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]'}`}
          >
            {fromSession ? (
              <div
                data-testid="from-session"
                className="flex flex-wrap items-center gap-2 border-b border-line bg-subtle/60 px-3 py-1.5 text-xs"
              >
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: fromSession }}
                  className="font-medium hover:underline"
                >
                  ← {t('backToSession')}
                </Link>
                <span className="text-muted">{t('appliesNextRun')}</span>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-3 py-2">
              <label className="flex items-center gap-2 text-sm">
                <span className="sr-only">{t('name')}</span>
                <input
                  value={draft.definition.name}
                  onChange={(e) => editor.getState().setName(e.target.value)}
                  onFocus={() => editor.getState().beginBatch()}
                  onBlur={() => editor.getState().endBatch()}
                  aria-label={t('name')}
                  className="rounded-md border border-line bg-surface px-2 py-1 font-medium"
                />
              </label>
              <span className="text-xs text-muted" data-testid="revisions">
                {t('revisions', {
                  definition: saved.record.definitionRevision,
                  layout: saved.record.layoutRevision,
                })}
              </span>
              <span
                className={`text-xs ${dirty ? 'text-warning' : 'text-muted'}`}
                aria-live="polite"
              >
                {dirty ? `● ${t('unsaved')}` : t('saved')}
              </span>
              <EditorToolbar />
              {toolbar}
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={exportFiles}
                  className="rounded-md border border-line px-3 py-1.5 text-sm"
                >
                  {t('export')}
                </button>
                <button
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                  className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent disabled:opacity-50"
                >
                  {saving ? t('saving') : t('save')}
                </button>
              </div>
              {message ? (
                <p
                  role={message.error ? 'alert' : 'status'}
                  className={`w-full text-xs ${message.error ? 'text-danger' : 'text-muted'}`}
                >
                  {message.text}
                </p>
              ) : null}
            </div>
            <main className="editor-layout grid min-h-0">
              <aside className="editor-palette flex min-h-0 flex-col gap-6 overflow-auto border-r border-line p-3">
                <NodePalette />
                <ValidationPanel />
              </aside>
              <div className="editor-canvas relative min-h-0 min-w-0">
                <CorralCanvas onNodeSelect={showDesign} />
                <CanvasNotice />
              </div>
              <aside className="editor-inspector flex min-h-0 min-w-0 flex-col overflow-auto border-l border-line">
                {!inSession ? (
                  <div className="sticky top-0 z-10 border-b border-line bg-surface p-2">
                    <TabRow
                      id="team-tools"
                      label={n('teamTools')}
                      values={['design', 'run']}
                      current={inspector}
                      text={(value) => n(value === 'design' ? 'design' : 'testRun')}
                      onChoose={setInspector}
                    />
                  </div>
                ) : null}
                <section
                  id="team-tools-design-panel"
                  role={inSession ? 'region' : 'tabpanel'}
                  aria-label={inSession ? n('design') : undefined}
                  aria-labelledby={inSession ? undefined : 'team-tools-design-tab'}
                  hidden={!inSession && inspector !== 'design'}
                  className="p-3"
                >
                  <NodeInspector
                    profiles={profiles}
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
                </section>
                {inSession ? null : (
                  <div
                    id="team-tools-run-panel"
                    role="tabpanel"
                    aria-labelledby="team-tools-run-tab"
                    hidden={inspector !== 'run'}
                    className="p-3"
                  >
                    <RunSide
                      startDisabled={saving}
                      projectId={record.projectId}
                      onStarted={() => setInspector('run')}
                      beforeStart={beforeStart}
                      liveAvailable={live}
                      guide={guide}
                      initialStartFrom={startFrom}
                    />
                  </div>
                )}
              </aside>
            </main>
          </div>
        </div>
      </ReactFlowProvider>
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
  // CR-007: the next run's starting point, until it starts or the person clears it.
  const [startFrom, setStartFrom] = useState<StartFromChoice | null>(initialStartFrom);
  const [setupOpen, setSetupOpen] = useState(true);
  const chooseStartFrom = (value: StartFromChoice) => {
    setStartFrom(value);
    setSetupOpen(true);
  };
  return (
    <section aria-labelledby="run-heading" className="flex flex-col gap-3">
      {guide?.(session, setChosen)}
      <p className="text-xs text-muted">{n('directRunHint')}</p>
      <details
        open={setupOpen}
        onToggle={(event) => setSetupOpen(event.currentTarget.open)}
        className="rounded-lg border border-line p-3"
      >
        <summary className="cursor-pointer text-sm font-medium">{n('prepareExecution')}</summary>
        <p className="my-2 text-xs text-muted">{n('runOverridesHint')}</p>
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
      </details>
      {runMode.error ? <p role="alert">{t('modeSaveFailed')}</p> : null}
      <RunControls
        startDisabled={startDisabled}
        mode={runMode.mode}
        onModeChange={runMode.select}
        harnessOverrides={harnessOverrides}
        roleOverrides={roleOverrides}
        onStarted={() => {
          setSetupOpen(false);
          onStarted();
          setChosen(null);
          setSelection(null);
          setRoleOverrides({});
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

function CanvasNotice() {
  const t = useTranslations('Canvas');
  const { editor } = useStudioStores();
  const notice = useStore(editor, (s) => s.notice);
  const nodes = useStore(editor, (s) => s.draft.definition.nodes);
  const labelOf = (id: string) => nodes.find((n) => n.id === id)?.label ?? id;
  const text =
    notice?.kind === 'rejected'
      ? t(`rejected.${notice.reason}`)
      : notice?.kind === 'connected'
        ? t('connected', { source: labelOf(notice.source), target: labelOf(notice.target) })
        : '';
  return (
    <p
      role="status"
      aria-live="polite"
      data-testid="canvas-notice"
      className="pointer-events-none absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-raised px-3 py-1 text-xs shadow empty:hidden"
    >
      {text}
    </p>
  );
}
