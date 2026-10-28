import type { TextRange, WorkspaceTarget } from '@corral/contracts';
import {
  Button,
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
  Select,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
} from '@corral/react/design-kit';
import { Ellipsis, Plus, X } from '@corral/react/icons';
import {
  type DockviewApi,
  DockviewDefaultTab,
  DockviewReact,
  type DockviewReadyEvent,
  type DockviewWillDropEvent,
  type DockviewWillShowOverlayLocationEvent,
  type IDockviewHeaderActionsProps,
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
import { validateSessionSearch } from '../panels/routes.ts';
import {
  addDocumentPanel,
  addGraphPanel,
  createPresetLayout,
  type DockContextView,
  type DockDocumentDescriptor,
  type DockGraphDescriptor,
  type DockPanelDescriptor,
  type DockPreset,
  documentTabLabel,
  INITIAL_PANELS,
  isEditorPanel,
  layoutStorageKey,
  MAX_DOCUMENTS,
  parseLayout,
  presetPanels,
  serializeLayout,
} from './layout.ts';
import 'dockview-react/dist/styles/dockview.css';
import './docking.css';

export type { DockContextView, DockDocumentDescriptor, DockGraphDescriptor } from './layout.ts';
export interface DockOpenDocument {
  documentKey: string;
  target: WorkspaceTarget;
  path: string;
}
export interface DockWorkbenchHandle {
  openDocument(input: DockOpenDocument, selection?: TextRange): boolean;
  openContext(view: DockContextView): void;
  /** Opens this project's saved team graph as a tab, or shows the one already open. */
  openGraph(corralId: string): boolean;
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
  fileWorkAvailable?: boolean;
  renderContext(view: DockContextView, requestedView?: DockContextView): ReactNode;
  renderDocument(
    descriptor: DockDocumentDescriptor,
    panelId: string,
    selection?: TextRange,
  ): ReactNode;
  documentOwner?: DocumentStore;
  /** A saved team's graph editor; without it, team tabs show as unavailable. */
  renderGraph?(descriptor: DockGraphDescriptor, panelId: string): ReactNode;
  /** The tab title of a team, with its unsaved mark. */
  graphTitle?(corralId: string): string;
  /** Called with a listener that refreshes graph tab titles; returns the unsubscribe. */
  subscribeGraphs?(listener: () => void): () => void;
  controls?: ReactNode;
  terminalStatus?: ReactNode;
  onActiveContext?: (view: DockContextView) => void;
  /** Whether only the conversation is on screen now. */
  onPanesHiddenChange?: (hidden: boolean) => void;
}
type PanelParams = { descriptor: DockPanelDescriptor };
type PrimaryView = 'chat' | 'files' | 'changes' | 'run';
function primaryViewFor(view: DockContextView): PrimaryView {
  if (view === 'chat') return 'chat';
  if (view === 'run' || view === 'artifacts') return 'run';
  if (view === 'changes' || view === 'git' || view === 'checks' || view === 'problems')
    return 'changes';
  return 'files';
}
const groupNames = ['main1', 'main2', 'aux', 'bottom'] as const;
const presets = ['conversation', 'implementation', 'review'] as const;
type GroupName = (typeof groupNames)[number];
/** What a group header's pane menus can do; each acts on that group's active pane. */
interface PaneActions {
  compact: boolean;
  preset: DockPreset | null;
  openContext(view: DockContextView): void;
  applyPreset(preset: DockPreset): void;
  move(panelId: string, destination: GroupName): void;
  split(panelId: string): void;
  resize(groupId: string, axis: 'width' | 'height', amount: number): void;
  step(direction: 'previous' | 'next'): void;
}
const RendererContext = createContext<{
  renderContext: DockWorkbenchProps['renderContext'];
  renderDocument: DockWorkbenchProps['renderDocument'];
  renderGraph: DockWorkbenchProps['renderGraph'];
  selection: { panelId: string; range: TextRange } | null;
  terminalStatus?: ReactNode;
  close: (id: string) => void;
  actions: PaneActions;
} | null>(null);
const theme = { name: 'corral', className: 'corral-dock-theme', gap: 4 };
const groupLabel = { develop: 'groupDevelop', verify: 'groupVerify', run: 'groupRun' } as const;
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
      // A team graph stacks its palette, canvas and inspector in a narrow tab, so it scrolls.
      className={`corral-dock-content ${descriptor.kind === 'document' ? 'corral-dock-content-fixed' : ''}`}
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
      ) : descriptor.kind === 'graph' && renderer?.renderGraph ? (
        <GraphView api={api}>{renderer.renderGraph(descriptor, api.id)}</GraphView>
      ) : (
        <p role="status" className="p-4 text-sm text-muted-foreground">
          {t('unknownPanel')} {descriptor.kind === 'unknown' ? descriptor.label : ''}
        </p>
      )}
    </div>
  );
}
/**
 * Dockview hides a tab behind another with `visibility: hidden`, which canvas nodes override with
 * their own inline `visibility: visible`; a hidden team tab is taken out of rendering instead.
 */
function GraphView({ api, children }: { api: IDockviewPanelProps['api']; children: ReactNode }) {
  const [visible, setVisible] = useState(api.isVisible);
  useEffect(() => {
    setVisible(api.isVisible);
    const listener = api.onDidVisibilityChange((event) => setVisible(event.isVisible));
    return () => listener.dispose();
  }, [api]);
  return (
    <div data-graph-view hidden={!visible} className="h-full">
      {children}
    </div>
  );
}
function DockTab(props: IDockviewPanelHeaderProps<PanelParams>) {
  const renderer = useContext(RendererContext);
  const tab = (
    <DockviewDefaultTab
      {...props}
      hideClose
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        renderer?.close(props.api.id);
      }}
    />
  );
  return props.params.descriptor.kind === 'context' &&
    props.params.descriptor.view === 'terminal' ? (
    <div className="flex h-full min-w-0 items-center gap-1">
      {tab}
      {renderer?.terminalStatus}
    </div>
  ) : (
    tab
  );
}
/**
 * Each group's header carries the pane controls (#90 follow-up): open a pane in its own area,
 * arrange the active pane, and close it. Narrow screens use the one pane switcher instead.
 */
function DockHeaderActions({
  activePanel,
  group,
}: Pick<IDockviewHeaderActionsProps, 'activePanel' | 'group'>) {
  const renderer = useContext(RendererContext);
  const t = useTranslations('Docking');
  if (!renderer || !activePanel) return null;
  const { actions } = renderer;
  const descriptor = descriptorOf(activePanel);
  const editor = isEditorPanel(descriptor);
  const close = (
    <Button
      variant="ghost"
      size="icon-compact"
      aria-label={`${t('close')}: ${activePanel.title}`}
      onClick={() => renderer.close(activePanel.id)}
    >
      <X />
    </Button>
  );
  if (actions.compact) return close;
  const paneGroups = (['develop', 'verify', 'run'] as const).map((name) =>
    PANE_CATALOG.filter((entry) => entry.group === name),
  );
  return (
    <div className="corral-dock-header-actions">
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon-compact" aria-label={t('openPane')} />}
        >
          <Plus />
        </MenuTrigger>
        <MenuPopup align="end" className="min-w-48">
          {/* Every pane opens in its own area, as from the palette, `/` or the URL. */}
          <MenuItem onClick={() => actions.openContext('chat')}>{t('chat')}</MenuItem>
          {paneGroups.map((entries) => (
            <MenuGroup key={entries[0]?.group}>
              <MenuSeparator />
              {entries.map((entry) => (
                <MenuItem key={entry.view} onClick={() => actions.openContext(entry.view)}>
                  {t(entry.view)}
                </MenuItem>
              ))}
            </MenuGroup>
          ))}
        </MenuPopup>
      </Menu>
      <Menu>
        <MenuTrigger
          render={<Button variant="ghost" size="icon-compact" aria-label={t('paneActions')} />}
        >
          <Ellipsis />
        </MenuTrigger>
        <MenuPopup align="end" className="w-64">
          <MenuSub>
            <MenuSubTrigger>
              {t('preset')}
              <span className="ml-auto truncate pl-3 text-xs text-muted-foreground">
                {actions.preset ? t(actions.preset) : t('savedLayout')}
              </span>
            </MenuSubTrigger>
            <MenuSubPopup>
              <MenuRadioGroup
                value={actions.preset ?? ''}
                onValueChange={(value) => actions.applyPreset(value as DockPreset)}
              >
                {presets.map((value) => (
                  <MenuRadioItem key={value} value={value} closeOnClick>
                    {t(value)}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>{t('moveTo')}</MenuSubTrigger>
            <MenuSubPopup>
              {groupNames.map((name) => (
                <MenuItem
                  key={name}
                  disabled={editor && name !== 'main1' && name !== 'main2'}
                  onClick={() => actions.move(activePanel.id, name)}
                >
                  {t(name)}
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
          <MenuSub>
            <MenuSubTrigger>{t('size')}</MenuSubTrigger>
            <MenuSubPopup>
              <MenuItem closeOnClick={false} onClick={() => actions.resize(group.id, 'width', -80)}>
                {t('narrower')}
              </MenuItem>
              <MenuItem closeOnClick={false} onClick={() => actions.resize(group.id, 'width', 80)}>
                {t('wider')}
              </MenuItem>
              <MenuItem
                closeOnClick={false}
                onClick={() => actions.resize(group.id, 'height', -60)}
              >
                {t('shorter')}
              </MenuItem>
              <MenuItem closeOnClick={false} onClick={() => actions.resize(group.id, 'height', 60)}>
                {t('taller')}
              </MenuItem>
            </MenuSubPopup>
          </MenuSub>
          {descriptor.kind === 'document' ? (
            <MenuItem onClick={() => actions.split(activePanel.id)}>{t('split')}</MenuItem>
          ) : null}
          <MenuSeparator />
          <MenuItem onClick={() => actions.step('previous')}>{t('previousPane')}</MenuItem>
          <MenuItem onClick={() => actions.step('next')}>{t('nextPane')}</MenuItem>
          <MenuSeparator />
          <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('savedWhere')}</p>
        </MenuPopup>
      </Menu>
      {close}
    </div>
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
    const fileWorkOpened = useRef(false);
    const lastSelection = useRef({
      sessionId: props.sessionId,
      selectedPanel: props.selectedPanel,
      selectionKey: props.selectionKey,
    });
    const retention = useRef(new Map<string, () => void>());
    const [panels, setPanels] = useState<{ id: string; title: string }[]>([]);
    const [active, setActive] = useState('');
    const [sessionView, setSessionView] = useState<PrimaryView>('chat');
    const [hasFileWork, setHasFileWork] = useState(false);
    const [historyVisited, setHistoryVisited] = useState(false);
    const [changesVisited, setChangesVisited] = useState(false);
    const [historyView, setHistoryView] = useState<DockContextView>('run');
    const [changesView, setChangesView] = useState<DockContextView>('changes');
    const [selection, setSelection] = useState<{ panelId: string; range: TextRange } | null>(null);
    const [preset, setPreset] = useState<DockPreset | null>('conversation');
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
      if (descriptor.kind === 'graph')
        return current.current.graphTitle?.(descriptor.corralId) ?? labels.current('team');
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
      for (const group of api.groups)
        if (group.model.header.hidden) group.model.header.hidden = false;
      setPanels(api.panels.map((panel) => ({ id: panel.id, title: title(panel) })));
      setActive(api.activePanel?.id ?? '');
    }
    function saveLayout() {
      const api = apiRef.current;
      const { hostId, projectId } = current.current;
      const key = layoutStorageKey(hostId, projectId);
      if (!api || !key || !hostId || mutating.current || !fileWorkOpened.current) return;
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
          group.panels.some((panel) => isEditorPanel(descriptorOf(panel))),
      );
    }
    /** The central group to add an editor tab to, created when every one was closed. */
    function editorGroup(api: DockviewApi) {
      const group =
        mainGroups(api).find((item) => item.id === api.activeGroup?.id) ?? mainGroups(api)[0];
      if (group) return group;
      if (api.groups.length >= 4) {
        setMessage('splitLimit');
        return null;
      }
      return api.addGroup({
        id: 'main1',
        direction: 'left',
        ...(api.activeGroup ? { referenceGroup: api.activeGroup } : {}),
      });
    }
    function findGroup(api: DockviewApi, name: string) {
      return (
        api.groups.find((group) => group.id === name) ??
        (name === 'main1' ? mainGroups(api)[0] : name === 'main2' ? mainGroups(api)[1] : undefined)
      );
    }
    function focus(panel: IDockviewPanel, notify = false) {
      fileWorkOpened.current = true;
      setHasFileWork(true);
      setSessionView('files');
      panel.api.setActive();
      if (narrow.current) panel.api.maximize();
      // A pane chosen while the others are hidden is shown, not activated off screen.
      else if (apiRef.current?.hasMaximizedGroup() && !panel.api.isMaximized())
        apiRef.current.exitMaximizedGroup();
      const descriptor = descriptorOf(panel);
      if (notify || isEditorPanel(descriptor))
        current.current.onActiveContext?.(
          descriptor.kind === 'context' ? descriptor.view : 'files',
        );
      refresh();
    }
    function openContext(view: DockContextView, notify = false) {
      const api = apiRef.current;
      if (!api) return;
      const primary = primaryViewFor(view);
      if (primary === 'chat') {
        setSessionView('chat');
        if (notify) current.current.onActiveContext?.('chat');
        return;
      }
      if (primary === 'run') {
        setHistoryVisited(true);
        setHistoryView(view);
        setSessionView('run');
        if (notify) current.current.onActiveContext?.(view);
        return;
      }
      fileWorkOpened.current = true;
      setHasFileWork(true);
      if (primary === 'changes') {
        setChangesVisited(true);
        setChangesView(view);
        setSessionView('changes');
        if (notify) current.current.onActiveContext?.(view);
        saveLayout();
        return;
      }
      // The Files route acknowledges an opened document without replacing it with its tree.
      if (view === 'files' && !notify && api.activePanel) {
        focus(api.activePanel);
        saveLayout();
        return;
      }
      let panel = api.panels.find((item) => {
        const descriptor = descriptorOf(item);
        return descriptor.kind === 'context' && descriptor.view === view;
      });
      if (!panel) {
        const home = ['terminal', 'tools'].includes(view) ? 'bottom' : 'aux';
        let group = findGroup(api, home);
        // A pane whose area is not open gets that area back instead of replacing the tab in
        // front, which is usually the conversation (at most four areas).
        if (!group && api.groups.length < 4)
          group = api.addGroup({ id: home, direction: home === 'bottom' ? 'below' : 'right' });
        group ??= api.activeGroup;
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
      const group = editorGroup(api);
      if (!group) return false;
      const panel = api.addPanel({
        id,
        component: 'workbench',
        params: { descriptor },
        title: input.path,
        renderer: 'always',
        position: { referenceGroup: group, direction: 'within' },
      });
      setSelection(range ? { panelId: id, range: { ...range } } : null);
      setMessage(null);
      focus(panel);
      saveLayout();
      return true;
    }
    function openGraph(corralId: string) {
      const api = apiRef.current;
      const { projectId, renderGraph } = current.current;
      if (!api || !renderGraph) return false;
      const existing = api.panels.find((panel) => {
        const descriptor = descriptorOf(panel);
        return descriptor.kind === 'graph' && descriptor.corralId === corralId;
      });
      if (existing) {
        focus(existing);
        return true;
      }
      const id = `graph:${crypto.randomUUID()}`;
      const descriptor: DockGraphDescriptor = { kind: 'graph', projectId, corralId, viewId: id };
      if (!addGraphPanel(records(api), { id, descriptor })) {
        setMessage('invalidTarget');
        return false;
      }
      const group = editorGroup(api);
      if (!group) return false;
      const panel = api.addPanel({
        id,
        component: 'workbench',
        params: { descriptor },
        title: current.current.graphTitle?.(corralId) ?? labels.current('team'),
        renderer: 'always',
        position: { referenceGroup: group, direction: 'within' },
      });
      setMessage(null);
      focus(panel);
      saveLayout();
      return true;
    }
    function setPanesHidden(hidden: boolean, view: DockContextView = 'chat') {
      openContext(hidden ? 'chat' : view, true);
    }
    useImperativeHandle(ref, () => ({
      openDocument,
      openContext: (view) => openContext(view),
      openGraph,
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
      fileWorkOpened.current = true;
      setHasFileWork(true);
      mutating.current = true;
      try {
        // Presets arrange file work; checks and review stay in the Changes screen.
        api.fromJSON(
          createPresetLayout(
            value,
            presetPanels(value, records(api)).filter(
              ({ descriptor }) =>
                descriptor.kind !== 'context' || primaryViewFor(descriptor.view) === 'files',
            ),
          ),
          {
            reuseExistingPanels: true,
          },
        );
        setPreset(value);
      } finally {
        mutating.current = false;
      }
      if (narrow.current && api.activePanel) api.activePanel.api.maximize();
      refresh();
      openContext(value === 'review' ? 'changes' : 'files', true);
      saveLayout();
    }
    function move(panelId: string, destination: GroupName) {
      const api = apiRef.current;
      const panel = api?.getPanel(panelId);
      if (!api || !panel) return;
      const doc = isEditorPanel(descriptorOf(panel));
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
    function split(panelId: string) {
      const api = apiRef.current;
      const panel = api?.getPanel(panelId);
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
    function resize(groupId: string, axis: 'width' | 'height', amount: number) {
      const group = apiRef.current?.groups.find((item) => item.id === groupId);
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
      const hasDocument = moving.some((panel) => isEditorPanel(descriptorOf(panel)));
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
              loaded?.panels.length ? loaded.panels : INITIAL_PANELS,
            ),
          { reuseExistingPanels: true },
        );
      } catch {
        api.fromJSON(
          createPresetLayout(
            'conversation',
            loaded?.panels.length ? loaded.panels : INITIAL_PANELS,
          ),
          { reuseExistingPanels: true },
        );
        setMessage('layoutRecovered');
      }
      if (loaded?.layout) setPreset(null);
      if (loaded?.recovered) setMessage('layoutRecovered');
      const previousActive = api.activePanel;
      // Only relocated primary surfaces leave the old grid; document and tool groups stay.
      for (const panel of [...api.panels]) {
        const descriptor = descriptorOf(panel);
        if (descriptor.kind === 'context' && primaryViewFor(descriptor.view) !== 'files')
          api.removePanel(panel);
        else if (loaded?.panels.length) {
          fileWorkOpened.current = true;
          setHasFileWork(true);
        }
      }
      if (!api.panels.length)
        api.addPanel({
          id: 'context:files',
          component: 'workbench',
          params: { descriptor: { kind: 'context', view: 'files' } },
          title: labels.current('files'),
          renderer: 'always',
        });
      if (previousActive && api.getPanel(previousActive.id)) previousActive.api.setActive();
      mutating.current = false;
      refresh();
      const width = host.current?.getBoundingClientRect().width ?? 0;
      narrow.current = width > 0 && width <= NARROW;
      setCompact(narrow.current);
      if (narrow.current && api.activePanel) api.activePanel.api.maximize();
      openContext(current.current.selectedPanel ?? 'chat');
      setDockApi(api);
      saveLayout();
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
        current.current.onActiveContext?.(
          descriptor.kind === 'context' ? descriptor.view : 'files',
        );
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
      if (previous.sessionId !== props.sessionId) {
        setHistoryVisited(false);
        setChangesVisited(false);
        if (props.selectedPanel === undefined) setSessionView('chat');
      }
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
    useEffect(
      () => props.subscribeGraphs?.(() => actions.current.refresh()),
      [props.subscribeGraphs],
    );
    useEffect(() => {
      current.current.onPanesHiddenChange?.(sessionView === 'chat');
    }, [sessionView]);
    const primaryTabs: PrimaryView[] = [
      'chat',
      ...(props.fileWorkAvailable || hasFileWork ? (['files', 'changes'] as const) : []),
      'run',
    ];
    // Opening a pane lists every pane once, under what it is for (#70 IA-04).
    const paneOptions = PANE_CATALOG.filter((entry) => primaryViewFor(entry.view) === 'files').map(
      (entry) => ({
        value: `context:${entry.view}`,
        label: t(entry.view),
        group: t(groupLabel[entry.group]),
      }),
    );
    return (
      <RendererContext.Provider
        value={{
          renderContext: (view) => (hasFileWork ? props.renderContext(view) : null),
          renderDocument: props.renderDocument,
          renderGraph: props.renderGraph,
          selection,
          terminalStatus: props.terminalStatus,
          close: (id) => void closePanel(id),
          actions: {
            compact,
            preset,
            openContext: (view) => openContext(view, true),
            applyPreset,
            move,
            split,
            resize,
            step: (direction) => {
              setSessionView('files');
              if (direction === 'previous')
                apiRef.current?.activatePrevious({ includePanel: true });
              else apiRef.current?.activateNext({ includePanel: true });
            },
          },
        }}
      >
        <section
          ref={host}
          aria-label={t('title')}
          className="corral-dock-workbench"
          data-testid="dock-workbench"
          onClickCapture={(event) => {
            if (
              event.button !== 0 ||
              event.metaKey ||
              event.ctrlKey ||
              event.shiftKey ||
              event.altKey
            )
              return;
            const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
            if (
              !(link instanceof HTMLAnchorElement) ||
              link.hasAttribute('download') ||
              (link.target && link.target !== '_self')
            )
              return;
            const url = new URL(link.href);
            if (
              url.origin !== window.location.origin ||
              url.pathname !== `/sessions/${encodeURIComponent(props.sessionId)}` ||
              url.searchParams.has('settings')
            )
              return;
            const panel = validateSessionSearch(Object.fromEntries(url.searchParams)).panel;
            // An explicit link opens its pane even when the URL is already selected.
            if (panel) openContext(panel);
          }}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Delete' && event.key !== 'Backspace') return;
            const tab = event.target;
            if (!(tab instanceof HTMLElement) || tab.getAttribute('role') !== 'tab') return;
            const id = tab.dataset.tabPanelId;
            if (!id) return;
            // Dockview's native delete path bypasses the unsaved-document decision.
            event.preventDefault();
            event.stopPropagation();
            const tabList = tab.closest('[role="tablist"]');
            void closePanel(id).then(() => {
              if (tab.isConnected) return;
              const next =
                tabList?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ??
                host.current?.querySelector<HTMLElement>(
                  '.dv-active-group [role="tab"][aria-selected="true"]',
                );
              next?.focus();
            });
          }}
        >
          <Tabs
            value={sessionView}
            onValueChange={(value) => {
              if (value === 'files') {
                openContext('files');
                current.current.onActiveContext?.('files');
              } else openContext(value === 'run' || value === 'changes' ? value : 'chat', true);
            }}
            className="corral-dock-tabs"
          >
            <div className="corral-dock-primary-tabs">
              <TabsList aria-label={t('sessionViews')}>
                {primaryTabs.map((view) => (
                  <TabItem
                    key={view}
                    value={view}
                    label={t(view === 'run' ? 'history' : view)}
                    onClick={() => {
                      if (sessionView === view && (view === 'changes' || view === 'run'))
                        openContext(view, true);
                    }}
                  />
                ))}
              </TabsList>
            </div>
            {compact && sessionView === 'files' ? (
              <div className="corral-dock-toolbar" data-testid="dock-toolbar">
                <Select
                  label={t('panes')}
                  placeholder={t('panes')}
                  size="sm"
                  value={active}
                  onValueChange={(id) => {
                    const panel = apiRef.current?.getPanel(id);
                    if (panel) focus(panel, true);
                    else if (id.startsWith('context:'))
                      openContext(id.slice('context:'.length) as DockContextView, true);
                  }}
                  options={[
                    ...paneOptions,
                    ...panels
                      .filter(
                        (panel) =>
                          panel.id.startsWith('document:') || panel.id.startsWith('graph:'),
                      )
                      .map((panel) => ({ value: panel.id, label: panel.title })),
                  ]}
                />
              </div>
            ) : null}
            {props.controls ? <div className="corral-dock-controls">{props.controls}</div> : null}
            {message ? (
              <p role="status" className="px-3 py-1 text-xs text-muted-foreground">
                {t(message)}
              </p>
            ) : null}
            <TabPanel value="chat" keepMounted className="corral-dock-session-panel">
              {props.renderContext('chat')}
            </TabPanel>
            <TabPanel value="files" keepMounted className="corral-dock-session-panel">
              <div className="corral-dock-area">
                <DockviewReact
                  components={components}
                  defaultTabComponent={DockTab}
                  rightHeaderActionsComponent={DockHeaderActions}
                  theme={theme}
                  onReady={onReady}
                  disableFloatingGroups
                  getTabContextMenuItems={() => []}
                />
              </div>
            </TabPanel>
            <TabPanel value="changes" keepMounted className="corral-dock-session-panel">
              {changesVisited ? props.renderContext('changes', changesView) : null}
            </TabPanel>
            <TabPanel value="run" keepMounted className="corral-dock-session-panel">
              {historyVisited ? props.renderContext('run', historyView) : null}
            </TabPanel>
          </Tabs>
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
