import {
  AgentCard,
  AgentIdentity,
  type AgentStatus,
  AgentStatusLabel,
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardGroup,
  CardHeader,
  CardMedia,
  fontWeights,
  KitCardTitle,
  Meter,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Sparkline,
} from '@corral/react/design-kit';
import {
  ArrowLeft,
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Coins,
  FileDiff,
  FileText,
  LayoutGrid,
  type LucideIcon,
} from '@corral/react/icons';
import { useNavigate } from '@tanstack/react-router';
import { type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { useFormatter, useLocale, useTranslations } from 'use-intl';
import {
  AgentsDetail,
  ContextDetail,
  chipClass,
  compactNumber,
  contextLabel,
  RunLink,
} from './ChatWidgets.tsx';
import {
  actionCopy,
  actionTone,
  type OverviewWidget,
  overviewWidgets,
  type UsageSummary,
} from './selectors.ts';
import { type ChatWidgetModel, useChatWidget } from './useChatWidgets.tsx';

/** Supporting run information stays available on demand at every conversation width. */
export function OverviewAccess() {
  const model = useChatWidget();
  return model?.runId ? <OverviewPopover model={model} /> : null;
}

/** The widgets whose detail opens in Overview's own place. */
export type OverviewDetail = 'context' | 'usage' | 'agents';

/** A single explicit entry to supporting information, without a permanent side column. */
export function OverviewPopover({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const [detail, setDetail] = useState<OverviewDetail | null>(null);
  if (!model.runId) return null;
  return (
    <div className="session-widget-access ml-auto shrink-0 justify-end">
      <Popover
        onOpenChange={(open, change) => {
          if (open) setDetail(null);
          // Escape steps back from a detail to the widgets first; the next one closes Overview.
          else if (detail && change.reason === 'escape-key') {
            change.cancel();
            setDetail(null);
          }
        }}
      >
        <PopoverTrigger data-testid="session-summary-trigger" className={chipClass}>
          <LayoutGrid size={14} aria-hidden="true" />
          {t('overview.heading')}
          <ChevronDown size={12} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverPopup
          data-testid="session-summary-popup"
          align="end"
          side="top"
          width={detail === 'context' ? 'lg' : 'md'}
          padding="none"
        >
          <OverviewWidgets model={model} detail={detail} onDetail={setDetail} />
        </PopoverPopup>
      </Popover>
    </div>
  );
}

/**
 * Kit components for the next useful action, observed work, then supporting resources.
 * A card opens its existing detail in the widgets' own place, one surface at a time; audit
 * detail stays in the Run pane. Inside the popover, the popover owns which detail is open.
 */
export function OverviewWidgets({
  model,
  detail: chosen,
  onDetail,
}: {
  model: ChatWidgetModel;
  detail?: OverviewDetail | null;
  onDetail?: (detail: OverviewDetail | null) => void;
}) {
  const t = useTranslations('Widgets.overview');
  const [own, setOwn] = useState<OverviewDetail | null>(null);
  const choose = onDetail ?? setOwn;
  const wanted = onDetail ? (chosen ?? null) : own;
  // A detail whose figures went away gives its place back to the widgets.
  const detail =
    (wanted === 'usage' && !model.usage) || (wanted === 'agents' && !model.agents) ? null : wanted;
  const section = useRef<HTMLElement>(null);
  const back = useRef<HTMLButtonElement>(null);
  const origin = useRef<OverviewDetail | null>(null);
  // Focus follows the view: into the detail on opening, back to its widget on leaving.
  useLayoutEffect(() => {
    if (detail) {
      origin.current = detail;
      back.current?.focus();
      return;
    }
    const from = origin.current;
    origin.current = null;
    if (from)
      section.current
        ?.querySelector<HTMLElement>(`[data-overview-widget="${from}"] button`)
        ?.focus();
  }, [detail]);
  // Without a run there is no overview to inspect.
  if (!model.runId) return null;
  if (model.readState === 'error')
    return (
      <div role="alert" className="flex flex-col items-start gap-2 p-4 text-body">
        <p>{t('readError')}</p>
        <Button size="compact" variant="secondary" onClick={model.retryRead}>
          {t('retry')}
        </Button>
      </div>
    );
  return (
    <section
      ref={section}
      data-testid="session-summary-card"
      aria-label={t('heading')}
      className="flex flex-col gap-2 p-3"
    >
      {detail ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: Escape from the detail's own controls steps back, as the popover's Escape does.
        <div
          data-overview-detail={detail}
          className="flex flex-col gap-3"
          onKeyDown={
            onDetail
              ? undefined
              : (event) => {
                  if (event.key !== 'Escape' || event.defaultPrevented) return;
                  event.preventDefault();
                  choose(null);
                }
          }
        >
          <Button
            ref={back}
            variant="ghost"
            size="compact"
            className="self-start"
            aria-label={t('back')}
            onClick={() => choose(null)}
          >
            <ArrowLeft aria-hidden="true" />
            {t('heading')}
          </Button>
          {detail === 'context' ? (
            <ContextDetail model={model} />
          ) : detail === 'usage' && model.usage ? (
            <UsageDetail model={model} usage={model.usage} />
          ) : (
            <AgentsDetail model={model} />
          )}
        </div>
      ) : (
        <>
          <p data-testid="overview-run-scope" className="text-caption text-muted-foreground">
            {model.runNumber || model.viewed?.number
              ? t('runScope', { number: model.runNumber ?? model.viewed?.number ?? 0 })
              : t('selectedRun')}
          </p>
          {overviewWidgets(model).map((widget) => (
            <div key={widget} data-overview-widget={widget}>
              <Widget widget={widget} model={model} open={choose} />
            </div>
          ))}
        </>
      )}
    </section>
  );
}

function Widget({
  widget,
  model,
  open,
}: {
  widget: OverviewWidget;
  model: ChatWidgetModel;
  open: (detail: OverviewDetail) => void;
}) {
  if (widget === 'attention') return <AttentionWidget model={model} />;
  if (widget === 'context') return <ContextWidget model={model} open={() => open('context')} />;
  if (widget === 'usage' && model.usage)
    return <UsageWidget usage={model.usage} open={() => open('usage')} />;
  if (widget === 'results') return <ResultsWidget model={model} />;
  if (widget === 'changes') return <ChangesWidget model={model} />;
  if (widget === 'agents') return <AgentsWidget model={model} open={() => open('agents')} />;
  return null;
}

function AttentionWidget({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const label = actionCopy(model.action)
    .map((key) => (key === 'actionMixed' ? t(key, { count: model.action.count }) : t(key)))
    .join(' · ');
  return (
    <Banner status={actionTone(model.action)} size="compact" role="note">
      <BannerTitle>{label}</BannerTitle>
      <BannerActions>
        <Button
          variant="secondary"
          size="compact"
          render={<RunLink model={model} respond={model.action.needsUser} />}
        >
          {t('actionOpen')}
        </Button>
      </BannerActions>
    </Banner>
  );
}

/** The kit title stacks a hidden copy in a grid cell, so the icon row lives inside it. */
function WidgetTitle({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <KitCardTitle className="text-caption text-muted-foreground">
      <span className="inline-flex items-center gap-2">
        <Icon size={14} aria-hidden="true" />
        {children}
      </span>
    </KitCardTitle>
  );
}

/** One widget's frame: an icon and title above its figure. */
function Frame({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <>
      <CardHeader>
        <WidgetTitle icon={Icon}>{title}</WidgetTitle>
        <CardAction aria-hidden="true" className="text-muted-foreground">
          <ChevronRight size={14} />
        </CardAction>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </>
  );
}

function Figure({ value, unit }: { value: ReactNode; unit?: ReactNode }) {
  return (
    <p className="flex items-baseline gap-1.5">
      <span
        className="text-body tabular-nums text-foreground"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {value}
      </span>
      {unit ? <span className="text-caption text-muted-foreground">{unit}</span> : null}
    </p>
  );
}

function ContextWidget({ model, open }: { model: ChatWidgetModel; open: () => void }) {
  const t = useTranslations('Widgets.overview');
  const tw = useTranslations('Widgets');
  const locale = useLocale();
  const { context } = model;
  const summary = contextLabel(context, tw, locale);
  const complete = context.coverage === 'request' && context.completeness === 'complete';
  const meterValue =
    complete &&
    context.tokens != null &&
    context.tokens >= 0 &&
    Number.isFinite(context.tokens) &&
    context.windowTokens != null &&
    Number.isFinite(context.windowTokens) &&
    context.windowTokens > 0
      ? context.tokens / context.windowTokens
      : null;
  const value =
    context.percent != null
      ? `${context.percent}%`
      : context.tokens != null
        ? compactNumber(context.tokens, locale)
        : null;
  return (
    <Card
      size="compact"
      data-testid="context-usage-chip"
      label={t('openDetail', { name: t('context') })}
      onClick={open}
    >
      <Frame icon={Brain} title={t('context')}>
        <span className="sr-only">{summary}</span>
        {value ? (
          <Figure
            value={value}
            unit={
              context.tokens != null && context.windowTokens
                ? `${compactNumber(context.tokens, locale)} / ${compactNumber(context.windowTokens, locale)}`
                : context.percent == null
                  ? tw('tokens')
                  : null
            }
          />
        ) : (
          <p aria-hidden="true" className="text-body text-muted-foreground">
            {summary}
          </p>
        )}
        {meterValue != null && <Meter className="mt-2" value={meterValue} label={summary} />}
      </Frame>
    </Card>
  );
}

function UsageWidget({ usage, open }: { usage: UsageSummary; open: () => void }) {
  const t = useTranslations('Widgets.overview');
  const format = useFormatter();
  return (
    <Card size="compact" label={t('openDetail', { name: t('usage') })} onClick={open}>
      <Frame icon={Coins} title={t('usage')}>
        <div className="flex items-end justify-between gap-3">
          <div className="min-w-0">
            <Figure value={format.number(usage.outputTokens)} unit={t('outputTokens')} />
            <p className="mt-0.5 text-caption text-muted-foreground">
              {t('calls', { used: usage.requests })}
            </p>
          </div>
          <CallSparkline values={usage.perCall} />
        </div>
        {usage.unknown > 0 ? (
          <p className="mt-2 text-caption text-warning">
            {t('unknownUsage', { count: usage.unknown })}
          </p>
        ) : null}
      </Frame>
    </Card>
  );
}

/** Output tokens per finished model call; the numbers are also read out. */
function CallSparkline({ values }: { values: number[] }) {
  const t = useTranslations('Widgets.overview');
  if (values.length < 2) return null;
  return (
    <div className="shrink-0" data-testid="usage-sparkline">
      <span className="sr-only">{t('perCall', { values: values.join(', ') })}</span>
      <Sparkline values={values} width={64} height={24} area={false} />
    </div>
  );
}

function UsageDetail({ model, usage }: { model: ChatWidgetModel; usage: UsageSummary }) {
  const t = useTranslations('Widgets.overview');
  const tb = useTranslations('Usage');
  const format = useFormatter();
  const cost = model.cost;
  const costLines = cost
    ? [
        cost.pricedCalls > 0
          ? tb('costEstimate', {
              usd: format.number(cost.usd, {
                style: 'currency',
                currency: 'USD',
                maximumFractionDigits: cost.usd < 1 ? 4 : 2,
              }),
            })
          : null,
        cost.subscriptionCalls > 0 ? tb('costSubscription') : null,
        cost.unknownCalls > 0 ? tb('costUnknown', { count: cost.unknownCalls }) : null,
      ].filter((line): line is string => Boolean(line))
    : [];
  const rows: [string, string][] = [
    [t('spent'), format.number(usage.outputTokens)],
    [t('modelCalls'), String(usage.requests)],
    ...(usage.input
      ? ([
          [t('inputTokens'), format.number(usage.input.tokens)],
          [
            t('cachedInput'),
            usage.input.cached == null
              ? t('cacheNotReported')
              : usage.input.cacheShare == null
                ? format.number(usage.input.cached)
                : t('cachedShare', {
                    tokens: format.number(usage.input.cached),
                    share: format.number(usage.input.cacheShare, {
                      style: 'percent',
                      maximumFractionDigits: 0,
                    }),
                  }),
          ],
        ] as [string, string][])
      : []),
  ];
  return (
    <div data-testid="usage-detail" className="flex flex-col gap-3 text-body">
      <p style={{ fontVariationSettings: fontWeights.semibold }}>{t('usage')}</p>
      <p className="text-caption text-muted-foreground">{t('usageDefinition')}</p>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {usage.inputUnreported > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('inputUnreported', { count: usage.inputUnreported })}
        </p>
      ) : null}
      {model.simulated ? (
        <p className="text-caption text-muted-foreground">{t('simulatedUsage')}</p>
      ) : null}
      {usage.unknown > 0 ? (
        <p className="text-caption text-warning">{t('unknownUsage', { count: usage.unknown })}</p>
      ) : null}
      {usage.input && usage.input.cached != null && usage.input.cacheUnreported > 0 ? (
        <p className="text-caption text-muted-foreground">
          {t('cacheUnreported', { count: usage.input.cacheUnreported })}
        </p>
      ) : null}
      {costLines.length || cost?.simulated ? (
        <p className="text-caption text-muted-foreground">
          {(costLines.length ? costLines : [tb('costSimulated')]).join(' · ')}
        </p>
      ) : null}
      <Button size="compact" variant="secondary" render={<RunLink model={model} />}>
        {t('openRun')}
      </Button>
    </div>
  );
}

function ResultsWidget({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets.overview');
  const navigate = useNavigate();
  return (
    <section aria-label={t('results')}>
      <h3 className="px-3 pt-1 text-caption text-muted-foreground">
        {t('results')} · {model.results.length}
      </h3>
      <CardGroup orientation="inline">
        {model.results.map((result) => (
          <Card
            key={result.id}
            size="compact"
            label={result.label}
            onClick={() =>
              void navigate({
                to: '/sessions/$sessionId',
                params: { sessionId: model.sessionId },
                search: {
                  panel: 'run',
                  run: model.runId ?? undefined,
                  view: 'results',
                  result: result.id,
                },
              })
            }
          >
            <CardMedia icon={FileText} />
            <CardHeader>
              {/* An inline title is trimmed to its baseline; unclipped, it keeps its descenders
                  and wraps a long name instead of cutting it (as Needs you does). */}
              <KitCardTitle className="[&>span]:overflow-visible">{result.label}</KitCardTitle>
              <CardAction aria-hidden="true">
                <ChevronRight size={14} />
              </CardAction>
            </CardHeader>
          </Card>
        ))}
      </CardGroup>
    </section>
  );
}

function ChangesWidget({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets.overview');
  const tw = useTranslations('Widgets');
  const format = useFormatter();
  const navigate = useNavigate();
  const counted = model.changeAdditions != null && model.changeDeletions != null;
  return (
    <CardGroup orientation="inline">
      <Card
        size="compact"
        label={t('openChanges')}
        onClick={() =>
          void navigate({
            to: '/sessions/$sessionId/review',
            params: { sessionId: model.sessionId },
            search: { scope: 'run', runId: model.runId ?? undefined },
          })
        }
      >
        <CardMedia icon={FileDiff} />
        <CardHeader>
          <KitCardTitle className="[&>span]:overflow-visible">{t('changes')}</KitCardTitle>
          <CardDescription>
            {model.changesLabel === 'error' ? (
              <span className="text-body text-muted-foreground">{tw('changesError')}</span>
            ) : model.changeFiles == null ? (
              <span className="text-body text-muted-foreground">{tw('changesUnavailable')}</span>
            ) : (
              <span className="flex flex-wrap items-baseline gap-x-2">
                {counted ? (
                  <>
                    <span
                      className="tabular-nums text-success"
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      +{format.number(model.changeAdditions ?? 0)}
                    </span>
                    <span
                      className="tabular-nums text-destructive"
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      −{format.number(model.changeDeletions ?? 0)}
                    </span>
                  </>
                ) : (
                  <span className="text-caption text-muted-foreground">{t('linesUnknown')}</span>
                )}
                <span className="text-caption text-muted-foreground">
                  {t('files', { count: model.changeFiles })}
                </span>
              </span>
            )}
          </CardDescription>
          <CardAction aria-hidden="true">
            <ChevronRight size={14} />
          </CardAction>
        </CardHeader>
      </Card>
    </CardGroup>
  );
}

function AgentsWidget({ model, open }: { model: ChatWidgetModel; open: () => void }) {
  const t = useTranslations('Widgets.overview');
  const tw = useTranslations('Widgets');
  const status = useTranslations('Status');
  if (!model.agents) return null;
  const counts = [
    tw('agents', model.agents),
    tw('agentsWaiting', { count: model.agents.waiting }),
    tw('agentsFailed', { count: model.agents.failed }),
  ].join(' · ');
  const rows = model.agentRows ?? [];
  const allStopped =
    rows.length > 0 &&
    rows.every((row) => ['cancelled', 'cancelling', 'paused', 'pausing'].includes(row.status));
  const summaryStatus: AgentStatus =
    model.agents.failed > 0
      ? 'failed'
      : model.agents.waiting > 0
        ? 'waiting'
        : model.agents.working > 0
          ? 'running'
          : allStopped
            ? 'stopped'
            : 'done';
  const active = rows.filter((row) => !['succeeded', 'failed', 'cancelled'].includes(row.status));
  const visible = (active.length ? active : rows).slice(0, 2);
  return (
    <AgentCard className="grid gap-3 p-3">
      <Button
        data-testid="agent-activity-chip"
        size="compact"
        variant="ghost"
        aria-label={t('openDetail', { name: t('agents') })}
        onClick={open}
      >
        <Bot size={14} aria-hidden="true" />
        {t('agents')}
        <ChevronRight size={14} aria-hidden="true" />
      </Button>
      {model.live ? (
        visible.map((row) => (
          <AgentIdentity
            key={row.id}
            name={row.name}
            model={
              <AgentStatusLabel
                status={agentStatus(row.status)}
                label={status.has(row.status) ? status(row.status) : row.status}
              />
            }
          />
        ))
      ) : (
        <AgentStatusLabel status={summaryStatus} label={tw('agents', model.agents)} />
      )}
      <p className="text-caption text-muted-foreground">
        {model.live
          ? counts
          : [
              tw('agentsWaiting', { count: model.agents.waiting }),
              tw('agentsFailed', { count: model.agents.failed }),
            ].join(' · ')}
      </p>
    </AgentCard>
  );
}

function agentStatus(status: string): AgentStatus {
  if (status === 'queued' || status === 'ready') return 'queued';
  if (status === 'active') return 'running';
  if (status === 'succeeded') return 'done';
  if (status === 'failed') return 'failed';
  if (['cancelled', 'cancelling', 'paused', 'pausing'].includes(status)) return 'stopped';
  return 'waiting';
}
