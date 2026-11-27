import type { HarnessOverrides, HarnessPreviewRole, RoleRunOverrides } from '@corral/contracts';
import type { CorralRecord, ProjectSummary } from '@corral/core';
import {
  ApprovalPanel,
  ArtifactViewer,
  compileDraft,
  createRunSession,
  type DraftCompilation,
  type EditorDraft,
  exportDefinition,
  ReinsPanel,
  RunControls,
  type RunSessionStore,
  RunView,
  StudioStoresProvider,
  TEAM_EDITOR_BESIDE_MIN,
  type TeamAssistantHost,
  TeamEditor,
  type TeamEditorNavigation,
  type TeamEditorProps,
  type TeamEditorView,
  useSteerTarget,
  useStudioStores,
} from '@corral/react';
import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  fontWeights,
  KitBadge,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Select,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
} from '@corral/react/design-kit';
import { Activity, ChevronDown, Ellipsis, Play, Redo2, Undo2, X } from '@corral/react/icons';
import { Link, Outlet, useBlocker, useNavigate, useRouter } from '@tanstack/react-router';
import {
  type ComponentProps,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useMessages, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { DemoGuide } from '../../demo/DemoGuide.tsx';
import { DEMO_TEMPLATE_IDS, type DemoTemplateId } from '../../demo/templates.ts';
import { useModelPrices } from '../../prices.ts';
import { projectName, projectsChanged, setCurrentProject } from '../../projects.ts';
import { demoRoute, editorRoute, newEditorRoute } from '../../router.tsx';
import { useServices } from '../../services.tsx';
import { draftWording, templateDefinition, useTemplateText } from '../../templates.ts';
import {
  blocksLeaving,
  discardEditorCopy,
  type EditorWorkingCopy,
  editorDraftChanged,
  editorWorkingCopy,
  firstSaveDefinition,
  loadLatestEditorCopy,
  newEditorWorkingCopy,
  ownsSaveShortcut,
  saveEditorCopy,
  saveEditorCopyOver,
} from '../../workbench/editorDraft.ts';
import { readEditorView, rememberEditorView } from '../../workbench/editorView.ts';
import { HarnessRoleSettings } from '../../workbench/HarnessRoleSettings.tsx';
import { LoopRecipeSettings } from '../../workbench/LoopRecipeSettings.tsx';
import { MarkdownAgentImport } from '../../workbench/MarkdownAgentImport.tsx';
import {
  settingsInteractionBlocked,
  settingsOnlyTransition,
  useSettingsNavigation,
} from '../../workbench/navigation.ts';
import { panelKey } from '../../workbench/panels/registry.ts';
import { RoleSkills, useSkillLabel } from '../../workbench/RoleSkills.tsx';
import { RoleTools } from '../../workbench/RoleTools.tsx';
import { RunBreakpoints } from '../../workbench/RunBreakpoints.tsx';
import { RunHarnessOverrides } from '../../workbench/RunHarnessOverrides.tsx';
import { RunRoleOverrides } from '../../workbench/RunRoleOverrides.tsx';
import { RunSetupSummary } from '../../workbench/RunSetupSummary.tsx';
import { UnsavedChangesDialog } from '../../workbench/SettingsLifecycle.tsx';
import { teamChoices } from '../../workbench/teamChoices.ts';
import { useContainerAtLeast } from '../../workbench/useContainerAtLeast.ts';
import { useImageProfiles } from '../../workbench/useImageProfiles.ts';
import { useModelProfileRead, useModelProfiles } from '../../workbench/useModels.ts';
import { useRunMode } from '../../workbench/useRunMode.ts';
import { useRunStats } from '../../workbench/useRunStats.ts';
import { useSavedTeams } from '../../workbench/useSavedTeams.ts';

export function EditorPage() {
  const existing = editorRoute.useMatch({ shouldThrow: false });
  const fresh = newEditorRoute.useMatch({ shouldThrow: false });
  const record = existing?.loaderData;
  const { fromRun, fromVersion, fromSession } = existing?.search ?? {};
  const services = useServices();
  const { repository, newCorralId } = services;
  const text = useTemplateText();
  const projectId = record?.projectId ?? fresh?.loaderData?.projectId;
  const template = fresh?.loaderData?.newTemplate;
  useEffect(() => {
    if (projectId) setCurrentProject(projectId);
  }, [projectId]);
  const copy = useMemo(() => {
    if (record) return editorWorkingCopy(repository, record);
    if (!projectId || !template) return null;
    return newEditorWorkingCopy(repository, projectId, template !== 'blank', () =>
      templateDefinition(template, newCorralId(), text),
    );
  }, [repository, record, projectId, template, newCorralId, text]);
  if (!copy) return <Outlet />;
  return (
    <Editor
      key={panelKey(services, {
        kind: 'graph',
        projectId: copy.getState().projectId,
        corralId: copy.getState().editor.getInitialState().draft.definition.id,
      })}
      assistantStart={template === 'blank' || fresh?.search.assistant ? { open: true } : undefined}
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
export function TeamDesign({ corralId, sessionId }: { corralId: string; sessionId?: string }) {
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
  if (record === undefined) return <p className="p-4 text-body text-muted-foreground">…</p>;
  if (!record || !copy)
    return (
      <p role="status" className="p-4 text-body text-muted-foreground">
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
      workingCopy={copy}
      inSession
      workspaceSessionId={sessionId}
      toolbar={
        <KitBadge size="compact" color="gray">
          {te('appliesNextRun')}
        </KitBadge>
      }
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
      workingCopy={copy}
      localAssistant
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
    <div className="flex items-center gap-2 text-caption">
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

type LeaveChoice = 'save' | 'discard' | 'keep';
type StartFromChoice = { runId: string; artifactVersionId: string; label: string };

function Editor({
  toolbar,
  guide,
  startFrom = null,
  inSession = false,
  fromSession = null,
  workspaceSessionId = fromSession ?? undefined,
  assistantStart,
  localAssistant = false,
  workingCopy,
}: {
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
  workspaceSessionId?: string | undefined;
  assistantStart?: TeamEditorProps['assistantStart'];
  /** The template demo never sends an assistant request, even on a connected server. */
  localAssistant?: boolean;
  workingCopy: EditorWorkingCopy;
}) {
  const t = useTranslations('Editor');
  const c = useTranslations('TeamEditor');
  const tr = useTranslations('Run');
  const n = useTranslations('Navigation');
  const ts = useTranslations('Sessions');
  const sd = useTranslations('SettingsDialog');
  const router = useRouter();
  const navigate = useNavigate();
  const services = useServices();
  const { editor, projectId, saved, saving, message } = useStore(workingCopy);
  const corralId = editor.getInitialState().draft.definition.id;
  const { repository, mode, live } = services;
  const session = useMemo(() => {
    const key = JSON.stringify([projectId, corralId]);
    let view = services.editorSessions.get(key);
    if (!view) {
      view = createRunSession(services.transport);
      services.editorSessions.set(key, view);
    }
    return view;
  }, [services, projectId, corralId]);
  const profileRead = useModelProfileRead();
  const profiles = profileRead === 'failed' ? null : profileRead;
  // The endpoint asks the first model of the list that can run: named profiles, then connections.
  const assistantModel = (!localAssistant && live && profiles?.find((p) => p.available)) || null;
  const messages = useMessages();
  const wording = useMemo(() => draftWording(messages), [messages]);
  const settings = useSettingsNavigation();
  const presetText = useTranslations('TeamTemplates.presets');
  const assistant = useMemo<TeamAssistantHost>(() => {
    const models = services.models;
    const { agents, harnesses } = services;
    return {
      ask:
        models && assistantModel ? (request, signal) => models.assistTeam(request, signal) : null,
      ...(assistantModel ? { modelLabel: assistantModel.modelName ?? assistantModel.label } : {}),
      // Until the list arrives the editor does not know whether a model can run; a list that
      // cannot be read leaves none.
      ...(live && !localAssistant && profileRead === null && { modelPending: true }),
      wording,
      // Read when a new team is asked for, so the catalog is what "add agent" offers then.
      choices: () =>
        teamChoices({
          projectId,
          agents,
          harnesses,
          presetName: (id) => presetText(`${id}.name`),
        }),
      newOperationId: () => crypto.randomUUID(),
      ...(live &&
        !localAssistant && { onConnectModel: () => void navigate(settings.link('models')) }),
      onBrowseTemplates: () =>
        void navigate({ to: '/library/templates', search: { project: projectId } }),
    };
  }, [
    assistantModel,
    profileRead,
    services,
    presetText,
    wording,
    navigate,
    settings,
    projectId,
    live,
    localAssistant,
  ]);
  const imageProfiles = useImageProfiles();
  const skillLabel = useSkillLabel();
  const draft = useStore(editor, (s) => s.draft);
  const canUndo = useStore(editor, (s) => s.canUndo);
  const canRedo = useStore(editor, (s) => s.canRedo);
  const teams = useSavedTeams({ projectId, corralId }, draft.definition);
  const originals = useAgentOriginals(projectId);
  const checking = teams.issues.some((i) => i.state === 'loading');
  const failed = teams.issues.some((i) => i.state === 'failed');
  const validation = useMemo(() => {
    if (checking || failed) return null;
    const definition = saved.record ? draft.definition : firstSaveDefinition(draft.definition);
    return compileDraft(definition === draft.definition ? draft : { ...draft, definition }, {
      resolveTeam: teams.resolve,
      ...(profiles?.length ? { knownModelProfiles: profiles.map((p) => p.profileId) } : {}),
    });
  }, [draft, teams.resolve, profiles, checking, failed, saved.record]);
  const editorNavigation = useRef<TeamEditorNavigation>(null);
  const [openingSession, setOpeningSession] = useState(false);
  const opening = useRef(false);
  const readHarnessAsk = useHarnessAsk(projectId);
  const [runOpen, setRunOpen] = useState(Boolean(startFrom || guide));
  const startMock = useRef<() => void>(null);
  const mockButton = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<TeamEditorView>(() =>
    saved.record ? readEditorView(corralId) : 'composition',
  );
  const viewRef = useRef(view);
  const discarded = useRef(false);
  const [importOpen, setImportOpen] = useState(false);
  const more = useRef<HTMLButtonElement>(null);
  const [statsOn, setStatsOn] = useState(false);
  const revision = saved.record?.definitionRevision ?? 0;
  const runStats = useRunStats(
    services.transport,
    Boolean(saved.record && view === 'graph' && statsOn),
    corralId,
    revision,
  );
  const runId = useId();
  const changed = editorDraftChanged(draft, saved);
  const dirty = saving || changed;
  const emptyNewTeam = !saved.record && !changed;
  const saveReason = saving ? t('saving') : !changed ? t('noChanges') : undefined;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const shell = useRef<HTMLDivElement>(null);
  // The test run sits beside the editor while the editor keeps 640px next to its narrowest panel.
  const body = useRef<HTMLDivElement>(null);
  const roomBeside = useContainerAtLeast(body, 640 + 320);
  const runBeside = runOpen && !inSession && roomBeside;
  const runInPlace = runOpen && !inSession && !roomBeside;
  // The editor stacks by its own width, which a test run beside it narrows.
  const column = useRef<HTMLDivElement>(null);
  const stacked = !useContainerAtLeast(column, TEAM_EDITOR_BESIDE_MIN);
  const changeView = (next: TeamEditorView) => {
    setView(next);
    viewRef.current = next;
    if (saved.record) rememberEditorView(corralId, next);
    if (runInPlace) setRunOpen(false);
  };

  const [leaving, setLeaving] = useState<((choice: LeaveChoice) => void) | null>(null);
  const saveNow = useRef<() => Promise<unknown>>(async () => null);
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (
        inSession ||
        (current.pathname === '/corrals/new/edit' &&
          next.pathname === `/corrals/${corralId}/edit` &&
          workingCopy.getState().saved.record) ||
        next.pathname.startsWith('/settings') ||
        settingsOnlyTransition(current, next)
      )
        return false;
      if (blocksLeaving(dirtyRef.current, inSession)) {
        const choice = await new Promise<LeaveChoice>((resolve) => setLeaving(() => resolve));
        setLeaving(null);
        if (choice === 'keep') return true;
        if (choice === 'save') return !(await saveNow.current());
      }
      if (!saved.record || dirtyRef.current) {
        discarded.current = true;
        discardEditorCopy(repository, { projectId, corralId: saved.record?.corralId ?? null });
        if (!saved.record) services.editorSessions.delete(JSON.stringify([projectId, corralId]));
      }
      return false;
    },
    enableBeforeUnload: () => dirtyRef.current,
  });

  const save = useCallback(
    async (over = false) => {
      const first = !workingCopy.getState().saved.record;
      const result = await (over ? saveEditorCopyOver : saveEditorCopy)(workingCopy, repository, {
        noChanges: t('noChanges'),
        saved: (changed) => t('savedResult', { definition: String(changed.definition) }),
        renamed: (name) => t('savedAs', { name }),
        invalid: t('fixProblems'),
      });
      if (!result && first && workingCopy.getState().message?.problems)
        editorNavigation.current?.showProblems();
      if (result?.wrote) {
        projectsChanged();
        if (first && !discarded.current) {
          rememberEditorView(result.record.corralId, viewRef.current);
          await navigate({
            to: '/corrals/$corralId/edit',
            params: { corralId: result.record.corralId },
            replace: true,
          });
        } else if (!discarded.current) await router.invalidate();
      }
      return discarded.current ? null : result;
    },
    [repository, router, navigate, t, workingCopy],
  );
  saveNow.current = () => save();

  // A save may finish after the person has edited again. Only the draft the action
  // was requested for can launch that revision or take the person out of this editor.
  const stillCurrent = (expected: EditorDraft) => {
    if (editor.getState().draft === expected) return true;
    workingCopy.setState({ message: { error: true, text: tr('draftChanged') } });
    return false;
  };
  const saveForAction = async () => {
    if (!stillCurrent(draft)) return null;
    const result = await save();
    return result && stillCurrent(result.draft) ? result : null;
  };
  const beforeStart =
    mode === 'server' || !saved.record
      ? async () => {
          const result = await saveForAction();
          if (!result) return null;
          return mode === 'server'
            ? {
                corralId: result.record.corralId,
                definitionRevision: result.record.definitionRevision,
              }
            : result.draft.definition;
        }
      : undefined;
  const openConversation = async () => {
    if (opening.current) return;
    opening.current = true;
    setOpeningSession(true);
    try {
      const result = await saveForAction();
      if (!result) return;
      const { record: saved, draft: committed } = result;
      const original = fromSession ? await repository.getSession(fromSession) : null;
      if (!stillCurrent(committed)) return;
      let sessionId =
        original?.projectId === saved.projectId &&
        original.corralId === saved.corralId &&
        !original.archivedAt
          ? original.sessionId
          : null;
      if (!sessionId) {
        const result = await repository.createSession({
          projectId: saved.projectId,
          corralId: saved.corralId,
          title: ts('new'),
          autoTitle: true,
          objective: '',
        });
        if (!result.ok) {
          workingCopy.setState({ message: { error: true, text: result.message } });
          return;
        }
        sessionId = result.session.sessionId;
        projectsChanged();
      }
      if (stillCurrent(committed))
        await navigate({ to: '/sessions/$sessionId', params: { sessionId } });
    } catch (error) {
      workingCopy.setState({
        message: { error: true, text: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      opening.current = false;
      setOpeningSession(false);
    }
  };
  const showProblems = () => {
    if (runInPlace) setRunOpen(false);
    editorNavigation.current?.showProblems();
  };

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
    download(`${corralId}.corral.json`, exportDefinition(editor.getState().draft));
  const conflict = Boolean(message?.error && message.code === 'revision_conflict' && saved.record);
  const messageText = !message?.code
    ? message?.text
    : message.code === 'revision_conflict'
      ? saved.record
        ? message.text
        : t('saveError.idTaken')
      : t(`saveError.${message.code}`, { message: message.text });
  const loadLatest = async () => {
    if ((await loadLatestEditorCopy(workingCopy, repository)) && !discarded.current)
      await router.invalidate();
  };

  return (
    <StudioStoresProvider editor={editor} session={session}>
      <Tabs
        ref={shell}
        value={view}
        onValueChange={(next) => {
          if (next === 'composition' || next === 'graph') changeView(next);
        }}
        className={`@container grid h-full min-h-0 min-w-0 grid-cols-1 ${conflict ? 'grid-rows-[auto_auto_minmax(0,1fr)]' : 'grid-rows-[auto_minmax(0,1fr)]'}`}
      >
        {/* One header row: the way back to the session leads it instead of a row of its own. */}
        <header className="flex min-h-12 flex-wrap items-center gap-2 border-b border-border py-1.5 pr-3 pl-4">
          {fromSession ? (
            <Button
              data-testid="from-session"
              className="order-first"
              variant="ghost"
              size="compact"
              render={<Link to="/sessions/$sessionId" params={{ sessionId: fromSession }} />}
            >
              ← {t('backToSession')}
            </Button>
          ) : null}
          {/* The path bar names the team on screen (and the outline's team row); the heading
              stays for the document outline. */}
          <h1 className="sr-only">{draft.definition.name}</h1>
          <span className="text-caption text-muted-foreground" data-testid="revisions">
            {saved.record ? t('revisions', { definition: revision }) : t('notSavedYet')}
          </span>
          {fromSession ? (
            <KitBadge size="compact" color="gray">
              {t('appliesNextRun')}
            </KitBadge>
          ) : null}
          {/* A disabled Save already says there is nothing to save; only unsaved work and a
              save in progress show a badge. */}
          <span aria-live="polite">
            {saving || (saved.record && dirty) ? (
              <KitBadge size="compact" color="amber">
                {saving ? c('saving') : c('unsaved')}
              </KitBadge>
            ) : (
              saved.record && <span className="sr-only">{c('saved')}</span>
            )}
          </span>
          {message && !conflict ? (
            <p
              role={message.error ? 'alert' : 'status'}
              className={
                message.error
                  ? 'min-w-0 break-words text-caption text-destructive'
                  : message.visible
                    ? 'min-w-0 break-words text-caption'
                    : 'sr-only'
              }
            >
              {messageText}
            </p>
          ) : null}
          {checking || failed ? (
            <div className="flex items-center gap-2 text-caption" role="status">
              {failed ? tr('referencesFailed') : tr('referencesChecking')}
              {failed ? (
                <Button size="compact" variant="secondary" onClick={teams.retry}>
                  {tr('retryReferences')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {teams.issues
            .filter((i) => i.state === 'missing')
            .map((i) => (
              <Button
                key={i.key}
                variant="tertiary"
                size="compact"
                onClick={() => {
                  if (runInPlace) setRunOpen(false);
                  editorNavigation.current?.showNode(i.nodeId);
                }}
              >
                {tr('missingReference', { name: i.name, revision: i.revision })}
              </Button>
            ))}
          <div className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">
            {view === 'graph' && saved.record ? (
              <>
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
              </>
            ) : null}
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
            {inSession ? null : (
              <div className="flex items-center gap-1">
                <Button
                  ref={mockButton}
                  variant="tertiary"
                  size="compact"
                  aria-controls={runId}
                  disabled={emptyNewTeam}
                  aria-description={emptyNewTeam ? saveReason : undefined}
                  onClick={() => startMock.current?.()}
                >
                  <Play />{' '}
                  {c(
                    !saved.record || (mode === 'server' && dirty) ? 'saveAndMockTest' : 'mockTest',
                  )}
                </Button>
                <Menu>
                  <MenuTrigger
                    disabled={emptyNewTeam}
                    aria-description={emptyNewTeam ? saveReason : undefined}
                    render={
                      <Button variant="tertiary" size="icon-compact" aria-label={c('runOptions')} />
                    }
                  >
                    <ChevronDown />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    <MenuItem onClick={() => setRunOpen(true)}>{n('prepareExecution')}</MenuItem>
                  </MenuPopup>
                </Menu>
              </div>
            )}
            <Button
              variant="primary"
              size="compact"
              type="button"
              onClick={() => void save()}
              disabled={saving || !changed}
              aria-description={saveReason}
            >
              {saving ? t('saving') : t('save')}
            </Button>
            <Menu>
              <MenuTrigger
                render={
                  <Button ref={more} variant="ghost" size="icon-compact" aria-label={t('more')} />
                }
              >
                <Ellipsis />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => setImportOpen(true)}>{t('importAgent')}</MenuItem>
                {saved.record ? <MenuItem onClick={exportFile}>{t('export')}</MenuItem> : null}
              </MenuPopup>
            </Menu>
            <MarkdownAgentImport
              editor={editor}
              profiles={profiles}
              projectId={projectId}
              open={importOpen}
              onClose={() => setImportOpen(false)}
              finalFocus={more}
            />
            {leaving ? (
              <UnsavedChangesDialog
                title={c('unsaved')}
                description={sd('unsavedHint')}
                onSave={() => leaving('save')}
                onDiscard={() => leaving('discard')}
                onKeep={() => leaving('keep')}
              />
            ) : null}
          </div>
          {/* The tab's next native stop is its panel content, not an unrelated header action. */}
          <TabsList
            aria-label={t('views')}
            className="-order-1 grid w-full auto-cols-fr grid-flow-col @2xl:inline-flex @2xl:w-auto"
          >
            <TabItem
              value="composition"
              label={t('composition')}
              className="justify-center pointer-coarse:min-h-11"
            />
            <TabItem
              value="graph"
              label={t('graph')}
              className="justify-center pointer-coarse:min-h-11"
            />
          </TabsList>
        </header>
        {conflict ? (
          <div className="border-b border-border px-4 py-2">
            <Banner status="warning" size="compact">
              <BannerTitle>{t('saveConflict')}</BannerTitle>
              <BannerActions>
                <Button
                  variant="primary"
                  size="compact"
                  disabled={saving}
                  onClick={() => void save(true)}
                >
                  {t('saveMine')}
                </Button>
                <Button
                  variant="secondary"
                  size="compact"
                  disabled={saving}
                  onClick={() => void loadLatest()}
                >
                  {t('loadLatest')}
                </Button>
              </BannerActions>
            </Banner>
          </div>
        ) : null}
        <TabPanel
          value={view}
          tabIndex={-1}
          ref={body}
          className={`grid min-h-0 ${runBeside ? 'grid-cols-[minmax(640px,1fr)_minmax(320px,400px)]' : 'grid-cols-1'}`}
        >
          {/* Too narrow for both, the test run takes the editor's place; the editor keeps its state. */}
          <div ref={column} className="grid min-h-0 grid-rows-[minmax(0,1fr)]" hidden={runInPlace}>
            <TeamEditor
              ref={editorNavigation}
              diagnostics={validation?.diagnostics ?? []}
              validationStatus={
                failed ? tr('referencesFailed') : checking ? tr('referencesChecking') : undefined
              }
              editor={editor}
              assistant={assistant}
              assistantStart={assistantStart}
              view={view}
              onViewChange={changeView}
              stacked={stacked}
              profiles={profiles}
              imageProfiles={imageProfiles}
              teams={teams.references}
              agentLibrary={originals.agentLibrary}
              beginSaveAgent={originals.beginSaveAgent}
              resolveTeam={teams.resolve}
              readHarnessAsk={readHarnessAsk}
              onOpenTeam={(corralId) =>
                void navigate({ to: '/corrals/$corralId/edit', params: { corralId } })
              }
              runStats={
                runStats.status === 'ready' && saved.record
                  ? { stats: runStats.stats, definition: saved.record.definition }
                  : null
              }
              onOpenRun={(runId) => void navigate({ to: '/runs/$runId', params: { runId } })}
              loopSettings={(node) => (
                <LoopRecipeSettings
                  key={`${node.id}:${node.reviewRecipe?.revision ?? 0}`}
                  node={node}
                  projectId={projectId}
                />
              )}
              skillLabel={skillLabel}
              roleSkills={(role, nodeId, { revealPolicy }) => (
                <RoleSkills
                  revealPolicy={revealPolicy}
                  key={nodeId}
                  roleId={role.id}
                  harness={role.harness}
                  mcpTools={role.mcpTools}
                  value={role.skills}
                  mode="seat"
                  targetLabel={
                    draft.definition.nodes.find((node) => node.id === nodeId)?.label ?? role.name
                  }
                  projectId={projectId}
                  onApply={(skills) => editor.getState().updateNode(nodeId, { skills })}
                />
              )}
              roleTools={(role, nodeId, { revealPolicy }) => (
                <RoleTools
                  key={nodeId}
                  role={role}
                  projectId={projectId}
                  sessionId={workspaceSessionId}
                  mode="seat"
                  targetLabel={
                    draft.definition.nodes.find((node) => node.id === nodeId)?.label ?? role.name
                  }
                  revealPolicy={revealPolicy}
                  onApply={(mcpTools) => editor.getState().updateNode(nodeId, { mcpTools })}
                />
              )}
              roleSettings={(role, nodeId) => (
                <HarnessRoleSettings
                  key={nodeId}
                  role={role}
                  nodeId={nodeId}
                  projectId={projectId}
                />
              )}
            />
          </div>
          {inSession ? null : (
            <aside
              id={runId}
              aria-label={c('testRun')}
              hidden={!runOpen}
              className={`min-h-0 overflow-auto p-3 ${runBeside ? 'border-l border-border' : ''}`}
            >
              <RunSide
                savedRevision={changed ? null : (saved.record?.definitionRevision ?? null)}
                skillLabel={skillLabel}
                validation={validation}
                onShowProblems={showProblems}
                onOpenConversation={openConversation}
                startDisabled={saving || openingSession}
                projectId={projectId}
                startMock={startMock}
                onOpen={() => setRunOpen(true)}
                onClose={() => {
                  setRunOpen(false);
                  mockButton.current?.focus();
                }}
                onEditBrief={() => {
                  setRunOpen(false);
                  editorNavigation.current?.editBrief();
                }}
                beforeStart={beforeStart}
                liveAvailable={live}
                guide={guide}
                initialStartFrom={startFrom}
              />
            </aside>
          )}
        </TabPanel>
      </Tabs>
    </StudioStoresProvider>
  );
}

function useAgentOriginals(projectId: string) {
  const { agents, repository } = useServices();
  const errors = useTranslations('Library.agents.errors');
  const projectsText = useTranslations('Projects');
  const [refresh, setRefresh] = useState(0);
  const [project, setProject] = useState<ProjectSummary>();
  const [read, setRead] = useState<
    Pick<NonNullable<TeamEditorProps['agentLibrary']>, 'agents' | 'status'>
  >({ agents: [], status: 'loading' });
  useEffect(() => {
    let current = true;
    void repository.listProjects().then(
      (projects) => {
        if (current) setProject(projects.find((item) => item.projectId === projectId));
      },
      () => {
        if (current) setProject(undefined);
      },
    );
    return () => {
      current = false;
    };
  }, [repository, projectId]);
  useEffect(() => {
    let current = true;
    void refresh;
    setRead({ status: 'loading', agents: [] });
    void agents.list(projectId).then(
      (originals) => {
        if (current) setRead({ status: 'ready', agents: originals });
      },
      () => {
        if (current) setRead({ status: 'failed', agents: [] });
      },
    );
    return () => {
      current = false;
    };
  }, [agents, projectId, refresh]);
  const beginSaveAgent: NonNullable<TeamEditorProps['beginSaveAgent']> = () => {
    const operationId = `agent_${crypto.randomUUID()}`;
    return async (role) => {
      const result = await agents.create(projectId, { role, operationId });
      return result.ok ? { ok: true } : { ok: false, message: errors(result.error) };
    };
  };
  return {
    agentLibrary: {
      ...read,
      projectName: project ? projectName(project, projectsText('defaultName')) : projectId,
      retry: () => setRefresh((value) => value + 1),
    },
    beginSaveAgent,
  };
}

function useHarnessAsk(projectId: string) {
  const { harnesses } = useServices();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!harnesses) return;
    const refresh = () => setRevision((value) => value + 1);
    window.addEventListener('corral:harness-changed', refresh);
    return () => window.removeEventListener('corral:harness-changed', refresh);
  }, [harnesses]);
  return useMemo(() => {
    // A changed project default invalidates every cached ask permission.
    void revision;
    if (!harnesses) return undefined;
    return async (role: HarnessPreviewRole) => {
      const { snapshot } =
        role.harness && role.skills === undefined && role.mcpTools === undefined
          ? await harnesses.preview(role.harness, projectId)
          : await harnesses.preview(role, projectId);
      return snapshot?.allowedTools.includes('ask');
    };
  }, [harnesses, projectId, revision]);
}

function RunSide({
  savedRevision,
  validation,
  onShowProblems,
  onOpenConversation,
  startDisabled,
  projectId,
  startMock,
  onOpen,
  onClose,
  beforeStart,
  liveAvailable,
  guide,
  initialStartFrom,
  skillLabel,
  onEditBrief,
}: {
  savedRevision: number | null;
  projectId: string;
  onEditBrief: () => void;
  skillLabel: ReturnType<typeof useSkillLabel>;
  startDisabled: boolean;
  validation: DraftCompilation | null;
  onOpenConversation: () => Promise<void>;
  onShowProblems: () => void;
  startMock: Ref<() => void>;
  onOpen: () => void;
  onClose: () => void;
  beforeStart?: ComponentProps<typeof RunControls>['beforeStart'];
  liveAvailable: boolean;
  guide?: GuideSlot | undefined;
  initialStartFrom: StartFromChoice | null;
}) {
  const t = useTranslations('Editor');
  const n = useTranslations('Navigation');
  const c = useTranslations('TeamEditor');
  const ts = useTranslations('Sessions');
  const navigation = useSettingsNavigation();
  const headingId = useId();
  const { session, editor } = useStudioStores();
  const { mode, repository, transport } = useServices();
  const readTeam = useCallback(
    async (runId: string) => {
      const source = await transport.getRunSource?.(runId);
      return source ? repository.getRevision(source.corralId, source.definitionRevision) : null;
    },
    [repository, transport],
  );
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
    ...(role.skills !== undefined ? { skills: role.skills } : {}),
    ...(role.mcpTools !== undefined ? { mcpTools: role.mcpTools } : {}),
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
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h2
          id={headingId}
          className="text-subtitle"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {c('testRun')}
        </h2>
        <Button
          variant="ghost"
          size="icon-compact"
          aria-label={c('closeRunPanel')}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      {guide?.(session, setChosen)}
      <details
        open={setupOpen}
        onToggle={(event) => setSetupOpen(event.currentTarget.open)}
        className="rounded-lg fill-group p-3"
      >
        <summary
          className="cursor-pointer text-subtitle"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {n('prepareExecution')}
        </summary>
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 grow basis-56">
            <p className="text-caption text-muted-foreground">{t('runBrief')}</p>
            <p className="whitespace-pre-wrap break-words text-body">{definition.input.brief}</p>
          </div>
          <Button variant="tertiary" size="compact" onClick={onEditBrief}>
            {t('editRunBrief')}
          </Button>
        </div>
        {validation?.definition ? (
          <RunSetupSummary definition={validation.definition} savedRevision={savedRevision} />
        ) : null}
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
        startMock={startMock}
        onOpen={onOpen}
        modelConnections={
          <Button
            variant="tertiary"
            size="compact"
            render={<Link {...navigation.link('models')} />}
          >
            {ts('connectModel')}
          </Button>
        }
        validation={validation}
        onOpenConversation={onOpenConversation}
        onShowProblems={onShowProblems}
        startDisabled={startDisabled}
        mode={runMode.mode}
        onModeChange={runMode.select}
        harnessOverrides={harnessOverrides}
        roleOverrides={roleOverrides}
        breakpoints={breakpoints.filter((id) => definition.nodes.some((node) => node.id === id))}
        onStarted={() => {
          setSetupOpen(false);
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
        readTeam={mode === 'server' ? readTeam : undefined}
        session={session}
        skillLabel={skillLabel}
        onSteer={setChosen}
        onOpenArtifact={setViewing}
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
          className="text-caption underline"
        >
          {t('openRun')}
        </Link>
      ) : null}
      <ReinsPanel session={session} target={target} />
    </section>
  );
}
