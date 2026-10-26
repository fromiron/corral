import {
  Button,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  KitCardTitle,
  Popover,
  PopoverPopup,
  PopoverTrigger,
} from '@corral/react/design-kit';
import {
  Bot,
  Brain,
  ChevronDown,
  ChevronRight,
  Coins,
  FileDiff,
  FileText,
  LayoutGrid,
  type LucideIcon,
  Monitor,
} from '@corral/react/icons';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ReactElement, ReactNode } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import {
  AgentsDetail,
  ContextDetail,
  chipClass,
  compactNumber,
  contextLabel,
  EnvironmentDetail,
  RunLink,
  SegmentBar,
} from './ChatWidgets.tsx';
import { type OverviewWidget, overviewWidgets, type UsageSummary } from './selectors.ts';
import { type ChatWidgetModel, useChatWidget } from './useChatWidgets.tsx';

/** The column beside the conversation: the presented run's widgets. */
export function OverviewPanel() {
  const model = useChatWidget();
  return model ? <OverviewWidgets model={model} /> : null;
}

/**
 * Where the side area is too narrow or hidden, the composer opens the same widgets in a popover;
 * the CSS in index.css decides when this trigger shows.
 */
export function OverviewAccess() {
  const model = useChatWidget();
  const t = useTranslations('Widgets');
  if (!model?.runId) return null;
  return (
    <div className="session-widget-access ml-auto justify-end">
      <Popover>
        <PopoverTrigger data-testid="session-summary-trigger" className={chipClass}>
          <LayoutGrid size={14} aria-hidden="true" />
          {t('overview.heading')}
          <ChevronDown size={12} aria-hidden="true" />
        </PopoverTrigger>
        <PopoverPopup
          data-testid="session-summary-popup"
          align="end"
          side="top"
          width="md"
          padding="none"
          className="rounded-2xl"
        >
          <OverviewWidgets model={model} />
        </PopoverPopup>
      </Popover>
    </div>
  );
}

/**
 * Kit cards for what a turn did, in a fixed order, each only when it has something to say.
 * A card opens its existing detail in place; audit detail stays in the Run pane.
 */
export function OverviewWidgets({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets.overview');
  // Without a run the column stays empty, and index.css hides it.
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
      data-testid="session-summary-card"
      aria-label={t('heading')}
      className="flex flex-col gap-2 p-3"
    >
      {overviewWidgets(model).map((widget) => (
        <div key={widget} data-overview-widget={widget}>
          <Widget widget={widget} model={model} />
        </div>
      ))}
    </section>
  );
}

function Widget({ widget, model }: { widget: OverviewWidget; model: ChatWidgetModel }) {
  if (widget === 'context') return <ContextWidget model={model} />;
  if (widget === 'usage' && model.usage) return <UsageWidget model={model} usage={model.usage} />;
  if (widget === 'results') return <ResultsWidget model={model} />;
  if (widget === 'changes') return <ChangesWidget model={model} />;
  if (widget === 'agents') return <AgentsWidget model={model} />;
  if (widget === 'environment') return <EnvironmentWidget model={model} />;
  return null;
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

const cardClass =
  'cursor-pointer border border-border/60 bg-card text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none';
// The trigger wraps a kit card: Card keeps `onClick` for its own stretched overlay.
const triggerClass =
  'cursor-pointer rounded-xl bg-card text-left outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none';

/** The widget opens its detail in place; focus returns to the widget when the detail closes. */
function DetailWidget({
  testId,
  label,
  card,
  detail,
  width = 'md',
}: {
  testId?: string;
  label: string;
  card: ReactNode;
  detail: ReactNode;
  width?: 'md' | 'lg';
}) {
  return (
    <Popover>
      <PopoverTrigger
        nativeButton={false}
        data-testid={testId}
        aria-label={label}
        render={(<div className={triggerClass} />) as ReactElement}
      >
        <Card size="compact" className="border border-border/60 bg-transparent">
          {card}
        </Card>
      </PopoverTrigger>
      <PopoverPopup align="end" side="left" width={width}>
        {detail}
      </PopoverPopup>
    </Popover>
  );
}

function Figure({ value, unit }: { value: ReactNode; unit?: ReactNode }) {
  return (
    <p className="flex items-baseline gap-1.5">
      <span className="text-title font-medium tabular-nums text-foreground">{value}</span>
      {unit ? <span className="text-caption text-muted-foreground">{unit}</span> : null}
    </p>
  );
}

function ContextWidget({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets.overview');
  const tw = useTranslations('Widgets');
  const { context } = model;
  const summary = contextLabel(context, tw);
  const complete = context.coverage === 'request' && context.completeness === 'complete';
  const value =
    context.percent != null
      ? `${context.percent}%`
      : context.tokens != null
        ? compactNumber(context.tokens)
        : null;
  return (
    <DetailWidget
      testId="context-usage-chip"
      label={t('openDetail', { name: t('context') })}
      width="lg"
      card={
        <Frame icon={Brain} title={t('context')}>
          <span className="sr-only">{summary}</span>
          {value ? (
            <Figure
              value={value}
              unit={
                context.tokens != null && context.windowTokens
                  ? `${compactNumber(context.tokens)} / ${compactNumber(context.windowTokens)}`
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
          <div className="mt-2">
            <SegmentBar
              parts={context.parts}
              total={complete ? context.windowTokens : context.tokens}
            />
          </div>
        </Frame>
      }
      detail={<ContextDetail model={model} />}
    />
  );
}

function UsageWidget({ model, usage }: { model: ChatWidgetModel; usage: UsageSummary }) {
  const t = useTranslations('Widgets.overview');
  const format = useFormatter();
  const calls =
    usage.callLimit == null
      ? t('callsNoLimit', { used: usage.calls })
      : t('calls', { used: usage.calls, max: usage.callLimit });
  return (
    <DetailWidget
      label={t('openDetail', { name: t('usage') })}
      card={
        <Frame icon={Coins} title={t('usage')}>
          <div className="flex items-end justify-between gap-3">
            <div className="min-w-0">
              <Figure value={format.number(usage.spent)} unit={t('outputTokens')} />
              <p className="mt-0.5 text-caption text-muted-foreground">
                {[
                  calls,
                  usage.tokenLimit == null
                    ? null
                    : t('tokenLimit', { max: format.number(usage.tokenLimit) }),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
            </div>
            <CallBars values={usage.perCall} />
          </div>
          {usage.unknown > 0 ? (
            <p className="mt-2 text-caption text-warning">
              {t('unknownHeld', { count: format.number(usage.unknown) })}
            </p>
          ) : null}
        </Frame>
      }
      detail={<UsageDetail model={model} usage={usage} />}
    />
  );
}

/** Output tokens per finished model call; the numbers are also read out. */
function CallBars({ values }: { values: number[] }) {
  const t = useTranslations('Widgets.overview');
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  return (
    <div className="shrink-0">
      <span className="sr-only">{t('perCall', { values: values.join(', ') })}</span>
      <div aria-hidden="true" className="flex h-9 items-end gap-[3px]">
        {values.map((value, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: Bars are positional; equal values repeat.
            key={index}
            className="w-1.5 rounded-sm bg-info/80"
            style={{ height: `${Math.max(8, (value / max) * 100)}%` }}
          />
        ))}
      </div>
    </div>
  );
}

function UsageDetail({ model, usage }: { model: ChatWidgetModel; usage: UsageSummary }) {
  const t = useTranslations('Widgets.overview');
  const tb = useTranslations('Budget');
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
    [t('spent'), format.number(usage.spent)],
    [t('held'), format.number(usage.reserved + usage.unknown)],
    [t('limit'), usage.tokenLimit == null ? t('noLimit') : format.number(usage.tokenLimit)],
    [
      t('modelCalls'),
      usage.callLimit == null ? String(usage.calls) : `${usage.calls} / ${usage.callLimit}`,
    ],
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
      <p className="font-medium">{t('usage')}</p>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
        {rows.map(([name, value]) => (
          <div key={name} className="contents">
            <dt className="text-muted-foreground">{name}</dt>
            <dd className="text-right tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {usage.unknown > 0 ? (
        <p className="text-caption text-warning">
          {t('unknownHeld', { count: format.number(usage.unknown) })}
        </p>
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
        {t('fullBudget')}
      </Button>
    </div>
  );
}

function ResultsWidget({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets.overview');
  return (
    <Card size="compact" className="border border-border/60 bg-card">
      <CardHeader>
        <WidgetTitle icon={FileText}>
          {t('results')} {model.results.length}
        </WidgetTitle>
      </CardHeader>
      <CardContent>
        <ul className="-mx-2 flex flex-col">
          {model.results.map((result) => (
            <li key={result.id}>
              <Button
                variant="ghost"
                size="compact"
                className="w-full justify-start"
                render={
                  <Link
                    to="/sessions/$sessionId"
                    params={{ sessionId: model.sessionId }}
                    search={{
                      panel: 'run',
                      run: model.runId ?? undefined,
                      view: 'results',
                      result: result.id,
                    }}
                  />
                }
              >
                <span className="truncate">{result.label}</span>
              </Button>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function ChangesWidget({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets.overview');
  const tw = useTranslations('Widgets');
  const format = useFormatter();
  const navigate = useNavigate();
  const counted = model.changeAdditions != null && model.changeDeletions != null;
  return (
    <Card
      size="compact"
      className={cardClass}
      label={t('openChanges')}
      onClick={() =>
        void navigate({
          to: '/sessions/$sessionId/review',
          params: { sessionId: model.sessionId },
          search: { scope: 'run', runId: model.runId ?? undefined },
        })
      }
    >
      <Frame icon={FileDiff} title={t('changes')}>
        {model.changesLabel === 'error' ? (
          <p className="text-body text-muted-foreground">{tw('changesError')}</p>
        ) : model.changeFiles == null ? (
          <p className="text-body text-muted-foreground">{tw('changesUnavailable')}</p>
        ) : (
          <p className="flex flex-wrap items-baseline gap-x-2">
            {counted ? (
              <>
                <span className="text-title font-medium tabular-nums text-success">
                  +{format.number(model.changeAdditions ?? 0)}
                </span>
                <span className="text-title font-medium tabular-nums text-destructive">
                  −{format.number(model.changeDeletions ?? 0)}
                </span>
              </>
            ) : (
              <span className="text-caption text-muted-foreground">{t('linesUnknown')}</span>
            )}
            <span className="text-caption text-muted-foreground">
              {t('files', { count: model.changeFiles })}
            </span>
          </p>
        )}
      </Frame>
    </Card>
  );
}

function AgentsWidget({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets.overview');
  const tw = useTranslations('Widgets');
  if (!model.agents) return null;
  return (
    <DetailWidget
      testId="agent-activity-chip"
      label={t('openDetail', { name: t('agents') })}
      card={
        <Frame icon={Bot} title={t('agents')}>
          <Figure value={model.agents.total} unit={tw('agents', model.agents)} />
          <p className="mt-0.5 text-caption text-muted-foreground">
            {[
              tw('agentsWaiting', { count: model.agents.waiting }),
              tw('agentsFailed', { count: model.agents.failed }),
            ].join(' · ')}
          </p>
        </Frame>
      }
      detail={<AgentsDetail model={model} />}
    />
  );
}

function EnvironmentWidget({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets.overview');
  const tw = useTranslations('Widgets');
  return (
    <DetailWidget
      testId="environment-chip"
      label={t('openDetail', { name: t('environment') })}
      card={
        <Frame icon={Monitor} title={t('environment')}>
          <p className="text-body">
            {tw(
              model.environment === 'simulated' ? 'environmentSimulated' : 'environmentRestricted',
            )}
          </p>
        </Frame>
      }
      detail={<EnvironmentDetail model={model} />}
    />
  );
}
