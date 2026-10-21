import { RunActions } from '@corral/react';
import {
  ArrowRight,
  Bot,
  ChevronDown,
  Circle,
  CircleAlert,
  CircleCheck,
  FileDiff,
  History,
  LoaderCircle,
  Monitor,
} from '@corral/react/icons';
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
  Select,
} from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { type ReactNode, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useServices } from '../../services.tsx';
import type { WidgetChip } from './selectors.ts';
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
  messages: 'bg-accent',
  system_prompt: 'bg-accent/65',
  system_tools: 'bg-muted',
  mcp_tools: 'bg-muted/65',
  skills: 'bg-success',
  memory_files: 'bg-warning',
  instructions: 'bg-text/75',
  other: 'bg-text/45',
};
const chipClass =
  'inline-flex h-8 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-ring';
const number = (value: number) => value.toLocaleString();
const compactNumber = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k` : number(value);

/** The reference places contextual widgets in an upper-right companion card. */
export function SessionWidgetCard() {
  const model = useChatWidget();
  const t = useTranslations('Widgets');
  const ts = useTranslations('Status');
  if (!model?.runId) return null;
  return (
    <section
      data-testid="session-summary-card"
      aria-label={t('summaryHeading')}
      className="session-summary-card min-w-0 rounded-2xl bg-raised p-4"
    >
      <div className="mb-4 flex items-center gap-3">
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-subtle text-muted"
          aria-hidden="true"
        >
          <Bot size={22} />
        </span>
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t('summaryHeading')}</h3>
          <p className="mt-1 truncate text-xs text-muted">
            {model.lastRun
              ? t('lastRun')
              : model.plan.runStatus
                ? ts(model.plan.runStatus)
                : t('rail')}
          </p>
        </div>
      </div>
      <RunLink
        model={model}
        className="mb-4 flex min-h-8 items-center justify-center gap-2 rounded-lg bg-subtle px-3 text-xs hover:bg-line/50 focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('openExecution')}
        <ArrowRight size={13} />
      </RunLink>
      <div className="space-y-1">
        {model.chips.map((chip) => (
          <Chip key={chip} chip={chip} model={model} />
        ))}
      </div>
      {model.tools.length ? (
        <div className="mt-5">
          <h4 className="mb-1.5 text-xs text-muted">{t('activityHeading')}</h4>
          <ul className="space-y-1">
            {model.tools.slice(-3).map((tool) => (
              <li key={tool.id} className="flex min-h-7 items-center gap-2 text-xs">
                {tool.tone === 'ok' ? (
                  <CircleCheck size={13} className="shrink-0 text-muted" />
                ) : tool.tone === 'running' ? (
                  <LoaderCircle
                    size={13}
                    className="shrink-0 text-muted motion-safe:animate-spin"
                  />
                ) : (
                  <CircleAlert size={13} className="shrink-0 text-warning" />
                )}
                <span className="min-w-0 flex-1 truncate" title={tool.name}>
                  {tool.name}
                </span>
                <span className="text-2xs text-muted">{t(`tool.${tool.tone}`)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {model.results.length ? (
        <div className="mt-5">
          <h4 className="mb-1.5 text-xs text-muted">{t('resultsHeading')}</h4>
          <ul className="space-y-1">
            {model.results.slice(0, 3).map((result) => (
              <li key={result.id}>
                <Link
                  to="/sessions/$sessionId"
                  params={{ sessionId: model.sessionId }}
                  search={{
                    panel: 'run',
                    run: model.runId ?? undefined,
                    view: 'results',
                    result: result.id,
                  }}
                  className="flex min-h-7 items-center gap-2 rounded text-xs hover:bg-subtle focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FileDiff size={13} className="shrink-0 text-muted" />
                  <span className="truncate">{result.label}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/** At narrow widths or while inspecting details, keep the same summary reachable. */
function SessionWidgetAccess() {
  const model = useChatWidget();
  const t = useTranslations('Widgets');
  if (!model?.runId) return null;
  return (
    <div className="session-widget-access mb-2 justify-end">
      <Popover>
        <PopoverTrigger data-testid="session-summary-trigger" className={chipClass}>
          <Bot size={14} />
          {t('summaryHeading')}
          <ChevronDown size={12} />
        </PopoverTrigger>
        <PopoverPopup
          data-testid="session-summary-popup"
          align="end"
          side="top"
          width="md"
          padding="none"
          className="rounded-2xl"
        >
          <SessionWidgetCard />
        </PopoverPopup>
      </Popover>
    </div>
  );
}
function Chip({ chip, model }: { chip: WidgetChip; model: ChatWidgetModel }) {
  if (chip === 'context') return <ContextUsageChip model={model} />;
  if (chip === 'agents' && model.agents) return <AgentChip model={model} />;
  if (chip === 'changes') return <ChangesChip model={model} />;
  if (chip === 'environment' && model.environment) return <EnvironmentChip model={model} />;
  return null;
}

function ContextUsageChip({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const tc = useTranslations('Widgets.category');
  const { context } = model;
  const label =
    context.kind === 'messages' && context.tokens != null
      ? t('contextMessages', { count: compactNumber(context.tokens) })
      : context.percent != null
        ? t('contextPercent', { percent: context.percent })
        : context.completeness === 'error'
          ? t('contextError')
          : context.kind === 'partial'
            ? t('contextPartial')
            : t('contextPending');
  const measured = context.tokens != null;
  const complete = context.coverage === 'request' && context.completeness === 'complete';
  return (
    <Popover>
      <PopoverTrigger data-testid="context-usage-chip" className={chipClass}>
        <ContextGauge percent={context.barPercent} />
        <span className="truncate">{label}</span>
        <ChevronDown size={12} />
      </PopoverTrigger>
      <PopoverPopup align="start" width="lg">
        <div data-testid="context-inspector" className="flex flex-col gap-4 text-ui">
          <div>
            <div className="flex items-center justify-between gap-3">
              <PopoverTitle>{t('context')}</PopoverTitle>
              <span className="rounded-md bg-subtle px-2 py-0.5 text-2xs text-muted">
                {complete
                  ? t('measurementFull')
                  : context.kind === 'messages'
                    ? t('measurementMessages')
                    : measured
                      ? t('measurementPartial')
                      : t('measurementPending')}
              </span>
            </div>
            <p className="mt-1.5 break-words text-xs text-muted">
              {[model.lastRun ? t('lastRun') : t('rail'), context.roleLabel, context.modelLabel]
                .filter(Boolean)
                .join(' · ')}
            </p>
            {context.recordedAt ? (
              <p className="mt-1 text-2xs text-muted">
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
          <div className="flex items-center justify-between gap-4">
            <div>
              <p className="text-xs text-muted">
                {t(measured ? 'estimatedInput' : 'contextPending')}
              </p>
              {context.tokens != null ? (
                <p className="mt-1 text-lg font-medium tabular-nums">
                  {number(context.tokens)}
                  <span className="ml-1.5 text-xs font-normal text-muted">
                    {context.windowTokens
                      ? `/ ${number(context.windowTokens)} ${t('tokens')}`
                      : t('tokens')}
                  </span>
                </p>
              ) : null}
            </div>
            {context.percent != null ? (
              <span className="flex items-center gap-2 text-sm tabular-nums">
                <ContextGauge percent={context.barPercent} size={28} />
                {context.percent}%
              </span>
            ) : null}
          </div>
          <SegmentBar
            parts={context.parts}
            total={complete ? context.windowTokens : context.tokens}
          />
          <ul className="flex flex-col gap-2">
            {CATEGORIES.map((category) => {
              const part = context.parts.find((item) => item.category === category);
              return (
                <li key={category} className="flex items-start justify-between gap-4 text-xs">
                  <span className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className={`size-2 shrink-0 rounded-sm ${part ? CATEGORY_FILL[category] : 'bg-line'}`}
                    />
                    {tc(category)}
                  </span>
                  <span className="max-w-44 text-right tabular-nums text-muted">
                    {part
                      ? `${number(part.tokens)}${part.omission ? ` · ${t('measurementPartial')}` : ''}`
                      : t(complete ? 'notInRequest' : 'notMeasured')}
                  </span>
                </li>
              );
            })}
            {context.freeTokens != null ? (
              <li className="mt-1 flex justify-between gap-3 border-t border-line/60 pt-2 text-xs text-muted">
                <span>{t(context.freeTokens < 0 ? 'estimatedOverage' : 'estimatedRemaining')}</span>
                <span className={`tabular-nums ${context.freeTokens < 0 ? 'text-warning' : ''}`}>
                  {number(Math.abs(context.freeTokens))}
                </span>
              </li>
            ) : null}
          </ul>
          {model.simulated || !complete || context.awaitingRefresh || context.kind === 'highest' ? (
            <div className="space-y-1 rounded-lg bg-subtle px-3 py-2 text-xs text-muted">
              {model.simulated ? <p>{t('simulatedNote')}</p> : null}
              {context.awaitingRefresh ? <p>{t('contextRefresh')}</p> : null}
              {!complete ? (
                <p>
                  {context.measurementStage === 'assembled'
                    ? t('measurementAssembled')
                    : context.completeness === 'error'
                      ? t('measurementFailed')
                      : measured
                        ? t('noPercent')
                        : t('measurementWaiting')}
                </p>
              ) : null}
              {context.kind === 'highest' ? <p>{t('highestContext')}</p> : null}
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
                <Button size="xs" variant="outline" onClick={model.retryRead}>
                  {t('retry')}
                </Button>
              ) : null}
            </div>
          ) : null}
          {model.reserveTokens != null ? (
            <p className="text-xs text-muted">
              {t('outputReserve', { count: number(model.reserveTokens) })}
            </p>
          ) : null}
          {context.providerInput != null ||
          context.providerCacheRead != null ||
          context.providerOutput != null ? (
            <details className="text-xs text-muted">
              <summary className="cursor-pointer rounded-sm py-1 focus-visible:ring-2 focus-visible:ring-ring">
                {t('providerUsage')}
              </summary>
              <p className="mt-1">{t('providerSeparate')}</p>
              <p className="mt-1 tabular-nums">
                {t('providerNumbers', {
                  input: context.providerInput == null ? '—' : number(context.providerInput),
                  cache:
                    context.providerCacheRead == null ? '—' : number(context.providerCacheRead),
                  output: context.providerOutput == null ? '—' : number(context.providerOutput),
                })}
              </p>
            </details>
          ) : null}
          <RunLink
            model={model}
            className="flex items-center justify-between gap-2 border-t border-line/60 pt-3 text-xs text-muted hover:text-text"
          >
            {t('contextDetails')}
            <ArrowRight size={14} />
          </RunLink>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
function ContextGauge({ percent, size = 16 }: { percent: number | null; size?: number }) {
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
          className={percent >= 90 ? 'stroke-warning' : 'stroke-accent'}
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
function SegmentBar({
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
function AgentChip({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const ts = useTranslations('Status');
  if (!model.agents) return null;
  return (
    <Popover>
      <PopoverTrigger data-testid="agent-activity-chip" className={chipClass}>
        <Bot size={14} />
        <span className="truncate">{t('agents', model.agents)}</span>
        <ChevronDown size={12} />
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <PopoverTitle>{t('agentsHeading')}</PopoverTitle>
        <p className="mt-2 text-xs text-muted">
          {[
            t('agents', model.agents),
            t('agentsWaiting', { count: model.agents.waiting }),
            t('agentsFailed', { count: model.agents.failed }),
          ].join(' · ')}
        </p>
        {model.plan.choices.length ? (
          <ul className="mt-3 space-y-1">
            {model.plan.choices.map((choice) => (
              <li key={choice.key}>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-auto w-full justify-between gap-2 py-2"
                  onClick={() => model.plan.choose(choice.key)}
                >
                  <span className="truncate">
                    {choice.key === 'team' ? t('teamPlan') : choice.label}
                  </span>
                  <span className="text-xs text-muted">
                    {choice.lastTeam ? t('teamLast') : choice.status ? ts(choice.status) : ''}
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
        <RunLink
          model={model}
          className="mt-3 flex items-center justify-between border-t border-line/60 pt-3 text-xs text-muted hover:text-text"
        >
          {t('allAgents')}
          <ArrowRight size={14} />
        </RunLink>
      </PopoverPopup>
    </Popover>
  );
}
function ChangesChip({ model }: { model: ChatWidgetModel }) {
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
      className={chipClass}
      title={t(model.changesLabel === 'provisional' ? 'changesProvisional' : 'changesFixed')}
    >
      <FileDiff size={14} />
      <span className="truncate">{text}</span>
      {model.changeLines != null ? (
        <span className="text-2xs">{t('changesLines', { count: model.changeLines })}</span>
      ) : null}
    </Link>
  );
}
function EnvironmentChip({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  return (
    <Popover>
      <PopoverTrigger data-testid="environment-chip" className={chipClass}>
        <Monitor size={14} />
        <span className="truncate">
          {t(model.environment === 'simulated' ? 'environmentSimulated' : 'environmentRestricted')}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <PopoverTitle>{t('environmentHeading')}</PopoverTitle>
        <p className="mt-2 text-xs leading-relaxed text-muted">
          {t(
            model.environment === 'simulated'
              ? 'environmentSimulationDetail'
              : 'environmentRestrictedDetail',
          )}
        </p>
        <RunLink model={model} className="mt-3 inline-flex items-center gap-2 text-xs">
          {t('contextDetails')}
          <ArrowRight size={14} />
        </RunLink>
      </PopoverPopup>
    </Popover>
  );
}
function RunLink({
  model,
  children,
  className,
}: {
  model: ChatWidgetModel;
  children: ReactNode;
  className: string;
}) {
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: model.sessionId }}
      search={{ panel: 'run', run: model.runId ?? undefined, view: 'run' }}
      className={className}
    >
      {children}
    </Link>
  );
}
/** One announcement and a scoped entry to the existing approval/interaction host. */
export function ComposerDock() {
  const model = useChatWidget();
  const t = useTranslations('Widgets');
  if (!model?.runId) return null;
  const actionLabel =
    model.action.summary === 'approval'
      ? t('actionApproval')
      : model.action.summary === 'question'
        ? t('actionQuestion')
        : model.action.summary === 'failure'
          ? t('actionFailure')
          : model.action.summary === 'unclear'
            ? t('actionUnclear')
            : t('actionMixed', { count: model.action.count });
  const status = model.plan.status;
  const countNotice =
    'completed' in status ? t('planCount', { done: status.completed, total: status.total }) : '';
  return (
    <div
      data-testid="composer-dock"
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col"
    >
      <SessionWidgetAccess />
      {model.action.visible ? (
        <div
          data-testid="action-required"
          className="mb-2 flex items-center gap-2 rounded-xl bg-warning/10 px-3 py-2 text-xs"
        >
          <CircleAlert size={15} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1">{actionLabel}</span>
          <RunLink
            model={model}
            className="shrink-0 rounded-md px-2 py-1 font-medium hover:bg-subtle focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('actionOpen')}
          </RunLink>
        </div>
      ) : null}
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {[countNotice, model.action.visible ? actionLabel : ''].filter(Boolean).join(' · ')}
      </p>
    </div>
  );
}
export function ComposerPlan() {
  const model = useChatWidget();
  const t = useTranslations('Widgets');
  const ts = useTranslations('Status');
  const panelId = useId();
  const [allKey, setAllKey] = useState<string | null>(null);
  if (!model?.runId) return null;
  const status = model.plan.status;
  const plan = 'plan' in status ? status.plan : null;
  const selection = model.plan.selectedChoice;
  const key = `${model.runId}:${model.plan.selectedKey}`;
  const showAll = allKey === key;
  const count =
    'completed' in status
      ? t(
          status.state === 'ready' && !status.runFinished && status.planFinished
            ? 'planRunning'
            : 'planCount',
          { done: status.completed, total: status.total },
        )
      : status.state === 'loading'
        ? t('planLoading')
        : t('planError');
  return (
    <div data-testid="composer-work-plan" className="min-w-0">
      {model.plan.multiple ||
      !model.plan.auto ||
      (status.state === 'hidden' && model.plan.choices.length > 0) ? (
        <div className="flex items-center justify-end px-3 pt-2">
          <Select
            label={t('planOwner')}
            size="xs"
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
        <div className="border-b border-line/50">
          <Button
            type="button"
            variant="ghost"
            data-testid="work-plan-toggle"
            className="h-auto min-h-10 w-full justify-start gap-2 rounded-none px-4 py-2 text-left text-xs"
            aria-expanded={model.plan.open}
            aria-controls={panelId}
            onClick={() => model.plan.setOpen(!model.plan.open)}
          >
            <ChevronDown
              size={14}
              className={`shrink-0 text-muted transition-transform motion-reduce:transition-none ${model.plan.open ? '' : '-rotate-90'}`}
            />
            <span className="font-medium">{t('planHeading')}</span>
            {selection && model.plan.multiple ? (
              <span className="min-w-0 truncate text-muted">
                {selection.key === 'team' ? t('teamPlan') : selection.label}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums text-muted">{count}</span>
          </Button>
          <div id={panelId} hidden={!model.plan.open} className="work-plan-disclosure">
            {model.plan.open ? (
              <div
                data-testid="work-plan-items"
                className="work-plan-items max-h-[min(16rem,30dvh)] overflow-y-auto overscroll-contain px-4 pb-2"
              >
                {status.state === 'stale-criteria' || status.state === 'stale-attempt' ? (
                  <p className="mb-2 text-xs text-warning">
                    {t(status.state === 'stale-attempt' ? 'planOldAttempt' : 'planStale')}
                  </p>
                ) : null}
                {selection?.lastTeam ? (
                  <p className="mb-2 text-xs text-muted">{t('teamLast')}</p>
                ) : null}
                {model.plan.runStatus &&
                ['failed', 'cancelled', 'interrupted'].includes(model.plan.runStatus) ? (
                  <p className="mb-2 text-xs text-warning">
                    {ts(model.plan.runStatus)} · {t('planPreserved')}
                  </p>
                ) : null}
                {status.state === 'loading' ? (
                  <p className="py-2 text-xs text-muted">{t('planLoading')}</p>
                ) : null}
                {status.state === 'error' || status.state === 'mismatch' ? (
                  <div className="flex items-center justify-between gap-2 pb-2 text-xs">
                    <p className="text-warning">
                      {t(status.state === 'mismatch' ? 'planMismatch' : 'planError')}
                    </p>
                    <Button size="xs" variant="outline" onClick={() => model.plan.retry()}>
                      {t('retry')}
                    </Button>
                  </div>
                ) : null}
                {plan ? (
                  <ol className="flex flex-col">
                    {(showAll ? plan.items : plan.items.slice(0, 5)).map((item) => (
                      <li
                        key={item.id}
                        data-plan-item={item.id}
                        className="flex min-h-8 items-start gap-2.5 py-1.5 text-ui leading-5"
                      >
                        <WorkPlanStatusIcon status={item.status} label={t(item.status)} />
                        <span
                          className={`min-w-0 break-words ${item.status === 'completed' ? 'text-muted' : item.status === 'in_progress' ? 'font-medium' : ''}`}
                        >
                          {item.title}
                        </span>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {plan && plan.items.length > 5 ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    className="ml-6 mt-1 text-muted"
                    onClick={() => setAllKey(showAll ? null : key)}
                  >
                    {t(showAll ? 'planLess' : 'planAll', { total: plan.items.length })}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
      <RunActivity model={model} />
    </div>
  );
}
function WorkPlanStatusIcon({
  status,
  label,
}: {
  status: 'pending' | 'in_progress' | 'completed';
  label: string;
}) {
  return (
    <span
      role="img"
      className={`mt-0.5 inline-flex shrink-0 ${status === 'in_progress' ? 'text-accent' : 'text-muted'}`}
      title={label}
      aria-label={label}
    >
      {status === 'completed' ? (
        <CircleCheck size={15} />
      ) : status === 'in_progress' ? (
        <LoaderCircle size={15} className="motion-safe:animate-spin" />
      ) : (
        <Circle size={15} strokeDasharray="3 3" />
      )}
    </span>
  );
}
function RunActivity({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const ts = useTranslations('Status');
  const { runFor, sessionFor } = useServices();
  const session = model.runId ? runFor(model.runId) : sessionFor(model.sessionId);
  const sharedRunId = useStore(session, (state) => state.runId);
  const text = model.action.visible
    ? ''
    : model.activity.text === 'working'
      ? t('activityWorking')
      : model.activity.text === 'failed'
        ? t('activityFailed')
        : model.activity.text === 'user'
          ? t('activityUser')
          : model.activity.text === 'elapsed' || model.activity.text === 'record'
            ? ''
            : ['paused', 'pausing', 'cancelling', 'cancelled', 'interrupted'].includes(
                  model.activity.text,
                )
              ? ts(model.activity.text)
              : model.activity.text;
  const elapsed =
    model.activity.elapsedMs == null
      ? null
      : model.activity.elapsedMs < 60_000
        ? `${Math.max(0, Math.floor(model.activity.elapsedMs / 1000))}s`
        : `${Math.floor(model.activity.elapsedMs / 60_000)}m ${Math.floor((model.activity.elapsedMs % 60_000) / 1000)}s`;
  return (
    <div
      data-testid="run-activity"
      className="flex min-h-8 min-w-0 items-center gap-2 px-4 py-1.5 text-xs text-muted"
    >
      {model.live &&
      !model.activity.frozen &&
      model.plan.runStatus === 'running' &&
      !model.action.visible ? (
        <QuietActivity />
      ) : (
        <History size={13} className="shrink-0" />
      )}
      {text ? <span className="min-w-0 truncate">{text}</span> : null}
      {elapsed ? (
        <span className="shrink-0 tabular-nums">{t('activityElapsed', { time: elapsed })}</span>
      ) : null}
      {model.live && sharedRunId === model.runId ? (
        <RunActions session={session} compact showCancel={false} />
      ) : null}
      <RunLink
        model={model}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t('activityRecord')}
        <ArrowRight size={12} />
      </RunLink>
    </div>
  );
}
function QuietActivity() {
  return (
    <span
      aria-hidden="true"
      className="corral-quiet-activity inline-flex shrink-0 items-center gap-0.5"
    >
      {[0, 1, 2].map((dot) => (
        <span
          key={dot}
          className="size-1 rounded-full bg-muted"
          style={{ animationDelay: `${dot * 160}ms` }}
        />
      ))}
    </span>
  );
}
