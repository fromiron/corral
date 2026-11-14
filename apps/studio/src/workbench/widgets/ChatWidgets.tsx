import { type PresenceKind, statusPresence, usePresenceWord } from '@corral/react';
import {
  AgentSteeringPlan,
  Button,
  focusRing,
  fontWeights,
  Meter,
  Select,
} from '@corral/react/design-kit';
import { ArrowRight, ChevronDown, FileDiff } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import type { SessionSearch } from '../panels/routes.ts';
import { formatCount } from './numbers.ts';
import { RunStatusAnnouncement } from './RunStatusAnnouncement.tsx';
import { actionCopy } from './selectors.ts';
import { type ChatWidgetModel, useChatWidget } from './useChatWidgets.tsx';

const CATEGORIES = [
  'messages',
  'system_prompt',
  'system_tools',
  'mcp_tools',
  'skills',
  'memory_files',
  'instructions',
  'other',
] as const;
const CATEGORY_FILL: Record<string, string> = {
  messages: 'bg-primary',
  system_prompt: 'bg-primary/65',
  system_tools: 'bg-muted',
  mcp_tools: 'bg-muted/65',
  skills: 'bg-success',
  memory_files: 'bg-warning',
  instructions: 'bg-text/75',
  other: 'bg-text/45',
};
export const chipClass = `inline-flex min-h-7 pointer-coarse:min-h-11 min-w-0 max-w-full items-center gap-1.5 rounded-full px-2.5 text-caption text-muted-foreground transition-colors hover:bg-subtle hover:text-foreground ${focusRing}`;
const number = (value: number) => value.toLocaleString();
/**
 * "Last run" for the newest finished run, whose turn already links it by number; an older one
 * names its position (#72).
 */
export function viewedLabel(
  viewed: NonNullable<ChatWidgetModel['viewed']>,
  t: ReturnType<typeof useTranslations<'Widgets'>>,
) {
  if (viewed.latest && viewed.number) return t('lastRun');
  return viewed.number
    ? t('selectedRun', { number: viewed.number, total: viewed.total })
    : t('selectedRunUnordered');
}
export const compactNumber = (value: number, locale: string) =>
  formatCount(value, locale, (short) =>
    short >= 1000 ? `${(short / 1000).toFixed(short < 10_000 ? 1 : 0)}k` : number(short),
  );

/** The context widget's words, also its accessible summary. */
export function contextLabel(
  context: ChatWidgetModel['context'],
  t: ReturnType<typeof useTranslations<'Widgets'>>,
  locale: string,
) {
  return context.kind === 'messages' && context.tokens != null
    ? t('contextMessages', { count: compactNumber(context.tokens, locale) })
    : context.percent != null
      ? t('contextPercent', { percent: context.percent })
      : context.completeness === 'error'
        ? t('contextError')
        : context.kind === 'partial'
          ? t('contextPartial')
          : t('contextPending');
}

/** A detail's heading. Details open in Overview's own place, so none is a popover's title. */
function DetailTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
      {children}
    </h2>
  );
}
function CompactRequest({
  compaction,
}: {
  compaction: NonNullable<ChatWidgetModel['compaction']>;
}) {
  const t = useTranslations('RunStatus');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const phase =
    compaction.phase === 'queued' || compaction.phase === 'started' ? compaction.phase : null;
  return (
    <div className="space-y-1 border-t border-line/60 pt-3">
      {compaction.reason ? (
        <p className="text-caption text-muted-foreground">{t(compaction.reason)}</p>
      ) : (
        <>
          <p className="text-caption text-muted-foreground">{t('compactHint')}</p>
          <Button
            variant="tertiary"
            disabled={busy || compaction.pending || phase !== null}
            onClick={() => {
              setBusy(true);
              setError(null);
              void compaction
                .request()
                .then((failure) => setError(failure))
                .finally(() => setBusy(false));
            }}
          >
            {t('compactRequest')}
          </Button>
        </>
      )}
      {compaction.phase ? (
        <p role="status" className="text-caption text-muted-foreground">
          {t(`compactPhase.${compaction.phase}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** ContextInspector: what the presented run's last request held. */
export function ContextDetail({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const tc = useTranslations('Widgets.category');
  const { context } = model;
  const measured = context.tokens != null;
  const complete = context.coverage === 'request' && context.completeness === 'complete';
  // An assembled request needs no sentence: the badge already says it is partial. Nor does one
  // not measured yet: the badge says so.
  const measurementNote =
    complete || context.measurementStage === 'assembled'
      ? null
      : context.completeness === 'error'
        ? t('measurementFailed')
        : measured
          ? t('noPercent')
          : null;
  return (
    <div data-testid="context-inspector" className="flex flex-col gap-4 text-ui">
      <div>
        <div className="flex items-center justify-between gap-3">
          <DetailTitle>{t('context')}</DetailTitle>
          <span className="rounded-md bg-subtle px-2 py-0.5 text-micro text-muted-foreground">
            {complete
              ? t('measurementFull')
              : context.kind === 'messages'
                ? t('measurementMessages')
                : measured
                  ? t('measurementPartial')
                  : t('measurementPending')}
          </span>
        </div>
        <p className="mt-1.5 break-words text-caption text-muted-foreground">
          {[
            model.viewed ? viewedLabel(model.viewed, t) : t('rail'),
            context.roleLabel,
            context.modelLabel,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {context.recordedAt ? (
          <p className="mt-1 text-micro text-muted-foreground">
            {t('lastRequest', {
              time: new Date(context.recordedAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              }),
            })}
          </p>
        ) : null}
      </div>
      {/* Before a measured request the heading and its badge already say so; no line repeats it. */}
      {context.tokens != null ? (
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-caption text-muted-foreground">{t('estimatedInput')}</p>
            <p
              className="mt-1 text-title tabular-nums"
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {number(context.tokens)}
              <span
                className="ml-1.5 text-caption text-muted-foreground"
                style={{ fontVariationSettings: fontWeights.normal }}
              >
                {context.windowTokens
                  ? `/ ${number(context.windowTokens)} ${t('tokens')}`
                  : t('tokens')}
              </span>
            </p>
          </div>
          {context.percent != null ? (
            <span className="flex items-center gap-2 text-body tabular-nums">
              <ContextGauge percent={context.barPercent} size={28} />
              {context.percent}%
            </span>
          ) : null}
        </div>
      ) : null}
      <SegmentBar parts={context.parts} total={complete ? context.windowTokens : context.tokens} />
      <ul className="flex flex-col gap-2">
        {CATEGORIES.map((category) => {
          const part = context.parts.find((item) => item.category === category);
          return (
            <li key={category} className="flex items-start justify-between gap-4 text-caption">
              <span className="flex items-center gap-2">
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-sm ${part ? CATEGORY_FILL[category] : 'bg-line'}`}
                />
                {tc(category)}
              </span>
              <span className="max-w-44 text-right tabular-nums text-muted-foreground">
                {part ? (
                  `${number(part.tokens)}${part.omission ? ` · ${t('measurementPartial')}` : ''}`
                ) : complete ? (
                  t('notInRequest')
                ) : (
                  // The badge says the measurement is partial; each unmeasured row is a dash.
                  <>
                    <span aria-hidden="true">—</span>
                    <span className="sr-only">{t('notMeasured')}</span>
                  </>
                )}
              </span>
            </li>
          );
        })}
        {context.freeTokens != null ? (
          <li className="mt-1 flex justify-between gap-3 border-t border-line/60 pt-2 text-caption text-muted-foreground">
            <span>{t(context.freeTokens < 0 ? 'estimatedOverage' : 'estimatedRemaining')}</span>
            <span className={`tabular-nums ${context.freeTokens < 0 ? 'text-warning' : ''}`}>
              {number(Math.abs(context.freeTokens))}
            </span>
          </li>
        ) : null}
      </ul>
      {model.simulated ||
      context.awaitingRefresh ||
      measurementNote ||
      context.unmeasuredExecutions ||
      context.omissions?.length ||
      model.readState === 'error' ? (
        <div className="space-y-1 rounded-lg bg-subtle px-3 py-2 text-caption text-muted-foreground">
          {model.simulated ? <p>{t('simulatedNote')}</p> : null}
          {context.awaitingRefresh ? <p>{t('contextRefresh')}</p> : null}
          {measurementNote ? <p>{measurementNote}</p> : null}
          {context.unmeasuredExecutions ? (
            <p>{t('unmeasuredExecutions', { count: context.unmeasuredExecutions })}</p>
          ) : null}
          {context.omissions?.length ? (
            <p className="break-words">
              {t('missingCoverage')}:{' '}
              {context.omissions.map((reason) => t(`omission.${reason}`)).join(' · ')}
            </p>
          ) : null}
          {model.readState === 'error' ? (
            <Button variant="tertiary" onClick={model.retryRead}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {model.reserveTokens != null ? (
        <p className="text-caption text-muted-foreground">
          {t('outputReserve', { count: number(model.reserveTokens) })}
        </p>
      ) : null}
      {context.providerInput != null ||
      context.providerCacheRead != null ||
      context.providerOutput != null ? (
        <details className="text-caption text-muted-foreground">
          <summary className="cursor-pointer rounded-sm py-1">{t('providerUsage')}</summary>
          <p className="mt-1 tabular-nums">
            {t('providerNumbers', {
              input: context.providerInput == null ? '—' : number(context.providerInput),
              cache: context.providerCacheRead == null ? '—' : number(context.providerCacheRead),
              output: context.providerOutput == null ? '—' : number(context.providerOutput),
            })}
          </p>
        </details>
      ) : null}
      {model.compaction ? <CompactRequest compaction={model.compaction} /> : null}
      <RunLink
        model={model}
        className="flex items-center justify-between gap-2 border-t border-line/60 pt-3 text-caption text-muted-foreground hover:text-text"
      >
        {t('contextDetails')}
        <ArrowRight size={14} />
      </RunLink>
    </div>
  );
}
export function ContextGauge({ percent, size = 16 }: { percent: number | null; size?: number }) {
  const radius = 7;
  const length = 2 * Math.PI * radius;
  return (
    <svg width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" className="shrink-0">
      <circle cx="10" cy="10" r={radius} fill="none" className="stroke-line" strokeWidth="2.5" />
      {percent != null ? (
        <circle
          cx="10"
          cy="10"
          r={radius}
          fill="none"
          className={percent >= 90 ? 'stroke-warning' : 'stroke-primary'}
          strokeWidth="2.5"
          strokeDasharray={length}
          strokeDashoffset={length * (1 - Math.min(100, Math.max(0, percent)) / 100)}
          strokeLinecap="round"
          transform="rotate(-90 10 10)"
        />
      ) : null}
    </svg>
  );
}
export function SegmentBar({
  parts,
  total,
}: {
  parts: { category: string; tokens: number }[];
  total: number | null;
}) {
  const sum = parts.reduce((value, part) => value + part.tokens, 0);
  if (!sum) return null;
  const denominator = Math.max(sum, total ?? 0);
  return (
    <div className="flex h-2 gap-px overflow-hidden rounded-full bg-line/60" aria-hidden="true">
      {parts
        .filter((part) => part.tokens > 0)
        .map((part) => (
          <span
            key={part.category}
            className={`h-full ${CATEGORY_FILL[part.category] ?? CATEGORY_FILL.other}`}
            style={{ width: `${(part.tokens / denominator) * 100}%` }}
          />
        ))}
    </div>
  );
}
// A run that ended without its result: its plan stays, marked as left where it stopped.
const STOPPED_SHORT = new Set<PresenceKind>(['failed', 'cancelled', 'interrupted']);

/** Agent states and the plan each agent owns. */
export function AgentsDetail({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const ts = usePresenceWord();
  if (!model.agents) return null;
  return (
    <>
      <DetailTitle>{t('agentsHeading')}</DetailTitle>
      <p className="mt-2 text-caption text-muted-foreground">
        {[
          t('agents', model.agents),
          model.agents.waiting ? t('agentsWaiting', { count: model.agents.waiting }) : null,
          model.agents.failed ? t('agentsFailed', { count: model.agents.failed }) : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      {model.plan.choices.length ? (
        <ul className="mt-3 space-y-1">
          {model.plan.choices.map((choice) => (
            <li key={choice.key}>
              <Button
                variant="ghost"
                className="h-auto w-full justify-between gap-2 py-2"
                onClick={() => model.plan.choose(choice.key)}
              >
                <span className="truncate">
                  {choice.key === 'team' ? t('teamPlan') : choice.label}
                </span>
                <span className="text-caption text-muted-foreground">
                  {choice.lastTeam ? t('teamLast') : choice.status ? ts(choice.status) : ''}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <RunLink
        model={model}
        className="mt-3 flex items-center justify-between border-t border-line/60 pt-3 text-caption text-muted-foreground hover:text-text"
      >
        {t('allAgents')}
        <ArrowRight size={14} />
      </RunLink>
    </>
  );
}
export function ChangesChip({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  if (!model.runId) return null;
  const text =
    model.changesLabel === 'error'
      ? t('changesError')
      : model.changeFiles == null
        ? t('changesUnavailable')
        : t('changes', { count: model.changeFiles });
  return (
    <Link
      to="/sessions/$sessionId/review"
      params={{ sessionId: model.sessionId }}
      search={{ scope: 'run', runId: model.runId }}
      data-testid="run-changes-chip"
      // The count is never cut; the line count leaves first when the line is short.
      className={`${chipClass} shrink-0`}
      title={t(model.changesLabel === 'provisional' ? 'changesProvisional' : 'changesFixed')}
    >
      <FileDiff size={14} className="shrink-0" />
      <span className="whitespace-nowrap">{text}</span>
      {model.changeLines ? (
        <span className="whitespace-nowrap text-micro @max-lg/composer-surface:hidden">
          {t('changesLines', { count: model.changeLines })}
        </span>
      ) : null}
    </Link>
  );
}
export function RunLink({
  model,
  executionId,
  respond = false,
  ...props
}: {
  model: ChatWidgetModel;
  executionId?: string;
  /** A request to answer the run: its run page opens the response area. */
  respond?: boolean;
} & ComponentProps<'a'>) {
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: model.sessionId }}
      search={(previous: SessionSearch): SessionSearch => ({
        ...previous,
        ...(previous.run !== model.runId
          ? { execution: undefined, artifact: undefined, result: undefined, message: undefined }
          : {}),
        panel: 'run',
        run: model.runId ?? undefined,
        view: 'run',
        respond: respond || undefined,
        ...(executionId
          ? { execution: executionId, artifact: undefined, result: undefined, atSeq: undefined }
          : {}),
      })}
      resetScroll={false}
      {...props}
    />
  );
}
/** The plan's done count, as the activity bar and its panel say it. */
export function planCount(
  status: ChatWidgetModel['plan']['status'],
  t: ReturnType<typeof useTranslations<'Widgets'>>,
) {
  return 'completed' in status
    ? t(
        status.state === 'ready' && !status.runFinished && status.planFinished
          ? 'planRunning'
          : 'planCount',
        { done: status.completed, total: status.total },
      )
    : status.state === 'loading'
      ? t('planLoading')
      : t('planError');
}

/**
 * What the presented run's state changes say to assistive tech: what waits on the person or
 * went wrong, and the run's state as it changes. Nothing else is announced (composer-flow.md
 * "보안·성능·접근성"): no clock, no count.
 */
export function ActivityAnnouncements({ model }: { model: ChatWidgetModel | null }) {
  const t = useTranslations('Widgets');
  if (!model?.runId) return null;
  return (
    <>
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {model.action.visible ? actionLabel(model, t) : ''}
      </p>
      <RunStatusAnnouncement
        runId={model.runId}
        presence={model.presence ?? null}
        ready={model.readState === 'ready'}
      />
    </>
  );
}

/** What the run needs, in words: the first waiting question by its title, else the kind. */
export function actionLabel(
  model: ChatWidgetModel,
  t: ReturnType<typeof useTranslations<'Widgets'>>,
) {
  return (
    (model.action.summary === 'question' && model.questionNotice) ||
    actionCopy(model.action)
      .map((key) => (key === 'actionMixed' ? t(key, { count: model.action.count }) : t(key)))
      .join(' · ')
  );
}

/**
 * A failure or an unconfirmed outcome no card answers (chat-widgets-contract "컴포저"): the
 * activity bar says it in its warning tone and leads to the run's own place. A failed run is
 * told by its turn while that turn is the latest, and a run that completed with failed steps
 * says so once, beside them.
 */
export function unansweredAttention(model: ChatWidgetModel | null) {
  if (!model?.runId || !model.action.visible || model.action.needsUser) return false;
  return !(
    model.action.summary === 'failure' &&
    (model.action.completedWithFailures || model.viewed?.latest)
  );
}

/** The context in the activity bar's panel: the share of the window, and compaction. */
/** Whether the activity panel has a context section: something measured, or something to do. */
export function activityContextShown(model: ChatWidgetModel | null | undefined): boolean {
  if (!model?.runId) return false;
  const { context, compaction } = model;
  return Boolean(
    context.percent != null ||
      context.tokens != null ||
      compaction?.phase ||
      (compaction && !compaction.reason),
  );
}

/** Whether the activity panel has a plan section: a plan to read, or plans to choose between. */
export function activityPlanShown(model: ChatWidgetModel | null | undefined): boolean {
  if (!model?.runId) return false;
  return model.plan.status.state !== 'hidden' || Boolean(planOwnerChoice(model));
}

/** The plan's owner is chosen on the plan's heading: several plans, a choice made, or one hidden. */
function planOwnerChoice(model: ChatWidgetModel) {
  return (
    model.plan.multiple ||
    !model.plan.auto ||
    (model.plan.status.state === 'hidden' && model.plan.choices.length > 0)
  );
}

export function ActivityContext({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const tr = useTranslations('RunStatus');
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!model.runId) return null;
  const { context, compaction } = model;
  const phase = compaction?.phase ?? null;
  const running = phase === 'queued' || phase === 'started';
  const compactable = Boolean(compaction && !compaction.reason);
  // Nothing measured and nothing to do: no section.
  if (!activityContextShown(model)) return null;
  return (
    <section
      aria-label={t('context')}
      data-testid="activity-context"
      className="flex flex-col gap-1 border-t border-border/60 pt-2.5"
    >
      <div className="flex min-h-7 min-w-0 items-center gap-3 text-caption text-muted-foreground">
        <span className="text-foreground" style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('context')}
        </span>
        {context.percent != null ? (
          <Meter
            value={(context.barPercent ?? context.percent) / 100}
            color={context.percent >= 90 ? 'var(--warning)' : 'var(--emphasis)'}
            label={contextLabel(context, t, locale)}
            className="w-24 shrink-0"
          />
        ) : null}
        <span className="min-w-0 truncate tabular-nums">
          {[
            context.percent != null ? `${context.percent}%` : contextLabel(context, t, locale),
            context.tokens != null
              ? context.windowTokens
                ? `${compactNumber(context.tokens, locale)} / ${compactNumber(context.windowTokens, locale)} ${t('tokens')}`
                : `${compactNumber(context.tokens, locale)} ${t('tokens')}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </span>
        {/* Compaction only where it can be sent: a run with one open execution. */}
        {compaction && !compaction.reason ? (
          <Button
            variant="ghost"
            className="ml-auto shrink-0"
            title={tr('compactHint')}
            disabled={busy || compaction.pending || running}
            onClick={() => {
              setBusy(true);
              setError(null);
              void compaction
                .request()
                .then((failure) => setError(failure))
                .finally(() => setBusy(false));
            }}
          >
            {tr('compactRequest')}
          </Button>
        ) : null}
      </div>
      {phase ? (
        <p role="status" className="text-caption text-muted-foreground">
          {tr(`compactPhase.${phase}`)}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The work plan's Todo. In the composer it is the body the one-line status expands, rendered
 * only while open, read only; the steering shell keeps its own toggle.
 */
/** A bare status whose presence works with no detail beside it. */
function workingAlone(status: string | null | undefined) {
  const presence = status ? statusPresence(status) : null;
  return presence?.kind === 'working' && !presence.detail;
}

export function ComposerPlan({
  variant = 'composer',
  id,
  showAllKey,
  onShowAllKeyChange,
}: {
  variant?: 'composer' | 'steering' | 'activity';
  /** The composer Todo's id, which the line's plan toggle controls. */
  id?: string;
  showAllKey?: string | null;
  onShowAllKeyChange?: (key: string | null) => void;
} = {}) {
  const model = useChatWidget();
  const t = useTranslations('Widgets');
  const ts = usePresenceWord();
  const panelId = useId();
  const [internalAllKey, setInternalAllKey] = useState<string | null>(null);
  const allKey = showAllKey !== undefined ? showAllKey : internalAllKey;
  const setAllKey = (key: string | null) => {
    if (showAllKey === undefined) setInternalAllKey(key);
    onShowAllKeyChange?.(key);
  };
  if (!model?.runId) return null;
  const status = model.plan.status;
  const plan = 'plan' in status ? status.plan : null;
  const selection = model.plan.selectedChoice;
  const key = `${model.runId}:${model.plan.selectedKey}`;
  const showAll = allKey === key;
  const body = (
    <>
      {status.state === 'stale-criteria' || status.state === 'stale-attempt' ? (
        <p className="mb-2 text-caption text-warning">
          {t(status.state === 'stale-attempt' ? 'planOldAttempt' : 'planStale')}
        </p>
      ) : null}
      {selection?.lastTeam ? (
        <p className="mb-2 text-caption text-muted-foreground">{t('teamLast')}</p>
      ) : null}
      {model.plan.runStatus &&
      STOPPED_SHORT.has(statusPresence(model.plan.runStatus)?.kind ?? 'working') ? (
        <p className="mb-2 text-caption text-warning">
          {ts(model.plan.runStatus)} · {t('planPreserved')}
        </p>
      ) : null}
      {status.state === 'loading' ? (
        <p className="py-2 text-caption text-muted-foreground">{t('planLoading')}</p>
      ) : null}
      {status.state === 'error' || status.state === 'mismatch' ? (
        <div className="flex items-center justify-between gap-2 pb-2 text-caption">
          <p className="text-warning">
            {t(status.state === 'mismatch' ? 'planMismatch' : 'planError')}
          </p>
          <Button variant="tertiary" onClick={() => model.plan.retry()}>
            {t('retry')}
          </Button>
        </div>
      ) : null}
      {/* Both places use the kit's plan rows (chat-widgets-contract §4.1): its glyphs, and the
          step in progress marked as the current step. */}
      {plan ? (
        <AgentSteeringPlan
          steps={(showAll ? plan.items : plan.items.slice(0, 5)).map((item) => ({
            id: item.id,
            title: item.title,
            status:
              item.status === 'completed'
                ? 'done'
                : item.status === 'in_progress'
                  ? 'active'
                  : 'pending',
          }))}
          // The plan runs while its Run and its owner both work on their own (presence.md): a
          // detail (waiting for agents or a reply) or any other state is a wait.
          status={
            workingAlone(model.plan.runStatus) && workingAlone(selection?.status)
              ? 'running'
              : 'waiting'
          }
          labels={{ plan: t('planHeading') }}
          statusLabel={(state) =>
            t(state === 'done' ? 'completed' : state === 'active' ? 'in_progress' : 'pending')
          }
          wrapTitles
          // The composer's Todo box has its own inset.
          className={variant !== 'steering' ? 'px-0 pb-0' : undefined}
        />
      ) : null}
      {plan && plan.items.length > 5 ? (
        <Button
          type="button"
          variant="ghost"
          className="ml-6 mt-1 text-muted-foreground"
          onClick={() => setAllKey(showAll ? null : key)}
        >
          {t(showAll ? 'planLess' : 'planAll', { total: plan.items.length })}
        </Button>
      ) : null}
    </>
  );
  const owner = planOwnerChoice(model) ? (
    <Select
      label={t('planOwner')}
      variant={variant === 'activity' ? 'chip' : 'ghost'}
      value={model.plan.auto ? 'auto' : (model.plan.selectedKey ?? 'auto')}
      onValueChange={(value) => (value === 'auto' ? model.plan.follow() : model.plan.choose(value))}
      options={[
        { value: 'auto', label: t('follow') },
        ...model.plan.choices.map((choice) => ({
          value: choice.key,
          label: choice.key === 'team' ? t('teamPlan') : choice.label,
          hint: choice.lastTeam ? t('teamLast') : choice.status ? ts(choice.status) : undefined,
        })),
      ]}
    />
  ) : null;
  // In the activity bar's panel the plan is read as it is, under its heading and count.
  if (variant === 'activity')
    return status.state === 'hidden' && !owner ? null : (
      <section
        aria-label={t('planHeading')}
        data-testid="composer-work-plan"
        className="flex min-w-0 flex-col gap-1"
      >
        <div className="flex min-h-7 min-w-0 items-center gap-2 text-caption text-muted-foreground">
          <span className="text-foreground" style={{ fontVariationSettings: fontWeights.semibold }}>
            {t('planHeading')}
          </span>
          {owner}
          {status.state !== 'hidden' ? (
            <span className="ml-auto shrink-0 tabular-nums">{planCount(status, t)}</span>
          ) : null}
        </div>
        {status.state !== 'hidden' ? (
          <div
            data-testid="work-plan-items"
            className="work-plan-items max-h-[min(16rem,30dvh)] overflow-y-auto overscroll-contain"
          >
            {body}
          </div>
        ) : null}
      </section>
    );
  if (variant === 'composer')
    return status.state === 'hidden' ? null : (
      <div
        id={id}
        hidden={!model.plan.open}
        data-testid={model.plan.open ? 'composer-work-plan' : undefined}
        className="work-plan-disclosure"
      >
        {model.plan.open ? (
          <div
            data-testid="work-plan-items"
            className="work-plan-items mb-2 max-h-[min(16rem,30dvh)] overflow-y-auto overscroll-contain px-2.5"
          >
            {body}
          </div>
        ) : null}
      </div>
    );
  return (
    <div data-testid="composer-work-plan" className="min-w-0">
      {model.plan.multiple ||
      !model.plan.auto ||
      (status.state === 'hidden' && model.plan.choices.length > 0) ? (
        <div className="flex items-center justify-end px-3 pt-2">
          <Select
            label={t('planOwner')}
            variant="ghost"
            value={model.plan.auto ? 'auto' : (model.plan.selectedKey ?? 'auto')}
            onValueChange={(value) =>
              value === 'auto' ? model.plan.follow() : model.plan.choose(value)
            }
            options={[
              { value: 'auto', label: t('follow') },
              ...model.plan.choices.map((choice) => ({
                value: choice.key,
                label: choice.key === 'team' ? t('teamPlan') : choice.label,
                hint: choice.lastTeam
                  ? t('teamLast')
                  : choice.status
                    ? ts(choice.status)
                    : undefined,
              })),
            ]}
          />
        </div>
      ) : null}
      {status.state !== 'hidden' ? (
        <div>
          <Button
            type="button"
            variant="ghost"
            data-testid="work-plan-toggle"
            className="h-auto min-h-10 w-full justify-start gap-2 rounded-none px-4 py-2 text-left text-caption"
            aria-expanded={model.plan.open}
            aria-controls={panelId}
            onClick={() => model.plan.setOpen(!model.plan.open)}
          >
            <ChevronDown
              size={14}
              className={`shrink-0 text-muted-foreground transition-[rotate] duration-(--duration-moderate) ease-(--ease-out-soft) motion-reduce:transition-none ${model.plan.open ? '' : '-rotate-90'}`}
            />
            <span style={{ fontVariationSettings: fontWeights.semibold }}>{t('planHeading')}</span>
            {selection && model.plan.multiple ? (
              <span className="min-w-0 truncate text-muted-foreground">
                {selection.key === 'team' ? t('teamPlan') : selection.label}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
              {planCount(status, t)}
            </span>
          </Button>
          <div id={panelId} hidden={!model.plan.open} className="work-plan-disclosure">
            {model.plan.open ? (
              <div
                data-testid="work-plan-items"
                className="work-plan-items max-h-[min(16rem,30dvh)] overflow-y-auto overscroll-contain pb-2"
              >
                {body}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
