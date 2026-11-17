import type { CorralDefinition, FileDocument, TerminalView } from '@corral/contracts';
import {
  Coordinator,
  createKeyValueCorralRepository,
  InMemoryRunStore,
  InProcessTransport,
  type RunSummary,
  type RuntimeTransport,
} from '@corral/core';
import { Gate, linearCorral, ScriptedAgentAdapter, SequentialIdFactory } from '@corral/testkit';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';
import { DemoWorkspace } from '../demo/workspace.ts';
import { createDemoWorkspaces } from '../demo/workspaces-client.ts';
import type { DemoWorkspaceMethod } from '../demo-protocol.ts';
import { LocaleProvider } from '../locale.tsx';
import { createStudioRouter } from '../router.tsx';
import { createRunSessions } from '../runSessions.ts';
import { ServicesProvider, type StudioServices } from '../services.tsx';
import { type DocumentStore, documentStore } from '../workbench/documents/store.ts';
import { WorkAreaWidthContext } from '../workbench/panel/workAreaWidth.ts';
import { StudioDesignKit } from '../workbench/StudioDesignKit.tsx';
import { type TerminalStore, terminalStore } from '../workbench/terminals/store.ts';

// The whole app on a memory history, over the in-process runtime the demo worker runs: a real
// Coordinator with scripted agents, a real repository on this window's storage, and the run
// stores the app builds. Only what jsdom cannot run is left out. Test-only.

export interface Gated<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function gated<T>(): Gated<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export interface ShellWorld {
  services: StudioServices;
  transport: RuntimeTransport;
  /** Every command sent to a run, in order. */
  commands: { type: string; runId: string; commandId: string }[];
  /** The next command sent never reaches the run, and its answer is lost on the way. */
  loseNextAnswer(): void;
  /**
   * Lets the held replies go, once at least one is waiting: the runs waiting on one go on,
   * most to their end. Replies asked for later are held again.
   */
  releaseReplies(): Promise<void>;
  /** Resolves once the run's own record reaches one of `statuses`. */
  runReaches(runId: string, statuses: readonly string[]): Promise<void>;
  /** Resolves once at least `count` of the run's executions have not ended. */
  working(runId: string, count: number): Promise<void>;
  /** Another conversation in the same project, with the same team. */
  createConversation(title: string): Promise<string>;
  /** While set, run listings wait until it is released. */
  holdListings(): () => void;
  sessionId: string;
  projectId: string;
  definition: CorralDefinition;
  /** Starts a run of the session's team in this conversation; `breakpoints` stop it for the person. */
  startRun(options?: { breakpoints?: string[] }): Promise<string>;
  /** With `server`: the documents and terminals the page reaches, and what was asked of them. */
  server: ServerParts | null;
}

export interface ServerParts {
  documents: DocumentStore;
  terminals: TerminalStore;
  /** Every call to the terminal service that changes a terminal (create, control, stop …). */
  terminalCalls: string[];
  /** Every document save sent. */
  saves: string[];
  /** The conversation's first listed terminal (`terminal_one`). */
  terminalId: string;
  /** What each terminal creation asked for: its shell. */
  created: string[];
  /** Releases a held creation (`holdCreate`), once it has been asked for. */
  releaseCreate(): void;
  /** Sets a listed terminal's state, as the host would report it on the next read. */
  setTerminalState(terminalId: string, state: TerminalView['state']): void;
  /** Sets what a terminal's foreground is now, as the host reads it on the next read or list. */
  setForeground(terminalId: string, foreground: TerminalView['foreground']): void;
  /** While set, every terminal read and list fails. */
  setReadsFail(fail: boolean): void;
  /** Each terminal read (by ID) the page asked for, in order. */
  reads: string[];
  /** How many times the page asked for the conversation's terminal list. */
  lists(): number;
  /** Each terminal stop (by ID) the page sent, in order. */
  stops: string[];
  /** The one file the working copy holds. */
  path: string;
}

export interface ShellWorldOptions {
  /** The conversation's team; one writer by default. */
  definition?: CorralDefinition;
  /** The project has a folder connected (the demo's example folder). */
  folder?: boolean;
  /** Which replies wait for `replies`; all of them by default. */
  holds?: (nodeId: string) => boolean;
  /**
   * The local backend's parts the page reaches in server mode, faked: a working copy with one
   * text file (documents open from quick open), and one running terminal unless the terminal
   * options say otherwise.
   */
  server?: boolean | TerminalOptions;
}

/** The faked terminal service: what the conversation's terminal list starts with. */
export interface TerminalOptions {
  /** The terminals listed at first (the default: one running terminal, `terminal_one`). */
  terminals?: TerminalView['state'][];
  /** The shells the list offers, first first (the default: bash). */
  shells?: string[];
  /** The conversation has no Paddock: the list names no target. */
  noCopy?: boolean;
  /** Creation waits until the returned release is called (see `holdCreate`). */
  holdCreate?: boolean;
}

export async function createShellWorld(options: ShellWorldOptions = {}): Promise<ShellWorld> {
  const holds = options.holds ?? (() => true);
  const store = new InMemoryRunStore();
  const files = new DemoWorkspace(store);
  let replies = new Gate();
  const coordinator = new Coordinator({
    store,
    files,
    clock: { nowIso: () => new Date().toISOString(), monotonicMs: () => performance.now() },
    ids: new SequentialIdFactory('t'),
    timers: {
      after(ms, fn) {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
    },
    agents: new ScriptedAgentAdapter({
      turns: 1,
      beforeReply: (_turn, input) => (holds(input.nodeId) ? replies.wait() : Promise.resolve()),
    }),
  });
  const inner = new InProcessTransport(coordinator);
  const commands: ShellWorld['commands'] = [];
  let listingHold: Gated<void> | null = null;
  let loseNext = false;
  const transport: RuntimeTransport = {
    startRun: (request) => inner.startRun(request),
    sendCommand: (command) => {
      commands.push({ type: command.type, runId: command.runId, commandId: command.commandId });
      if (loseNext) {
        loseNext = false;
        return Promise.reject(new Error('Failed to fetch'));
      }
      return inner.sendCommand(command);
    },
    getReceipt: (...args) => inner.getReceipt(...args),
    getSnapshot: (...args) => inner.getSnapshot(...args),
    getArtifactText: (...args) => inner.getArtifactText(...args),
    getConversationTurn: (...args) => inner.getConversationTurn(...args),
    getMeetingAnswer: (...args) => inner.getMeetingAnswer(...args),
    listRuns: async (): Promise<RunSummary[]> => {
      const hold = listingHold;
      if (hold) await hold.promise;
      return inner.listRuns();
    },
    getRunDefinition: (...args) => inner.getRunDefinition(...args),
    getRunStats: (...args) => inner.getRunStats(...args),
    subscribe: (...args) => inner.subscribe(...args),
  };
  const repository = createKeyValueCorralRepository(window.localStorage, {
    clock: { nowIso: () => new Date().toISOString(), monotonicMs: () => performance.now() },
    newCorralId: () => 'corral_team',
  });
  const project = await repository.createProject({ name: 'Project' });
  if (!project.ok) throw new Error('project not created');
  const projectId = project.project.projectId;
  if (options.folder) files.bind(projectId, 'example');
  const definition = options.definition ?? linearCorral(['writer'], 'team');
  const saved = await repository.save({ definition, expectedDefinitionRevision: null, projectId });
  if (!saved.ok) throw new Error('team not saved');
  const createConversation = async (title: string) => {
    const created = await repository.createSession({
      projectId,
      corralId: saved.record.corralId,
      title,
    } as never);
    if (!created.ok) throw new Error('session not created');
    return created.session.sessionId;
  };
  const sessionId = await createConversation('Conversation');
  // As the worker answers: a failed call is a rejected promise, never a thrown error.
  const call = async (method: DemoWorkspaceMethod, ...args: unknown[]) =>
    (files[method] as unknown as (...a: unknown[]) => unknown).apply(files, args);
  const demo = createDemoWorkspaces(call, repository, transport);
  const server = options.server
    ? serverParts(sessionId, projectId, options.server === true ? {} : options.server)
    : null;
  const workspaces = server ? { ...demo, ...server.workspaces } : demo;
  if (server) server.prepare(workspaces);
  let started = 0;
  const services = {
    mode: server ? 'server' : 'browser',
    workspaceId: server ? HOST : undefined,
    terminals: server?.terminals ?? null,
    sessionDeletion: null,
    persistent: true,
    sessionMissing: false,
    models: null,
    harnesses: null,
    live: false,
    repository,
    transport,
    readHistory: async () => {
      throw new Error('no history in tests');
    },
    // Run stores belong to a page: each mount builds its own (mountShell).
    editorSessions: new Map(),
    runModes: {},
    saveRunMode: async () => {},
    workspaces,
    meetings: {} as StudioServices['meetings'],
    startAuto: async () => {
      throw new Error('no auto starts in tests');
    },
  } as unknown as StudioServices;
  return {
    services,
    transport,
    commands,
    loseNextAnswer() {
      loseNext = true;
    },
    async releaseReplies() {
      for (let i = 0; i < 200 && replies.waiting === 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 5));
      const held = replies;
      replies = new Gate();
      held.open();
    },
    async runReaches(runId, statuses) {
      for (let i = 0; i < 200; i++) {
        const { projection } = await inner.getSnapshot(runId);
        if (statuses.includes(projection.status)) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const { projection } = await inner.getSnapshot(runId);
      throw new Error(`run did not reach ${statuses.join(' or ')}: ${projection.status}`);
    },
    async working(runId, count) {
      const ended = new Set(['succeeded', 'failed', 'cancelled', 'skipped']);
      for (let i = 0; i < 200; i++) {
        const { projection } = await inner.getSnapshot(runId);
        const open = Object.values(projection.executions).filter((e) => !ended.has(e.status));
        if (open.length >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`run never had ${count} executions working`);
    },
    createConversation,
    holdListings() {
      const hold = gated<void>();
      listingHold = hold;
      return () => {
        if (listingHold === hold) listingHold = null;
        hold.resolve();
      };
    },
    sessionId,
    projectId,
    definition,
    server: server?.parts ?? null,
    async startRun({ breakpoints }: { breakpoints?: string[] } = {}) {
      started += 1;
      const result = await transport.startRun({
        schemaVersion: '0.1',
        commandId: `cmd_start_${started}`,
        definition,
        mode: 'mock',
        sessionId,
        ...(breakpoints ? { breakpoints } : {}),
      });
      if (!result.runId) throw new Error('run not started');
      // The request that started it, as the composer records it: the conversation's answer row.
      await repository.addSessionEntry(sessionId, {
        intent: 'next',
        text: `Request ${started}`,
        state: 'started',
        runId: result.runId,
        commandId: `cmd_start_${started}`,
      });
      return result.runId;
    },
  };
}

const HOST = 'host';

/** The working copy, its one file, and one running terminal, as the local backend serves them. */
function serverParts(sessionId: string, projectId: string, options: TerminalOptions) {
  const target = { hostId: HOST, projectId, bindingId: 'binding', sessionId, copyGeneration: 1 };
  const path = 'notes.md';
  const text = 'first line\n';
  const document: FileDocument = {
    target,
    path,
    content: { kind: 'text', text },
    writable: true,
    version: {
      sha256: 'a'.repeat(64),
      bytes: text.length,
      encoding: 'utf-8',
      bom: false,
      eol: 'lf',
    },
  };
  const saves: string[] = [];
  const workspaces = {
    worktree: async () => ({
      sessionId,
      bindingId: 'binding',
      copyGeneration: 1,
      baseCommit: 'base',
      createdAt: '2026-11-16T00:00:00Z',
      removedAt: null,
      reviewed: false,
      missing: false,
    }),
    searchFiles: async () => ({ items: [{ path, kind: 'file' as const }], truncated: false }),
    readDocument: async () => structuredClone(document),
    changeDocument: async (_session: string, command: { path: string }) => {
      saves.push(command.path);
      throw new Error('saves are not part of these cases');
    },
    documentOperation: async () => {
      throw new Error('no receipt');
    },
  };
  const terminalId = 'terminal_one';
  const view: TerminalView = {
    terminalId,
    target,
    generation: 'generation_one',
    shellId: options.shells?.[0] ?? 'bash',
    state: 'running',
    initialCols: 80,
    initialRows: 24,
    cols: 80,
    rows: 24,
    lastSequence: 0,
    replayAvailable: false,
    controllerGeneration: 0,
    controller: null,
    exitCode: null,
    error: null,
    foreground: 'idle',
  };
  const terminalCalls: string[] = [];
  const listing = () => ({
    target: options.noCopy ? null : target,
    available: !options.noCopy,
    reason: options.noCopy ? 'The managed working copy is unavailable' : null,
    shells: (options.shells ?? ['bash']).map((id) => ({ id, label: id })),
    terminals: listed.map((item) => structuredClone(item)),
  });
  const names = ['terminal_one', 'terminal_two', 'terminal_three', 'terminal_four'];
  const listed: TerminalView[] = (options.terminals ?? ['running']).map((state, index) => ({
    ...structuredClone(view),
    terminalId: names[index] ?? `terminal_${index}`,
    generation: `generation_${index}`,
    state,
  }));
  const find = (id: string) => listed.find((item) => item.terminalId === id) ?? listed[0] ?? view;
  const changing =
    (name: string) =>
    async (_session: string, id: string): Promise<TerminalView> => {
      terminalCalls.push(name);
      return structuredClone(find(id));
    };
  const created: string[] = [];
  const reads: string[] = [];
  const stops: string[] = [];
  let readsFail = false;
  let lists = 0;
  let createHold: Gated<void> | null = null;
  const terminals = {
    attention: async () => [],
    list: async () => {
      lists += 1;
      if (readsFail) throw new Error('terminal list unavailable');
      return listing();
    },
    read: async (_session: string, id: string) => {
      reads.push(id);
      if (readsFail) throw new Error('terminal read unavailable');
      return structuredClone(find(id));
    },
    create: async (_session: string, command: { shellId: string; operationId: string }) => {
      terminalCalls.push('create');
      created.push(command.shellId);
      if (options.holdCreate) {
        createHold = gated<void>();
        await createHold.promise;
      }
      const made: TerminalView = {
        ...structuredClone(view),
        terminalId: names[listed.length] ?? command.operationId,
        generation: `generation_${listed.length}`,
        shellId: command.shellId,
        state: 'running',
      };
      listed.push(made);
      return structuredClone(made);
    },
    control: changing('control'),
    input: changing('input'),
    resize: changing('resize'),
    stop: async (_session: string, id: string): Promise<TerminalView> => {
      terminalCalls.push('stop');
      stops.push(id);
      const item = listed.find((entry) => entry.terminalId === id);
      if (item && item.state !== 'uncertain')
        Object.assign(item, { state: 'exited', stopped: true });
      return structuredClone(find(id));
    },
    subscribe: () => () => {},
  };
  // The page's stores are one per client: made here with an editor model and a recovery store
  // jsdom can hold, the page gets these same stores.
  const loadMonaco = async () =>
    ({
      Uri: { from: (value: unknown) => value },
      editor: {
        createModel: (value: string) => new FakeModel(value),
        EndOfLinePreference: { TextDefined: 0 },
        EndOfLineSequence: { LF: 0, CRLF: 1 },
      },
    }) as never;
  const drafts = new Map<string, unknown>();
  const parts = {
    terminals: terminalStore(terminals as never),
    terminalCalls,
    saves,
    terminalId,
    path,
    created,
    releaseCreate: () => createHold?.resolve(),
    setTerminalState: (id: string, state: TerminalView['state']) => {
      const item = listed.find((entry) => entry.terminalId === id);
      if (item) item.state = state;
    },
    setForeground: (id: string, foreground: TerminalView['foreground']) => {
      const item = listed.find((entry) => entry.terminalId === id);
      if (item) item.foreground = foreground;
    },
    setReadsFail: (fail: boolean) => {
      readsFail = fail;
    },
    reads,
    lists: () => lists,
    stops,
  } as Omit<ServerParts, 'documents'> & { documents?: DocumentStore };
  return {
    workspaces,
    terminals,
    parts: parts as ServerParts,
    prepare(client: object) {
      parts.documents = documentStore(client as never, {
        loadMonaco,
        recovery: {
          list: async () => [],
          listSession: async () => [],
          write: async (draft) => void drafts.set(draft.id, draft),
          remove: async (draft) => void drafts.delete(draft.id),
          clearSession: async () => drafts.clear(),
        },
      });
    },
  };
}

/** The editor's text model, as far as the document store reads and writes it. */
export class FakeModel {
  private text: string;
  private listeners = new Set<() => void>();
  constructor(text: string) {
    this.text = text.replace(/\r\n|\r/g, '\n');
  }
  getValue() {
    return this.text;
  }
  setValue(text: string) {
    this.text = text;
    for (const listener of this.listeners) listener();
  }
  onDidChangeContent(listener: () => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  pushEOL(eol: number) {
    this.setValue(this.text.replace(/\r\n|\r|\n/g, eol === 1 ? '\r\n' : '\n'));
  }
  getEOL() {
    return '\n';
  }
  dispose() {
    this.listeners.clear();
  }
}

export interface MountedShell {
  container: HTMLElement;
  /** A new page at the current address over the same storages, as a browser reload is. */
  reload(): Promise<MountedShell>;
  /** Gives the work area a new width, as a window resize (or the first measure) would. */
  setWidth(px: number): Promise<void>;
  /**
   * Goes to `href` as an OS notification does: an address from outside the app, on a new history
   * entry whose state is the current entry's with `corralEntry: 'outside'` added.
   */
  arriveFromOutside(href: string): Promise<void>;
  router: ReturnType<typeof createStudioRouter>;
  history: ReturnType<typeof createMemoryHistory>;
  unmount(): Promise<void>;
}

/** Lets effects, listings and run reads settle. */
export async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
}

/** A work area with room for the conversation and the panel side by side. */
export const WIDE = 1400;
/** A work area without that room, but wider than a full-width drawer. */
export const NARROW = 800;

/**
 * Mounts the app at `entries` (the last one current) in a work area `width` px wide. Mounting
 * again with the same world, after unmounting, is a reload: both storages stay.
 */
export async function mountShell(
  world: ShellWorld,
  entries: string[],
  /** The work area's width; null leaves it unmeasured until `setWidth`. */
  { width = WIDE }: { width?: number | null } = {},
): Promise<MountedShell> {
  // A page's own run stores, as each page load builds them, over the world's one runtime.
  const runs = createRunSessions(world.transport);
  const services: StudioServices = {
    ...world.services,
    runFor: runs.runFor,
    sessionFor: runs.sessionFor,
    retainRun: runs.retainRun,
    liveRun: runs.liveRun,
    watchRuns: runs.watchRuns,
    disposeRuns: runs.dispose,
  };
  const router = createStudioRouter(services, { runLookupMs: 50 });
  const history = createMemoryHistory({
    initialEntries: entries,
    initialIndex: entries.length - 1,
  });
  router.update({ ...router.options, history });
  const container = document.createElement('div');
  document.body.append(container);
  let root: Root | null = createRoot(container);
  let currentWidth = width;
  const render = () =>
    root?.render(
      <StrictMode>
        <WorkAreaWidthContext.Provider value={currentWidth}>
          <StudioDesignKit>
            <LocaleProvider>
              <ServicesProvider services={services}>
                <RouterProvider router={router} />
              </ServicesProvider>
            </LocaleProvider>
          </StudioDesignKit>
        </WorkAreaWidthContext.Provider>
      </StrictMode>,
    );
  await act(async () => {
    render();
    await router.load();
  });
  await settle();
  const unmount = async () => {
    const current = root;
    root = null;
    if (current) await act(async () => current.unmount());
    container.remove();
  };
  return {
    container,
    router,
    history,
    async reload() {
      // A reload never unmounts React, so nothing on the page gets to clean up: this tab's
      // sessionStorage is kept as it was, the old page is torn down, and a new one is built.
      const kept = Object.entries({ ...window.sessionStorage });
      const href = router.state.location.href;
      await unmount();
      runs.dispose();
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      window.sessionStorage.clear();
      for (const [key, value] of kept) window.sessionStorage.setItem(key, value);
      return mountShell(world, [href], { width: currentWidth });
    },
    async setWidth(px) {
      currentWidth = px;
      await act(async () => render());
      await settle();
    },
    async arriveFromOutside(href) {
      await act(async () => {
        await router.navigate({
          to: href,
          state: ((previous: object) => ({ ...previous, corralEntry: 'outside' })) as never,
        });
      });
      await settle();
    },
    unmount,
  };
}

/** Stubs jsdom lacks; call in each test before mounting. */
export function stubBrowser() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  }));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const animations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: () => [],
  });
  return () => {
    if (animations) Object.defineProperty(Element.prototype, 'getAnimations', animations);
    else Reflect.deleteProperty(Element.prototype, 'getAnimations');
  };
}
