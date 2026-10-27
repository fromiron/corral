import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
  Select,
} from '@corral/react/design-kit';
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
  PanelRight,
} from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { type ComponentProps, type ReactNode, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { actionCopy, type WidgetChip } from './selectors.ts';
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
export const chipClass =
  'inline-flex min-h-9 pointer-coarse:min-h-11 min-w-0 max-w-full shrink-0 items-center gap-1.5 rounded-full px-2.5 text-xs text-muted-foreground outline-none transition-colors hover:bg-subtle hover:text-text focus-visible:ring-2 focus-visible:ring-ring';
const number = (value: number) => value.toLocaleString();
/** "Last run" only for the newest finished run; an older one names its position (#72). */
function viewedLabel(
  viewed: NonNullable<ChatWidgetModel['viewed']>,
  t: ReturnType<typeof useTranslations<'Widgets'>>,
) {
  if (viewed.latest) return t('lastRun');
  return viewed.number
    ? t('selectedRun', { number: viewed.number, total: viewed.total })
    : t('selectedRunUnordered');
}
export const compactNumber = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k` : number(value);

function Chip({ chip, model }: { chip: WidgetChip; model: ChatWidgetModel }) {
  if (chip === 'context') return <ContextUsageChip model={model} />;
  if (chip === 'agents' && model.agents) return <AgentChip model={model} />;
  if (chip === 'changes') return <ChangesChip model={model} />;
  if (chip === 'environment' && model.environment) return <EnvironmentChip model={model} />;
  return null;
}

/** The context chip's words, also the context widget's accessible summary. */
export function contextLabel(
  context: ChatWidgetModel['context'],
  t: ReturnType<typeof useTranslations<'Widgets'>>,
) {
  return context.kind === 'messages' && context.tokens != null
    ? t('contextMessages', { count: compactNumber(context.tokens) })
    : context.percent != null
      ? t('contextPercent', { percent: context.percent })
      : context.completeness === 'error'
        ? t('contextError')
        : context.kind === 'partial'
          ? t('contextPartial')
          : t('contextPending');
}

function ContextUsageChip({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const { context } = model;
  const label = contextLabel(context, t);
  return (
    <Popover>
      <PopoverTrigger data-testid="context-usage-chip" className={chipClass}>
        <ContextGauge percent={context.barPercent} />
        <span className="truncate">{label}</span>
        <ChevronDown size={12} />
      </PopoverTrigger>
      <PopoverPopup align="start" width="lg">
        <ContextDetail model={model} />
      </PopoverPopup>
    </Popover>
  );
}
/** ContextInspector: what the presented run's last request held. */
export function ContextDetail({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const tc = useTranslations('Widgets.category');
  const { context } = model;
  const measured = context.tokens != null;
  const complete = context.coverage === 'request' && context.completeness === 'complete';
  return (
    <div data-testid="context-inspector" className="flex flex-col gap-4 text-ui">
      <div>
        <div className="flex items-center justify-between gap-3">
          <PopoverTitle>{t('context')}</PopoverTitle>
          <span className="rounded-md bg-subtle px-2 py-0.5 text-2xs text-muted-foreground">
            {complete
              ? t('measurementFull')
              : context.kind === 'messages'
                ? t('measurementMessages')
                : measured
                  ? t('measurementPartial')
                  : t('measurementPending')}
          </span>
        </div>
        <p className="mt-1.5 break-words text-xs text-muted-foreground">
          {[
            model.viewed ? viewedLabel(model.viewed, t) : t('rail'),
            context.roleLabel,
            context.modelLabel,
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
        {context.recordedAt ? (
          <p className="mt-1 text-2xs text-muted-foreground">
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
          <p className="text-xs text-muted-foreground">
            {t(measured ? 'estimatedInput' : 'contextPending')}
          </p>
          {context.tokens != null ? (
            <p className="mt-1 text-lg font-medium tabular-nums">
              {number(context.tokens)}
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
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
      <SegmentBar parts={context.parts} total={complete ? context.windowTokens : context.tokens} />
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
              <span className="max-w-44 text-right tabular-nums text-muted-foreground">
                {part
                  ? `${number(part.tokens)}${part.omission ? ` · ${t('measurementPartial')}` : ''}`
                  : t(complete ? 'notInRequest' : 'notMeasured')}
              </span>
            </li>
          );
        })}
        {context.freeTokens != null ? (
          <li className="mt-1 flex justify-between gap-3 border-t border-line/60 pt-2 text-xs text-muted-foreground">
            <span>{t(context.freeTokens < 0 ? 'estimatedOverage' : 'estimatedRemaining')}</span>
            <span className={`tabular-nums ${context.freeTokens < 0 ? 'text-warning' : ''}`}>
              {number(Math.abs(context.freeTokens))}
            </span>
          </li>
        ) : null}
      </ul>
      {model.simulated || !complete || context.awaitingRefresh || context.kind === 'highest' ? (
        <div className="space-y-1 rounded-lg bg-subtle px-3 py-2 text-xs text-muted-foreground">
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
            <Button size="compact" variant="tertiary" onClick={model.retryRead}>
              {t('retry')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {model.reserveTokens != null ? (
        <p className="text-xs text-muted-foreground">
          {t('outputReserve', { count: number(model.reserveTokens) })}
        </p>
      ) : null}
      {context.providerInput != null ||
      context.providerCacheRead != null ||
      context.providerOutput != null ? (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer rounded-sm py-1 focus-visible:ring-2 focus-visible:ring-ring">
            {t('providerUsage')}
          </summary>
          <p className="mt-1">{t('providerSeparate')}</p>
          <p className="mt-1 tabular-nums">
            {t('providerNumbers', {
              input: context.providerInput == null ? '—' : number(context.providerInput),
              cache: context.providerCacheRead == null ? '—' : number(context.providerCacheRead),
              output: context.providerOutput == null ? '—' : number(context.providerOutput),
            })}
          </p>
        </details>
      ) : null}
      <RunLink
        model={model}
        className="flex items-center justify-between gap-2 border-t border-line/60 pt-3 text-xs text-muted-foreground hover:text-text"
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
function AgentChip({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  if (!model.agents) return null;
  return (
    <Popover>
      <PopoverTrigger data-testid="agent-activity-chip" className={chipClass}>
        <Bot size={14} />
        <span className="truncate">{t('agents', model.agents)}</span>
        <ChevronDown size={12} />
      </PopoverTrigger>
      <PopoverPopup align="start" width="md">
        <AgentsDetail model={model} />
      </PopoverPopup>
    </Popover>
  );
}
/** Agent states and the plan each agent owns. */
export function AgentsDetail({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  const ts = useTranslations('Status');
  if (!model.agents) return null;
  return (
    <>
      <PopoverTitle>{t('agentsHeading')}</PopoverTitle>
      <p className="mt-2 text-xs text-muted-foreground">
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
                size="compact"
                variant="ghost"
                className="h-auto w-full justify-between gap-2 py-2"
                onClick={() => model.plan.choose(choice.key)}
              >
                <span className="truncate">
                  {choice.key === 'team' ? t('teamPlan') : choice.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  {choice.lastTeam ? t('teamLast') : choice.status ? ts(choice.status) : ''}
                </span>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <RunLink
        model={model}
        className="mt-3 flex items-center justify-between border-t border-line/60 pt-3 text-xs text-muted-foreground hover:text-text"
      >
        {t('allAgents')}
        <ArrowRight size={14} />
      </RunLink>
    </>
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
        <EnvironmentDetail model={model} />
      </PopoverPopup>
    </Popover>
  );
}
/** Why this run's environment differs from an ordinary local run. */
export function EnvironmentDetail({ model }: { model: ChatWidgetModel }) {
  const t = useTranslations('Widgets');
  return (
    <>
      <PopoverTitle>{t('environmentHeading')}</PopoverTitle>
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
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
    </>
  );
}
export function RunLink({
  model,
  ...props
}: {
  model: ChatWidgetModel;
} & ComponentProps<'a'>) {
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: model.sessionId }}
      search={(previous) => ({
        ...previous,
        ...(previous.run !== model.runId
          ? { execution: undefined, artifact: undefined, result: undefined, message: undefined }
          : {}),
        panel: 'run',
        run: model.runId ?? undefined,
        view: 'run',
      })}
      resetScroll={false}
      {...props}
    />
  );
}
/** One announcement and a scoped entry to the existing approval/interaction host. */
/** `summary` is the narrow-width way into the Overview widgets. */
export function ComposerDock({ summary }: { summary?: ReactNode }) {
  const model = useChatWidget();
  const t = useTranslations('Widgets');
  const ts = useTranslations('Status');
  if (!model?.runId) return null;
  const actionLabel = actionCopy(model.action)
    .map((key) => (key === 'actionMixed' ? t(key, { count: model.action.count }) : t(key)))
    .join(' · ');
  const status = model.plan.status;
  const countNotice =
    'completed' in status ? t('planCount', { done: status.completed, total: status.total }) : '';
  return (
    <div
      data-testid="composer-dock"
      className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col"
    >
      <div
        data-testid="composer-status-pills"
        className="mb-2 flex min-w-0 flex-wrap items-center gap-1"
      >
        <RunLink model={model} className={`${chipClass} bg-raised`}>
          <Circle
            size={12}
            aria-hidden="true"
            className={model.action.visible ? 'text-warning' : 'text-muted-foreground'}
          />
          <span>
            {model.readState === 'error'
              ? t('runUnavailable')
              : model.readState === 'loading'
                ? t('runLoading')
                : model.plan.runStatus
                  ? ts(model.plan.runStatus)
                  : t('runUnavailable')}
          </span>
          {model.viewed ? <span className="text-2xs">{viewedLabel(model.viewed, t)}</span> : null}
        </RunLink>
        {!model.plan.open && 'completed' in status ? (
          <Button
            variant="ghost"
            className={chipClass}
            onClick={() => model.plan.setOpen(true)}
            aria-expanded={false}
          >
            <CircleCheck size={13} aria-hidden="true" />
            {countNotice}
          </Button>
        ) : null}
        {model.chips.includes('changes') ? <ChangesChip model={model} /> : null}
        {summary}
      </div>
      {model.action.visible ? (
        // The live region below announces it; the banner itself stays a note.
        <Banner
          data-testid="action-required"
          status="warning"
          contrast="high"
          size="compact"
          role="note"
          className="mb-2"
        >
          <BannerTitle>{actionLabel}</BannerTitle>
          <BannerActions>
            <Button size="compact" variant="secondary" render={<RunLink model={model} />}>
              {t('actionOpen')}
            </Button>
          </BannerActions>
        </Banner>
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
              className={`shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none ${model.plan.open ? '' : '-rotate-90'}`}
            />
            <span className="font-medium">{t('planHeading')}</span>
            {selection && model.plan.multiple ? (
              <span className="min-w-0 truncate text-muted-foreground">
                {selection.key === 'team' ? t('teamPlan') : selection.label}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{count}</span>
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
                  <p className="mb-2 text-xs text-muted-foreground">{t('teamLast')}</p>
                ) : null}
                {model.plan.runStatus &&
                ['failed', 'cancelled', 'interrupted'].includes(model.plan.runStatus) ? (
                  <p className="mb-2 text-xs text-warning">
                    {ts(model.plan.runStatus)} · {t('planPreserved')}
                  </p>
                ) : null}
                {status.state === 'loading' ? (
                  <p className="py-2 text-xs text-muted-foreground">{t('planLoading')}</p>
                ) : null}
                {status.state === 'error' || status.state === 'mismatch' ? (
                  <div className="flex items-center justify-between gap-2 pb-2 text-xs">
                    <p className="text-warning">
                      {t(status.state === 'mismatch' ? 'planMismatch' : 'planError')}
                    </p>
                    <Button size="compact" variant="tertiary" onClick={() => model.plan.retry()}>
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
                          className={`min-w-0 break-words ${item.status === 'completed' ? 'text-muted-foreground' : item.status === 'in_progress' ? 'font-medium' : ''}`}
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
                    size="compact"
                    variant="ghost"
                    className="ml-6 mt-1 text-muted-foreground"
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
      className={`mt-0.5 inline-flex shrink-0 ${status === 'in_progress' ? 'text-primary' : 'text-muted-foreground'}`}
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
  const text = model.action.visible
    ? ''
    : model.activity.text === 'starting'
      ? t('activityStarting')
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
  // A finished run's status pill already links to its record; the line is for live work.
  if (!model.live && !text) return null;
  return (
    <div
      data-testid="run-activity"
      className="flex min-h-8 min-w-0 items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground"
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
      {/* Pause, resume and cancel live in the dock's active run controls, one place (#91). */}
      <RunLink
        model={model}
        className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-sm hover:text-text focus-visible:ring-2 focus-visible:ring-ring"
      >
        <PanelRight size={12} aria-hidden="true" />
        {t('activityRecord')}
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
