import type { TextRange, WorkspaceTarget } from '@corral/contracts';
import { ArrowLeft } from '@corral/react/icons';
import { Button, Select } from '@corral/react/ui';
import {
  type DockviewApi,
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewWillDropEvent,
  type DockviewWillShowOverlayLocationEvent,
  type IDockviewPanel,
  type IDockviewPanelHeaderProps,
  type IDockviewPanelProps,
} from 'dockview-react';
import {
  createContext,
  forwardRef,
  type ReactNode,
  useContext,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { DocumentCloseDialog } from '../documents/DocumentCloseDialog.tsx';
import { type CloseChoice, type DocumentStore, documentKey } from '../documents/store.ts';
import { PANE_CATALOG, type SessionPanel } from '../panels/registry.ts';
import {
  addDocumentPanel,
  createPresetLayout,
  DEFAULT_PANELS,
  type DockContextView,
  type DockDocumentDescriptor,
  type DockPanelDescriptor,
  type DockPreset,
  documentTabLabel,
  layoutStorageKey,
  MAX_DOCUMENTS,
  parseLayout,
  serializeLayout,
} from './layout.ts';
import 'dockview-react/dist/styles/dockview.css';
import './docking.css';

export type { DockContextView, DockDocumentDescriptor } from './layout.ts';
export interface DockOpenDocument {
  documentKey: string;
  target: WorkspaceTarget;
  path: string;
}
export interface DockWorkbenchHandle {
  openDocument(input: DockOpenDocument, selection?: TextRange): boolean;
  openContext(view: DockContextView): void;
  /**
   * Hides every pane but the conversation, or shows them again with `view` active. Hiding
   * keeps documents, processes and the saved arrangement (#71).
   */
  setPanesHidden(hidden: boolean, view?: DockContextView): void;
}
export interface DockWorkbenchProps {
  hostId?: string;
  projectId: string;
  sessionId: string;
  selectedPanel?: SessionPanel | null;
  selectionKey?: string;
  renderContext(view: DockContextView): ReactNode;
  renderDocument(
    descriptor: DockDocumentDescriptor,
    panelId: string,
    selection?: TextRange,
  ): ReactNode;
  documentOwner?: DocumentStore;
  controls?: ReactNode;
  onActiveContext?: (view: DockContextView) => void;
  /** Whether only the conversation is on screen now. */
  onPanesHiddenChange?: (hidden: boolean) => void;
}
type PanelParams = { descriptor: DockPanelDescriptor };
const RendererContext = createContext<{
  renderContext: DockWorkbenchProps['renderContext'];
  renderDocument: DockWorkbenchProps['renderDocument'];
  selection: { panelId: string; range: TextRange } | null;
  close: (id: string) => void;
} | null>(null);
const theme = { name: 'corral', className: 'corral-dock-theme', gap: 4 };
const groupLabel = { develop: 'groupDevelop', verify: 'groupVerify', run: 'groupRun' } as const;
const groupNames = ['main1', 'main2', 'aux', 'bottom'] as const;
// At or below this host width one pane shows at a time.
const NARROW = 600;
const descriptorOf = (panel: IDockviewPanel) => (panel.params as PanelParams).descriptor;
const records = (api: DockviewApi) =>
  api.panels.map((panel) => ({ id: panel.id, descriptor: descriptorOf(panel) }));

function DockPanel({ params, api }: IDockviewPanelProps<PanelParams>) {
  const renderer = useContext(RendererContext);
  const t = useTranslations('Docking');
  const descriptor = params.descriptor;
  return (
    <div
      className={`corral-dock-content ${descriptor.kind === 'document' || (descriptor.kind === 'context' && descriptor.view === 'chat') ? 'corral-dock-content-fixed' : ''}`}
      data-dock-panel-id={api.id}
    >
      {descriptor.kind === 'document' ? (
        renderer?.renderDocument(
          descriptor,
          api.id,
          renderer.selection?.panelId === api.id ? renderer.selection.range : undefined,
        )
      ) : descriptor.kind === 'context' ? (
        renderer?.renderContext(descriptor.view)
      ) : (
        <p role="status" className="p-4 text-sm text-muted">
          {t('unknownPanel')} {descriptor.label}
        </p>
      )}
    </div>
  );
}
function DockTab(props: IDockviewPanelHeaderProps<PanelParams>) {
  const renderer = useContext(RendererContext);
  return (
    <DockviewDefaultTab {...props} closeActionOverride={() => renderer?.close(props.api.id)} />
  );
}
const components = { workbench: DockPanel };

export const DockWorkbench = forwardRef<DockWorkbenchHandle, DockWorkbenchProps>(
  function DockWorkbench(props, ref) {
    const t = useTranslations('Docking');
    const current = useRef(props);
    current.current = props;
    const labels = useRef(t);
    labels.current = t;
    const apiRef = useRef<DockviewApi | null>(null);
    const host = useRef<HTMLDivElement>(null);
    const mutating = useRef(false);
    const narrow = useRef(false);
    const panesHidden = useRef(false);
    const lastSelection = useRef({
      sessionId: props.sessionId,
      selectedPanel: props.selectedPanel,
      selectionKey: props.selectionKey,
    });
    const retention = useRef(new Map<string, () => void>());
    const [panels, setPanels] = useState<{ id: string; title: string }[]>([]);
    const [active, setActive] = useState('');
    const [selection, setSelection] = useState<{ panelId: string; range: TextRange } | null>(null);
    const [preset, setPreset] = useState<DockPreset | null>('conversation');
    const [destination, setDestination] = useState<string>('main1');
    const [message, setMessage] = useState<string | null>(null);
    const [closing, setClosing] = useState<{ id: string; path: string } | null>(null);
    const [closeBusy, setCloseBusy] = useState(false);
    const closeInFlight = useRef(false);
    const [closeFailed, setCloseFailed] = useState(false);
    // The Dockview API once ready; subscriptions live in an effect so a remount (StrictMode,
    // a re-attached tree) subscribes again instead of keeping disposed listeners.
    const [dockApi, setDockApi] = useState<DockviewApi | null>(null);
    // Narrow hosts (a phone) show one pane at a time, the conversation first (#94).
    const [compact, setCompact] = useState(false);

    function documentLabel(descriptor: DockDocumentDescriptor) {
      return documentTabLabel(
        descriptor,
        (apiRef.current?.panels ?? []).map(descriptorOf),
        current.current.sessionId,
        (id) => labels.current('otherSession', { id }),
      );
    }
    function title(panel: IDockviewPanel) {
      const descriptor = descriptorOf(panel);
      if (descriptor.kind === 'context') return labels.current(descriptor.view);
      if (descriptor.kind === 'unknown') return descriptor.label || labels.current('unknownPanel');
      const entry =
        current.current.documentOwner?.getState().documents[
          documentKey(descriptor.target, descriptor.path)
        ];
      return `${entry?.dirty || entry?.pendingSave ? '● ' : ''}${documentLabel(descriptor)}`;
    }
    function refresh() {
      const api = apiRef.current;
      if (!api || mutating.current) return;
      const owner = current.current.documentOwner;
      const present = new Set<string>();
      for (const panel of api.panels) {
        const descriptor = descriptorOf(panel);
        const nextTitle = title(panel);
        if (panel.title !== nextTitle) panel.api.setTitle(nextTitle);
        if (descriptor.kind !== 'document' || !owner) continue;
        present.add(panel.id);
        const key = documentKey(descriptor.target, descriptor.path);
        if (!retention.current.has(panel.id) && owner.getState().documents[key])
          retention.current.set(panel.id, owner.retainView(key, descriptor.viewId));
      }
      for (const [id, release] of retention.current)
        if (!present.has(id)) {
          release();
          retention.current.delete(id);
        }
      setPanels(api.panels.map((panel) => ({ id: panel.id, title: title(panel) })));
      setActive(api.activePanel?.id ?? '');
      const activeDescriptor = api.activePanel ? descriptorOf(api.activePanel) : null;
      const onChat = activeDescriptor?.kind === 'context' && activeDescriptor.view === 'chat';
      const hidden = narrow.current ? onChat : onChat && api.hasMaximizedGroup();
      if (hidden !== panesHidden.current) {
        panesHidden.current = hidden;
        current.current.onPanesHiddenChange?.(hidden);
      }
    }
    function saveLayout() {
      const api = apiRef.current;
      const { hostId, projectId } = current.current;
      const key = layoutStorageKey(hostId, projectId);
      if (!api || !key || !hostId || mutating.current) return;
      try {
        localStorage.setItem(key, serializeLayout(api.toJSON(), hostId, projectId));
      } catch {
        setMessage('storageFailed');
      }
    }
    function mainGroups(api: DockviewApi) {
      return api.groups.filter(
        (group) =>
          group.id === 'main1' ||
          group.id === 'main2' ||
          group.panels.some((panel) => descriptorOf(panel).kind === 'document'),
      );
    }
    function findGroup(api: DockviewApi, name: string) {
      return (
        api.groups.find((group) => group.id === name) ??
        (name === 'main1' ? mainGroups(api)[0] : name === 'main2' ? mainGroups(api)[1] : undefined)
      );
    }
    function focus(panel: IDockviewPanel, notify = false) {
      panel.api.setActive();
      if (narrow.current) panel.api.maximize();
      // A pane chosen while the others are hidden is shown, not activated off screen.
      else if (apiRef.current?.hasMaximizedGroup() && !panel.api.isMaximized())
        apiRef.current.exitMaximizedGroup();
      const descriptor = descriptorOf(panel);
      if (notify && descriptor.kind === 'context')
        current.current.onActiveContext?.(descriptor.view);
      refresh();
    }
    function openContext(view: DockContextView, notify = false) {
      const api = apiRef.current;
      if (!api) return;
      let panel = api.panels.find((item) => {
        const descriptor = descriptorOf(item);
        return descriptor.kind === 'context' && descriptor.view === view;
      });
      if (!panel) {
        const group =
          findGroup(
            api,
            view === 'chat'
              ? 'main1'
              : ['terminal', 'tools', 'checks', 'problems'].includes(view)
                ? 'bottom'
                : 'aux',
          ) ?? api.activeGroup;
        panel = api.addPanel({
          id: `context:${view}`,
          component: 'workbench',
          params: { descriptor: { kind: 'context', view } },
          title: labels.current(view),
          renderer: 'always',
          ...(group ? { position: { referenceGroup: group, direction: 'within' } } : {}),
        });
      }
      focus(panel, notify);
      saveLayout();
    }
    function openDocument(input: DockOpenDocument, range?: TextRange) {
      const api = apiRef.current;
      const { hostId, projectId, documentOwner } = current.current;
      if (
        !api ||
        (hostId && input.target.hostId !== hostId) ||
        input.target.projectId !== projectId ||
        input.documentKey !== documentKey(input.target, input.path) ||
        !documentOwner?.getState().documents[input.documentKey]
      ) {
        setMessage('invalidTarget');
        return false;
      }
      const existing = api.panels.find((panel) => {
        const d = descriptorOf(panel);
        return d.kind === 'document' && documentKey(d.target, d.path) === input.documentKey;
      });
      if (existing) {
        setSelection(range ? { panelId: existing.id, range: { ...range } } : null);
        focus(existing);
        return true;
      }
      const id = `document:${crypto.randomUUID()}`;
      const descriptor: DockDocumentDescriptor = {
        kind: 'document',
        target: input.target,
        path: input.path,
        viewId: id,
      };
      if (!addDocumentPanel(records(api), { id, descriptor })) {
        setMessage('tabLimit');
        return false;
      }
      let group =
        mainGroups(api).find((item) => item.id === api.activeGroup?.id) ?? mainGroups(api)[0];
      if (!group) {
        if (api.groups.length >= 4) {
          setMessage('splitLimit');
          return false;
        }
        group = api.addGroup({
          id: 'main1',
          direction: 'left',
          ...(api.activeGroup ? { referenceGroup: api.activeGroup } : {}),
        });
      }
      const panel = api.addPanel({
        id,
        component: 'workbench',
        params: { descriptor },
        title: input.path,
        renderer: 'always',
        ...(group ? { position: { referenceGroup: group, direction: 'within' } } : {}),
      });
      setSelection(range ? { panelId: id, range: { ...range } } : null);
      setMessage(null);
      focus(panel);
      saveLayout();
      return true;
    }
    function setPanesHidden(hidden: boolean, view: DockContextView = 'chat') {
      const api = apiRef.current;
      if (!api) return;
      if (hidden) {
        openContext('chat', true);
        if (!narrow.current) api.getPanel('context:chat')?.api.maximize();
      } else {
        if (!narrow.current) api.exitMaximizedGroup();
        openContext(view, true);
      }
      refresh();
    }
    useImperativeHandle(ref, () => ({
      openDocument,
      openContext: (view) => openContext(view),
      setPanesHidden,
    }));

    async function closePanel(id: string, choice?: CloseChoice) {
      const api = apiRef.current;
      const panel = api?.getPanel(id);
      if (!api || !panel || closeInFlight.current) return;
      const descriptor = descriptorOf(panel);
      closeInFlight.current = true;
      setCloseBusy(true);
      setCloseFailed(false);
      try {
        const result =
          descriptor.kind === 'document' && current.current.documentOwner
            ? await current.current.documentOwner.closeView(
                documentKey(descriptor.target, descriptor.path),
                descriptor.viewId,
                choice,
              )
            : 'closed';
        if (result === 'closed') {
          api.removePanel(panel);
          setClosing(null);
          refresh();
          saveLayout();
        } else if (result === 'cancelled') setClosing(null);
        else if (descriptor.kind === 'document') {
          setClosing({ id, path: descriptor.path });
          setCloseFailed(result === 'failed');
        }
      } catch {
        if (descriptor.kind === 'document') setClosing({ id, path: descriptor.path });
        setCloseFailed(true);
      } finally {
        closeInFlight.current = false;
        setCloseBusy(false);
      }
    }
    function applyPreset(value: DockPreset) {
      const api = apiRef.current;
      if (!api) return;
      mutating.current = true;
      try {
        api.fromJSON(createPresetLayout(value, records(api)), { reuseExistingPanels: true });
        setPreset(value);
      } finally {
        mutating.current = false;
      }
      if (narrow.current && api.activePanel) api.activePanel.api.maximize();
      refresh();
      saveLayout();
    }
    function move() {
      const api = apiRef.current;
      const panel = api?.activePanel;
      if (!api || !panel) return;
      const doc = descriptorOf(panel).kind === 'document';
      if (doc && !['main1', 'main2'].includes(destination)) {
        setMessage('invalidTarget');
        return;
      }
      let group = findGroup(api, destination);
      if (!group) {
        if (api.groups.length >= 4 || (doc && mainGroups(api).length >= 2)) {
          setMessage('splitLimit');
          return;
        }
        const reference = mainGroups(api)[0] ?? api.activeGroup;
        group = api.addGroup({
          id: destination,
          ...(reference
            ? { referenceGroup: reference, direction: destination === 'bottom' ? 'below' : 'right' }
            : { direction: 'right' }),
        });
      }
      panel.api.moveTo({ group });
      setPreset(null);
      focus(panel);
      saveLayout();
    }
    function split() {
      const api = apiRef.current;
      const panel = api?.activePanel;
      if (!api || !panel) return;
      const descriptor = descriptorOf(panel);
      if (descriptor.kind !== 'document') return;
      if (
        api.panels.filter((item) => descriptorOf(item).kind === 'document').length >= MAX_DOCUMENTS
      ) {
        setMessage('tabLimit');
        return;
      }
      const id = `document:${crypto.randomUUID()}`;
      let group = mainGroups(api).find((item) => item.id !== panel.group.id);
      if (!group) {
        if (mainGroups(api).length >= 2 || api.groups.length >= 4) {
          setMessage('splitLimit');
          return;
        }
        group = api.addGroup({ id: 'main2', referenceGroup: panel.group, direction: 'right' });
      }
      const created = api.addPanel({
        id,
        component: 'workbench',
        params: { descriptor: { ...descriptor, viewId: id } },
        title: panel.title,
        renderer: 'always',
        position: { referenceGroup: group, direction: 'within' },
      });
      setPreset(null);
      focus(created);
      saveLayout();
    }
    function resize(axis: 'width' | 'height', amount: number) {
      const group = apiRef.current?.activeGroup;
      if (!group || narrow.current) return;
      group.api.setSize({
        [axis]: Math.max(120, (axis === 'width' ? group.width : group.height) + amount),
      });
      setPreset(null);
      saveLayout();
    }
    /** Why a drop is refused, or null when it is allowed. */
    function dropRefusal(
      event: DockviewWillDropEvent | DockviewWillShowOverlayLocationEvent,
    ):
      | 'dropNarrow'
      | 'dropDocumentMain'
      | 'dropDocumentsOnly'
      | 'dropAreaLimit'
      | 'refused'
      | null {
      const api = apiRef.current;
      const data = event.getData();
      if (!api || !data) return 'refused';
      if (narrow.current) return 'dropNarrow';
      const source = api.groups.find((group) => group.id === data.groupId);
      const moving = data.panelId
        ? [api.getPanel(data.panelId)].filter((panel): panel is IDockviewPanel => Boolean(panel))
        : (source?.panels ?? []);
      const hasDocument = moving.some((panel) => descriptorOf(panel).kind === 'document');
      const destinationGroup = event.group;
      const isMain =
        destinationGroup && mainGroups(api).some((group) => group.id === destinationGroup.id);
      if (event.position === 'center') return hasDocument && !isMain ? 'dropDocumentMain' : null;
      const removesSource = Boolean(source && moving.length === source.panels.length);
      const addedGroups = removesSource ? 0 : 1;
      if (!hasDocument) return 'dropDocumentsOnly';
      if (!isMain) return 'dropDocumentMain';
      if (api.groups.length + addedGroups > 4 || mainGroups(api).length + addedGroups > 2)
        return 'dropAreaLimit';
      return null;
    }
    function allowDrop(event: DockviewWillDropEvent | DockviewWillShowOverlayLocationEvent) {
      const refusal = dropRefusal(event);
      // While dragging, a refused spot says why (#90); an allowed one clears that reason.
      setMessage((current) =>
        refusal && refusal !== 'refused' ? refusal : current?.startsWith('drop') ? null : current,
      );
      if (refusal) event.preventDefault();
    }
    function onReady({ api }: DockviewReadyEvent) {
      apiRef.current = api;
      mutating.current = true;
      const { hostId, projectId } = current.current;
      const key = layoutStorageKey(hostId, projectId);
      let loaded: ReturnType<typeof parseLayout> | null = null;
      try {
        if (key && hostId) loaded = parseLayout(localStorage.getItem(key), hostId, projectId);
      } catch {
        setMessage('storageFailed');
      }
      try {
        api.fromJSON(
          loaded?.layout ??
            createPresetLayout(
              'conversation',
              loaded?.panels.length ? loaded.panels : DEFAULT_PANELS,
            ),
          { reuseExistingPanels: true },
        );
      } catch {
        api.fromJSON(
          createPresetLayout(
            'conversation',
            loaded?.panels.length ? loaded.panels : DEFAULT_PANELS,
          ),
          { reuseExistingPanels: true },
        );
        setMessage('layoutRecovered');
      }
      if (loaded?.layout) setPreset(null);
      if (loaded?.recovered) setMessage('layoutRecovered');
      mutating.current = false;
      refresh();
      const width = host.current?.getBoundingClientRect().width ?? 0;
      narrow.current = width > 0 && width <= NARROW;
      setCompact(narrow.current);
      // On a phone the conversation comes first, even when a side pane was remembered.
      if (narrow.current) openContext('chat', current.current.selectedPanel != null);
      else if (current.current.selectedPanel !== undefined || !loaded?.layout)
        openContext(current.current.selectedPanel ?? 'chat');
      setDockApi(api);
    }
    function measure() {
      const api = apiRef.current;
      const width = host.current?.getBoundingClientRect().width ?? 0;
      const next = width > 0 && width <= NARROW;
      if (!api || next === narrow.current) return;
      narrow.current = next;
      setCompact(next);
      if (next && api.activePanel) api.activePanel.api.maximize();
      else if (!next) api.exitMaximizedGroup();
    }
    function onActivePanel(event: { panel?: IDockviewPanel; origin?: string }) {
      if (mutating.current) return;
      refresh();
      if (event.panel && narrow.current && !event.panel.api.isMaximized())
        event.panel.api.maximize();
      else if (
        event.panel &&
        !narrow.current &&
        apiRef.current?.hasMaximizedGroup() &&
        !event.panel.api.isMaximized()
      )
        apiRef.current.exitMaximizedGroup();
      if (event.origin === 'user' && event.panel) {
        const descriptor = descriptorOf(event.panel);
        if (descriptor.kind === 'context') current.current.onActiveContext?.(descriptor.view);
      }
    }
    const handlers = useRef({ refresh, saveLayout, allowDrop, measure, onActivePanel });
    handlers.current = { refresh, saveLayout, allowDrop, measure, onActivePanel };
    useEffect(() => {
      if (!dockApi) return;
      apiRef.current = dockApi;
      const on = handlers.current;
      const disposables = [
        dockApi.onDidLayoutChange(() => {
          handlers.current.refresh();
          handlers.current.saveLayout();
        }),
        dockApi.onDidActivePanelChange((event) => handlers.current.onActivePanel(event)),
        dockApi.onDidMaximizedGroupChange(() => handlers.current.refresh()),
        dockApi.onDidMovePanel(() => {
          if (!mutating.current) setPreset(null);
        }),
        dockApi.onWillShowOverlay((event) => handlers.current.allowDrop(event)),
        dockApi.onWillDrop((event) => handlers.current.allowDrop(event)),
      ];
      const observer = new ResizeObserver(() => handlers.current.measure());
      if (host.current) observer.observe(host.current);
      on.measure();
      on.refresh();
      return () => {
        for (const item of disposables) item.dispose();
        observer.disconnect();
        // refresh() retains the views again if this tree is mounted again.
        for (const release of retention.current.values()) release();
        retention.current.clear();
      };
    }, [dockApi]);
    const actions = useRef({ openContext, refresh });
    actions.current = { openContext, refresh };
    useEffect(() => {
      void t;
      void props.sessionId;
      actions.current.refresh();
    }, [t, props.sessionId]);
    useEffect(() => {
      const previous = lastSelection.current;
      lastSelection.current = {
        sessionId: props.sessionId,
        selectedPanel: props.selectedPanel,
        selectionKey: props.selectionKey,
      };
      if (
        previous.sessionId === props.sessionId &&
        previous.selectedPanel === props.selectedPanel &&
        previous.selectionKey === props.selectionKey
      )
        return;
      if (props.selectedPanel !== undefined)
        actions.current.openContext(props.selectedPanel ?? 'chat');
    }, [props.selectedPanel, props.selectionKey, props.sessionId]);
    useEffect(
      () => props.documentOwner?.subscribe(() => actions.current.refresh()),
      [props.documentOwner],
    );
    const selected = apiRef.current?.getPanel(active);
    const activeDescriptor = selected ? descriptorOf(selected) : null;
    const activeView = activeDescriptor?.kind === 'context' ? activeDescriptor.view : null;
    // Opening a pane lists every pane once, under what it is for (#70 IA-04).
    const paneOptions = PANE_CATALOG.map((entry) => ({
      value: `context:${entry.view}`,
      label: t(entry.view),
      group: t(groupLabel[entry.group]),
    }));
    return (
      <RendererContext.Provider
        value={{
          renderContext: props.renderContext,
          renderDocument: props.renderDocument,
          selection,
          close: (id) => void closePanel(id),
        }}
      >
        <section
          ref={host}
          aria-label={t('title')}
          className="corral-dock-workbench"
          data-testid="dock-workbench"
        >
          <div className="corral-dock-toolbar" data-testid="dock-toolbar">
            {compact ? (
              <>
                {activeView !== 'chat' ? (
                  <Button size="sm" variant="ghost" onClick={() => openContext('chat', true)}>
                    <ArrowLeft />
                    {t('backToChat')}
                  </Button>
                ) : null}
                <Select
                  label={t('panes')}
                  placeholder={t('panes')}
                  size="sm"
                  value={activeView === 'chat' ? '' : active}
                  onValueChange={(id) => {
                    const panel = apiRef.current?.getPanel(id);
                    if (panel) focus(panel, true);
                    else if (id.startsWith('context:'))
                      openContext(id.slice('context:'.length) as DockContextView, true);
                  }}
                  options={[
                    ...paneOptions,
                    ...panels
                      .filter((panel) => panel.id.startsWith('document:'))
                      .map((panel) => ({ value: panel.id, label: panel.title })),
                  ]}
                />
              </>
            ) : (
              <>
                <div className="corral-dock-select">
                  <span>{t('preset')}</span>
                  <Select
                    label={t('preset')}
                    placeholder={t('savedLayout')}
                    size="sm"
                    value={preset}
                    onValueChange={(value) => applyPreset(value as DockPreset)}
                    options={(['conversation', 'implementation', 'review'] as const).map(
                      (value) => ({
                        value,
                        label: t(value),
                      }),
                    )}
                  />
                </div>
                <Select
                  label={t('openPane')}
                  placeholder={t('openPane')}
                  size="sm"
                  value=""
                  onValueChange={(value) =>
                    openContext(value.slice('context:'.length) as DockContextView, true)
                  }
                  options={[{ value: 'context:chat', label: t('chat') }, ...paneOptions]}
                />
                <details className="corral-dock-actions">
                  <summary>{t('layoutControls')}</summary>
                  <p className="px-1 pb-1 text-xs text-muted">{t('savedWhere')}</p>
                  <div className="flex flex-wrap items-center gap-1">
                    <div className="corral-dock-select">
                      <span>{t('activePane')}</span>
                      <Select
                        label={t('activePane')}
                        size="sm"
                        value={active}
                        onValueChange={(id) => {
                          const panel = apiRef.current?.getPanel(id);
                          if (panel) focus(panel, true);
                        }}
                        options={panels.map((panel) => ({ value: panel.id, label: panel.title }))}
                      />
                    </div>

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => apiRef.current?.activatePrevious({ includePanel: true })}
                    >
                      {t('previousPane')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => apiRef.current?.activateNext({ includePanel: true })}
                    >
                      {t('nextPane')}
                    </Button>
                    <Select
                      label={t('moveTo')}
                      size="sm"
                      value={destination}
                      onValueChange={setDestination}
                      options={groupNames.map((value) => ({ value, label: t(value) }))}
                    />
                    <Button size="sm" variant="ghost" disabled={!selected} onClick={move}>
                      {t('move')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!selected || descriptorOf(selected).kind !== 'document'}
                      onClick={split}
                    >
                      {t('split')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!selected}
                      aria-label={t('close')}
                      onClick={() => selected && void closePanel(selected.id)}
                    >
                      {t('close')}
                    </Button>
                    <div className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => resize('width', -80)}>
                        {t('narrower')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => resize('width', 80)}>
                        {t('wider')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => resize('height', -60)}>
                        {t('shorter')}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => resize('height', 60)}>
                        {t('taller')}
                      </Button>
                    </div>
                  </div>
                </details>
              </>
            )}
          </div>
          {props.controls ? <div className="corral-dock-controls">{props.controls}</div> : null}
          {message ? (
            <p role="status" className="px-3 py-1 text-xs text-muted">
              {t(message)}
            </p>
          ) : null}
          <div className="corral-dock-area">
            <DockviewReact
              components={components}
              defaultTabComponent={DockTab}
              theme={theme}
              onReady={onReady}
              disableFloatingGroups
              getTabContextMenuItems={() => []}
            />
          </div>
        </section>
        <DocumentCloseDialog
          path={closing?.path ?? null}
          busy={closeBusy}
          failed={closeFailed}
          onChoose={(choice) => closing && void closePanel(closing.id, choice)}
          onDismiss={() => setClosing(null)}
        />
      </RendererContext.Provider>
    );
  },
);
