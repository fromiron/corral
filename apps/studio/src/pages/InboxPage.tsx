import { type ProjectSummary, pendingInteractions, type RunSummary } from '@corral/core';
import type { RunSessionState } from '@corral/react';
import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  cn,
  EmptyState,
  fontWeights,
  KitCardTitle,
  Page,
  SectionLabel,
} from '@corral/react/design-kit';
import { ArrowLeft, X } from '@corral/react/icons';
import { Link, useNavigate, useRouterState } from '@tanstack/react-router';
import { type KeyboardEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { projectName } from '../projects.ts';
import { useServices } from '../services.tsx';
import { type InboxEntry, inboxEntries, inboxGroups } from '../workbench/inbox.ts';
import { workHref } from '../workbench/navigation.ts';
import { type InboxDestination, inboxDestination } from '../workbench/notifications.ts';
import { RunResponseArea } from '../workbench/RunResponseArea.tsx';
import { runIdentity } from '../workbench/runIdentity.ts';

// Needs you: every project's waiting items on one screen (docs/specs/features/inbox.md).

export interface InboxSearch {
  returnTo?: string;
  /** The selected item's key (InboxEntry.key), so Back from its target opens it again. */
  item?: string;
}

const itemKey = (value: unknown) =>
  typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : undefined;

export function validateInboxSearch(search: Record<string, unknown>): InboxSearch {
  const returnTo = workHref(search.returnTo);
  const item = itemKey(search.item);
  return { ...(returnTo ? { returnTo } : {}), ...(item ? { item } : {}) };
}

/** One project's last answer; a failed read keeps what it showed before. */
interface ProjectInbox {
  entries: InboxEntry[];
  loaded: boolean;
  failed: boolean;
}

type FocusTarget = { kind: 'detail' } | { kind: 'heading' } | { kind: 'row'; key: string };

export function InboxPage() {
  const t = useTranslations('Inbox');
  const tp = useTranslations('Projects');
  const tw = useTranslations('Workbench');
  const tr = useTranslations('Recipe');
  const tv = useTranslations('Review');
  const { repository, transport, workspaces } = useServices();
  const navigate = useNavigate();
  const returnTo = workHref(
    useRouterState({
      select: (state) => (state.location.search as Record<string, unknown>).returnTo,
    }),
  );
  const addressed = itemKey(
    useRouterState({
      select: (state) => (state.location.search as Record<string, unknown>).item,
    }),
  );
  const id = useId();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [inboxes, setInboxes] = useState<Record<string, ProjectInbox>>({});
  const [runs, setRuns] = useState<RunSummary[]>([]);
  // The selection lives in the address (`item`); this copy answers a click at once.
  const [selectedKey, setSelectedKey] = useState<string | null>(addressed ?? null);
  // The selected item as last listed, so its notice can still name it once it is gone.
  const [lastSeen, setLastSeen] = useState<InboxEntry | null>(null);
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);
  // What this page wrote to the address and the router has not shown yet: not new selections.
  const written = useRef<(string | undefined)[]>([]);
  // A read per project: only the newest one may change what that project shows.
  const generations = useRef(new Map<string, number>());
  const listGeneration = useRef(0);
  const live = useRef(true);
  const main = useRef<HTMLElement>(null);
  const detail = useRef<HTMLElement>(null);

  const loadProject = useCallback(
    (projectId: string) => {
      if (!workspaces) return;
      const generation = (generations.current.get(projectId) ?? 0) + 1;
      generations.current.set(projectId, generation);
      const current = () => live.current && generations.current.get(projectId) === generation;
      workspaces.inbox(projectId).then(
        (items) => {
          if (!current()) return;
          setInboxes((previous) => ({
            ...previous,
            [projectId]: { entries: inboxEntries(projectId, items), loaded: true, failed: false },
          }));
        },
        () => {
          if (!current()) return;
          setInboxes((previous) => ({
            ...previous,
            [projectId]: {
              entries: previous[projectId]?.entries ?? [],
              loaded: previous[projectId]?.loaded ?? false,
              failed: true,
            },
          }));
        },
      );
    },
    [workspaces],
  );

  // On opening and when the window comes back; never on a timer.
  const loadAll = useCallback(() => {
    const generation = ++listGeneration.current;
    const current = () => live.current && listGeneration.current === generation;
    repository.listProjects().then(
      (list) => {
        if (!current()) return;
        const open = list.filter((project) => !project.archivedAt);
        setProjects(open);
        setProjectsFailed(false);
        for (const project of open) loadProject(project.projectId);
      },
      () => {
        if (current()) setProjectsFailed(true);
      },
    );
    transport.listRuns().then(
      (list) => {
        if (current()) setRuns(list);
      },
      () => {},
    );
  }, [repository, transport, loadProject]);

  useEffect(() => {
    live.current = true;
    loadAll();
    window.addEventListener('focus', loadAll);
    return () => {
      live.current = false;
      window.removeEventListener('focus', loadAll);
    };
  }, [loadAll]);

  const entries = (projects ?? []).flatMap((project) => inboxes[project.projectId]?.entries ?? []);
  const groups = inboxGroups(entries);
  const ordered = groups.flatMap((group) => group.entries);
  const failures = (projects ?? []).filter((project) => inboxes[project.projectId]?.failed);
  const settled =
    projects !== null &&
    (!workspaces ||
      projects.every(
        (project) => inboxes[project.projectId]?.loaded || inboxes[project.projectId]?.failed,
      ));
  // The detail follows the chosen key only; a refresh never turns it into another run.
  const current = selectedKey ? entries.find((entry) => entry.key === selectedKey) : undefined;
  if (current && lastSeen !== current) setLastSeen(current);
  const seen = lastSeen?.key === selectedKey ? lastSeen : null;
  // Whether a key missing from the list is really gone, not just unread.
  const conclusive = settled && !projectsFailed && failures.length === 0;

  /** Selection changes replace the address; arriving from elsewhere keeps its own entry. */
  const writeAddress = useCallback(
    (item: string | undefined) => {
      if (item === addressed) return;
      written.current.push(item);
      void navigate({
        to: '/inbox',
        search: { ...(returnTo ? { returnTo } : {}), ...(item ? { item } : {}) },
        replace: true,
      });
    },
    [navigate, returnTo, addressed],
  );
  // Back, forward or a link to another item moves the selection; the page's own writes do not.
  useEffect(() => {
    const own = written.current.indexOf(addressed);
    if (own >= 0) {
      written.current = written.current.slice(own + 1);
      return;
    }
    written.current = [];
    setSelectedKey(addressed ?? null);
  }, [addressed]);
  // An unknown or handled key leaves the address quietly; the detail says it was handled.
  useEffect(() => {
    if (conclusive && selectedKey && !current && addressed === selectedKey) writeAddress(undefined);
  }, [conclusive, selectedKey, current, addressed, writeAddress]);

  useEffect(() => {
    if (!focusTarget) return;
    setFocusTarget(null);
    if (focusTarget.kind === 'detail') {
      detail.current?.focus();
      return;
    }
    if (focusTarget.kind === 'row') {
      const row = [...(main.current?.querySelectorAll<HTMLElement>('[data-inbox-row]') ?? [])].find(
        (element) => element.dataset.inboxRow === focusTarget.key,
      );
      const button = row?.querySelector<HTMLElement>('button');
      if (button) {
        button.focus();
        return;
      }
    }
    const heading = main.current?.querySelector<HTMLElement>('h1');
    if (heading) {
      heading.tabIndex = -1;
      heading.focus();
    }
  }, [focusTarget]);

  const projectLabel = (projectId: string) =>
    projectName(
      projects?.find((project) => project.projectId === projectId),
      tp('defaultName'),
    );
  const runNumber = (runId: string | null) => {
    const run = runId ? runs.find((item) => item.runId === runId) : undefined;
    return run ? runIdentity(run, runs, []).number : null;
  };
  /**
   * What the item is, never its body. A decision's group already names its state, so its line is
   * only the run (and it is not guessed as a question or an approval); other kinds name themselves.
   */
  const kindLine = ({ item }: InboxEntry): string | null => {
    const number = runNumber(item.runId);
    const run = number ? tw('runNumber', { number }) : null;
    if (item.kind === 'decision') return run;
    const kind =
      item.kind === 'recipe_stopped'
        ? t('kind.recipe_stopped', {
            reason:
              item.detail && tr.has(`reasons.${item.detail}`) ? tr(`reasons.${item.detail}`) : '',
          })
        : t(`kind.${item.kind}`);
    return run ? `${kind} · ${run}` : kind;
  };
  const joined = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  /** Under the detail's title: the row's line and the project; the body says the rest. */
  const detailLine = (entry: InboxEntry) => joined(kindLine(entry), projectLabel(entry.projectId));
  /**
   * The server's one-line summary of a non-decision item: the failed check's name, how many writes
   * or proposals wait, or the applying state. What this screen cannot name is left out, and a
   * queued request's body is never shown.
   */
  const summaryLine = ({ item }: InboxEntry): string | null => {
    const detail = item.detail;
    if (!detail) return null;
    if (item.kind === 'check_failed') return t('summary.check_failed', { name: detail });
    if (
      item.kind === 'uncertain_write' ||
      item.kind === 'unreviewed' ||
      item.kind === 'lsp_proposal'
    ) {
      const count = /^\d+$/.test(detail) ? Number(detail) : Number.NaN;
      return Number.isSafeInteger(count) && count > 0 ? t(`summary.${item.kind}`, { count }) : null;
    }
    if (item.kind === 'integration' && tv.has(`integrationState.${detail}`))
      return tv(`integrationState.${detail}`);
    return null;
  };

  const choose = (entry: InboxEntry) => {
    setSelectedKey(entry.key);
    writeAddress(entry.key);
    setFocusTarget({ kind: 'detail' });
  };
  // Closing is not an answer: nothing is sent, and focus returns to the row.
  const close = () => {
    const key = selectedKey;
    setSelectedKey(null);
    writeAddress(undefined);
    setFocusTarget(
      key && entries.some((entry) => entry.key === key)
        ? { kind: 'row', key }
        : { kind: 'heading' },
    );
  };
  const handled = (entry: InboxEntry) => {
    const at = ordered.findIndex((item) => item.key === entry.key);
    const next = at >= 0 ? ordered[at + 1] : undefined;
    // The success receipt is in: drop the item and any read already on its way, then read again.
    setInboxes((previous) => {
      const inbox = previous[entry.projectId];
      return inbox
        ? {
            ...previous,
            [entry.projectId]: {
              ...inbox,
              entries: inbox.entries.filter((item) => item.key !== entry.key),
            },
          }
        : previous;
    });
    loadProject(entry.projectId);
    setFocusTarget(next ? { kind: 'row', key: next.key } : { kind: 'heading' });
  };
  const onDetailKey = (event: KeyboardEvent<HTMLElement>) => {
    // Popups portal outside the detail and keep their own Escape.
    if (
      event.key !== 'Escape' ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      !event.currentTarget.contains(event.target as Node)
    )
      return;
    event.preventDefault();
    close();
  };

  // The chosen item, or, once it is gone, the notice that it was handled.
  const shown = current ?? seen;
  const open = Boolean(selectedKey && (current || seen || conclusive));
  const destination = current ? inboxDestination(current.item) : null;
  // A decision is answered here; every other kind is a link to its own screen.
  const respondsHere = current?.item.kind === 'decision' && current.item.runId !== null;
  const summary = current && !respondsHere ? summaryLine(current) : null;

  return (
    <main ref={main} className="flex min-h-0 flex-1 flex-col">
      <Page
        title={t('title')}
        {...(returnTo
          ? {
              toolbar: (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="ghost"
                    size="compact"
                    onClick={() => void navigate({ href: returnTo })}
                  >
                    <ArrowLeft aria-hidden />
                    {t('back')}
                  </Button>
                </div>
              ),
            }
          : {})}
      >
        {projectsFailed ? (
          <Banner status="error" size="compact">
            <BannerTitle>{t('projectsFailed')}</BannerTitle>
            <BannerActions>
              <Button variant="tertiary" size="compact" onClick={loadAll}>
                {t('retry')}
              </Button>
            </BannerActions>
          </Banner>
        ) : null}
        {failures.map((project) => (
          <Banner key={project.projectId} status="error" size="compact">
            <BannerTitle>
              {t('loadFailed', { project: projectLabel(project.projectId) })}
            </BannerTitle>
            <BannerActions>
              <Button
                variant="tertiary"
                size="compact"
                onClick={() => loadProject(project.projectId)}
              >
                {t('retry')}
              </Button>
            </BannerActions>
          </Banner>
        ))}
        {/* One screen: the list and, beside it or (when narrow) in its place, the chosen item. */}
        <div
          className={cn(
            'grid items-start gap-6',
            (open || entries.length > 0) && 'lg:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]',
          )}
        >
          <div className={cn('grid min-w-0 content-start gap-6', current && 'max-lg:hidden')}>
            {groups.map((group) => (
              <section key={group.id} className="grid gap-2">
                <SectionLabel count={group.entries.length}>
                  <span id={`${id}-${group.id}`}>{t(`groups.${group.id}`)}</span>
                </SectionLabel>
                <CardGroup orientation="inline" role="list" aria-labelledby={`${id}-${group.id}`}>
                  {group.entries.map((entry) => {
                    const line = kindLine(entry);
                    const project = projectLabel(entry.projectId);
                    return (
                      <Card
                        key={entry.key}
                        role="listitem"
                        data-inbox-row={entry.key}
                        selected={selectedKey === entry.key}
                        label={joined(entry.item.sessionTitle, line, project)}
                        onClick={() => choose(entry)}
                      >
                        <CardHeader className="[overflow-wrap:anywhere]">
                          {/* Titles wrap here, so the kit's one-line clip would only cut glyphs. */}
                          <KitCardTitle className="[&>span]:overflow-visible">
                            {entry.item.sessionTitle}
                          </KitCardTitle>
                          {line ? <CardDescription>{line}</CardDescription> : null}
                        </CardHeader>
                        <CardFooter className="max-w-1/3 min-w-0">
                          <span className="truncate text-caption text-muted-foreground">
                            {project}
                          </span>
                        </CardFooter>
                      </Card>
                    );
                  })}
                </CardGroup>
              </section>
            ))}
            {settled && entries.length === 0 && failures.length === 0 && !projectsFailed ? (
              <EmptyState title={t('empty')} text={t('emptyText')} />
            ) : null}
            {!settled && !projectsFailed && entries.length === 0 ? (
              // Until the first read settles the list says so instead of standing empty.
              <p role="status" className="m-0 text-body text-muted-foreground">
                {t('loading')}
              </p>
            ) : null}
          </div>
          {open ? (
            <section
              ref={detail}
              data-testid="inbox-detail"
              tabIndex={-1}
              aria-labelledby={`${id}-detail`}
              onKeyDown={onDetailKey}
              className="grid min-w-0 content-start gap-4 outline-none max-lg:order-first lg:sticky lg:top-6"
            >
              {/* Narrow: the item stands in the list's place, so the way out leads back to it. */}
              {current ? (
                <Button
                  variant="ghost"
                  size="compact"
                  className="justify-self-start lg:hidden"
                  onClick={close}
                >
                  <ArrowLeft aria-hidden />
                  {t('backToList')}
                </Button>
              ) : null}
              <header className="flex items-start justify-between gap-3">
                {shown ? (
                  <div className="grid min-w-0 gap-0.5">
                    <h2
                      id={`${id}-detail`}
                      className="m-0 text-title text-foreground [overflow-wrap:anywhere]"
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      {shown.item.sessionTitle}
                    </h2>
                    <p className="m-0 text-caption text-muted-foreground [overflow-wrap:anywhere]">
                      {detailLine(shown)}
                    </p>
                  </div>
                ) : (
                  // An item known only by its address: the notice is all there is to say.
                  <p
                    id={`${id}-detail`}
                    role="status"
                    className="m-0 min-h-7 content-center text-body text-muted-foreground"
                  >
                    {t('handled')}
                  </p>
                )}
                <div className="flex shrink-0 items-center gap-1">
                  {destination && respondsHere ? (
                    <Button variant="tertiary" size="compact" render={destinationLink(destination)}>
                      {t(`open.${destinationKind(destination)}`)}
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="icon-compact"
                    className={current ? 'max-lg:hidden' : undefined}
                    aria-label={t('close')}
                    onClick={close}
                  >
                    <X aria-hidden />
                  </Button>
                </div>
              </header>
              {!current ? (
                shown ? (
                  <p role="status" className="m-0 text-body text-muted-foreground">
                    {t('handled')}
                  </p>
                ) : null
              ) : respondsHere && current.item.runId ? (
                <DecisionResponse
                  key={current.key}
                  runId={current.item.runId}
                  sessionId={current.item.sessionId}
                  onHandled={() => handled(current)}
                />
              ) : destination ? (
                // Every other kind: what the server says of it in one line, and the way to it.
                <>
                  {summary ? (
                    <p className="m-0 text-body text-foreground [overflow-wrap:anywhere]">
                      {summary}
                    </p>
                  ) : null}
                  <Button className="justify-self-start" render={destinationLink(destination)}>
                    {t(`open.${destinationKind(destination)}`)}
                  </Button>
                </>
              ) : null}
            </section>
          ) : entries.length > 0 ? (
            <div data-testid="inbox-no-selection" className="max-lg:hidden lg:sticky lg:top-6">
              <EmptyState title={t('noSelection')} text={t('noSelectionText')} />
            </div>
          ) : null}
        </div>
      </Page>
    </main>
  );
}

function destinationLink(destination: InboxDestination) {
  return destination.to === '/sessions/$sessionId' ? (
    <Link to="/sessions/$sessionId" params={destination.params} search={destination.search} />
  ) : (
    <Link to="/sessions/$sessionId/review" params={destination.params} />
  );
}

function destinationKind(destination: InboxDestination) {
  if (destination.to === '/sessions/$sessionId/review') return 'review';
  return destination.search.panel ?? 'session';
}

/**
 * The selected decision's run, opened for it alone: the same response area as the Run page.
 * The item counts as handled only after a command sent here has a success receipt and nothing
 * else waits on the run.
 */
function DecisionResponse({
  runId,
  sessionId,
  onHandled,
}: {
  runId: string;
  sessionId: string;
  onHandled: () => void;
}) {
  const t = useTranslations('Inbox');
  const navigate = useNavigate();
  const { runFor, retainRun } = useServices();
  const session = runFor(runId);
  useEffect(() => {
    const release = retainRun(runId);
    void session.getState().open(runId);
    return release;
  }, [session, runId, retainRun]);
  const ready = useStore(session, (s) => s.runId === runId && s.projection !== null);
  const missing = useStore(session, (s) => s.missingRunId === runId);
  const error = useStore(session, (s) => s.streamError ?? s.definitionError);
  const events = useStore(session, (s) => s.events);
  const projection = useStore(session, (s) => s.projection);
  const receipts = useStore(session, (s) => s.receipts);
  const [sent, setSent] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    const track = (state: RunSessionState) =>
      setSent((previous) => {
        const fresh = state.pendingCommandIds.filter((commandId) => !previous.has(commandId));
        return fresh.length ? new Set([...previous, ...fresh]) : previous;
      });
    track(session.getState());
    return session.subscribe(track);
  }, [session]);
  const pending = ready ? pendingInteractions(events, projection).length : null;
  const answered = Object.entries(receipts).some(
    ([commandId, receipt]) =>
      sent.has(commandId) && receipt.status === 'applied' && receipt.error === undefined,
  );
  const reported = useRef(false);
  useEffect(() => {
    if (reported.current || !answered || pending !== 0) return;
    reported.current = true;
    onHandled();
  }, [answered, pending, onHandled]);

  if (!ready)
    return (
      <div className="grid justify-items-start gap-2">
        <p role={error ? 'alert' : 'status'} className="text-body text-muted-foreground">
          {error ? t('runFailed') : missing ? t('runMissing') : t('runLoading')}
        </p>
        {error ? (
          <Button
            variant="tertiary"
            size="compact"
            onClick={() => void session.getState().open(runId)}
          >
            {t('retry')}
          </Button>
        ) : null}
      </div>
    );
  return (
    <div className="grid gap-3">
      <RunResponseArea
        session={session}
        receipts
        onOpenArtifact={(artifact) =>
          void navigate({
            to: '/sessions/$sessionId',
            params: { sessionId },
            search: { panel: 'run', view: 'run', run: runId, artifact },
          })
        }
      />
      {pending === 0 && !answered ? (
        <p role="status" className="text-body text-muted-foreground">
          {t('nothingWaiting')}
        </p>
      ) : null}
    </div>
  );
}
