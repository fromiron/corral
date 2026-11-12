import type { EffortLevel, ReasoningResolution, RouteRecord } from '@corral/contracts';
import type { ModelCallView } from '@corral/core';
import { useFormatter, useTranslations } from 'use-intl';
import {
  Button,
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from '../design-kit/index.ts';

type Call = Pick<ModelCallView, 'reasoning' | 'reasoningWire' | 'reasoningSettled'>;

const DECISION_APIS = ['jev', 'openai-decisions'] as const;

type ReasoningText = ReturnType<typeof useTranslations<'Reasoning'>>;

/** The level the request record applied. Null means the record itself is missing. */
function appliedLevel(call: Call, t: ReasoningText): string | null {
  const resolution = call.reasoning;
  if (!resolution) return null;
  if (resolution.resolved === null) return t('provider_default');
  return t(`level.${resolution.resolved}`);
}

/** Whether the wire value was verified, and that value when one was recorded. */
function wireCheck(call: Call, open: boolean, nothingSent: boolean, t: ReasoningText): string {
  const wire = call.reasoningWire;
  if (!wire) return open ? t('unverified') : t('notVerified');
  if (wire.value) return t('rowVerified', { value: wire.value });
  // The payload record says nothing was sent. Don't repeat that when the level already does.
  return nothingSent ? t('rowVerifiedPlain') : t('rowVerified', { value: t('provider_default') });
}

/**
 * Applied level and wire check for a conversation row, visible without opening the request.
 * Provider default is only a record that nothing was sent. No record stays unrecorded.
 */
export function ReasoningLevelLabel({ call, open }: { call: Call; open: boolean }) {
  const t = useTranslations('Reasoning');
  const level = appliedLevel(call, t);
  const check = wireCheck(call, open, call.reasoning?.resolved === null, t);
  const text =
    level === null && !call.reasoningWire
      ? t('unrecorded')
      : t('rowLine', { level: level ?? t('unrecorded'), check });
  return (
    <span data-testid="reasoning-level" className="text-caption text-muted-foreground">
      {text}
    </span>
  );
}

/**
 * One request's reasoning: the judgment line where one ran, else what was asked and sent.
 * `open` says whether the request can still record what it sent, so a missing record reads as
 * pending rather than as never verified.
 */
export function ReasoningSummary({ call, open }: { call: Call; open: boolean }) {
  const t = useTranslations('Reasoning');
  const resolution = call.reasoning;
  if (!resolution) return <span className="text-muted-foreground">{t('unrecorded')}</span>;
  if (resolution.source === 'off')
    return (
      <span
        data-testid="reasoning-summary"
        className="text-caption text-muted-foreground"
        title={resolution.preparationId}
      >
        {t('route.off')}
      </span>
    );
  if (resolution.route)
    return (
      <RouteSummary call={call} open={open} resolution={resolution} route={resolution.route} />
    );
  const requested =
    resolution.requested.mode === 'fixed'
      ? resolution.requested.level
      : t(resolution.requested.mode);
  return (
    <span
      data-testid="reasoning-summary"
      className="text-caption text-muted-foreground"
      title={resolution.preparationId}
    >
      {t('label')}: {requested} → {resolution.resolved ?? t('provider_default')}
      {' · '}
      {t(`source.${resolution.source}`)}
      {' · '}
      {t('payload')}: {sent(call, open, t)}
    </span>
  );
}

/** What the provider request carried. A recorded null means nothing was sent; no record is unverified. */
function sent(call: Call, open: boolean, t: ReturnType<typeof useTranslations<'Reasoning'>>) {
  if (call.reasoningWire) return call.reasoningWire.value ?? t('provider_default');
  return open ? t('unverified') : t('notVerified');
}

function RouteSummary({
  call,
  open,
  resolution,
  route,
}: {
  call: Call;
  open: boolean;
  resolution: ReasoningResolution;
  route: RouteRecord;
}) {
  const t = useTranslations('Reasoning');
  const td = useTranslations('DecisionApis');
  const format = useFormatter();
  // Timings are measured with sub-millisecond precision; people read whole milliseconds.
  const whole = (value: number) => format.number(Math.round(value));
  const ms = (value: number) => t('route.ms', { ms: whole(value) });
  const applied = resolution.resolved ?? t('provider_default');
  const apiId = DECISION_APIS.find((id) => route.engineIdentity?.startsWith(`${id}/`));
  const device = route.device?.actual?.toUpperCase() ?? null;
  const engine =
    route.engine === 'local'
      ? [t('route.local'), ...(device ? [device] : [])]
      : route.engine === 'api'
        ? [t('route.api'), ...(apiId ? [td(`name.${apiId}`)] : [])]
        : [];
  const reason = route.fallback
    ? route.fallback.reason === 'insufficient-context'
      ? `${t('route.reason.insufficient-context')} · ${t('route.notCalled')}`
      : t(`route.reason.${route.fallback.reason}`)
    : null;
  const outcome =
    resolution.source === 'router' && route.recommended
      ? t('route.recommended', { recommended: route.recommended, applied })
      : resolution.source === 'fallback' && reason
        ? `${reason} → ${applied}`
        : resolution.source === 'reused'
          ? `${t('source.reused')} → ${applied}`
          : `${t(`source.${resolution.source}`)} → ${applied}`;
  const wait =
    resolution.source === 'router' && route.timing.callerWaitMs !== null
      ? [ms(route.timing.callerWaitMs)]
      : [];
  const line = [...engine, outcome, ...wait].join(' · ');

  const probabilities = route.probabilities;
  const distribution =
    route.probabilityMeaning === 'not-provided'
      ? t('route.notProvided')
      : probabilities && route.probabilityMeaning === 'choice-distribution'
        ? route.candidates
            .flatMap((level) => {
              const share = probabilities[level];
              return share === undefined
                ? []
                : [`${level} ${format.number(share, { style: 'percent' })}`];
            })
            .join(' · ')
        : null;
  const timing = route.timing;
  const times = [
    timing.callerWaitMs !== null
      ? t('route.waited', {
          wait: whole(timing.callerWaitMs),
          deadline: whole(timing.deadlineMs),
        })
      : null,
    timing.engineMs !== null ? t('route.engineTime', { time: ms(timing.engineMs) }) : null,
    timing.countMs !== null ? t('route.countTime', { time: ms(timing.countMs) }) : null,
    timing.packMs !== null ? t('route.packTime', { time: ms(timing.packMs) }) : null,
  ].filter((part): part is string => part !== null);
  const frame = route.frame;
  const input = frame
    ? [
        t(frame.kind === 'd1-exact' ? 'route.tokens' : 'route.bytes', {
          count: frame.inputUnits,
        }),
        ...(frame.omitted ? [t('route.omitted', { count: frame.omitted })] : []),
        ...(frame.truncated ? [t('route.truncated', { count: frame.truncated })] : []),
      ].join(' · ')
    : null;
  const settled = call.reasoningSettled;
  const late = settled?.lateResult
    ? settled.lateSelected
      ? t('route.lateSelected', { level: settled.lateSelected as EffortLevel })
      : t('route.lateUnusable')
    : null;
  const fallback = route.fallback
    ? [
        `${reason} → ${applied}`,
        ...(route.fallback.insufficient
          ? [t(`route.insufficient.${route.fallback.insufficient}`)]
          : []),
        ...(route.fallback.targetUnsupported ? [t('route.targetUnsupported')] : []),
      ].join(' · ')
    : null;
  const rows: [string, string][] = [
    ...(distribution ? [[t('route.distribution'), distribution] as [string, string]] : []),
    ...(fallback ? [[t('route.fallback'), fallback] as [string, string]] : []),
    ...(late ? [[t('route.late'), late] as [string, string]] : []),
    ...(route.device
      ? [
          [
            t('route.device'),
            [
              route.device.actual?.toUpperCase() ?? route.device.requested.toUpperCase(),
              ...(route.device.threads !== null
                ? [t('route.threads', { count: route.device.threads })]
                : []),
              ...(route.device.host ? [route.device.host] : []),
            ].join(' · '),
          ] as [string, string],
        ]
      : []),
    ...(times.length ? [[t('route.time'), times.join(' · ')] as [string, string]] : []),
    ...(settled?.physicalOccupiedMs != null
      ? [[t('route.occupied'), ms(settled.physicalOccupiedMs)] as [string, string]]
      : []),
    ...(input ? [[t('route.input'), input] as [string, string]] : []),
    [t('payload'), sent(call, open, t)],
  ];

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost-muted"
            size="sm-multiline"
            data-testid="reasoning-summary"
            title={resolution.preparationId}
            className="text-caption text-muted-foreground"
          />
        }
      >
        {line}
      </PopoverTrigger>
      <PopoverPopup width="md">
        <PopoverTitle>{t('route.detail')}</PopoverTitle>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-caption">
          {rows.map(([term, value]) => (
            <div key={term} className="contents">
              <dt className="text-muted-foreground">{term}</dt>
              <dd className="min-w-0 break-words">{value}</dd>
            </div>
          ))}
          {route.engineIdentity ? (
            <div className="contents">
              <dt className="text-muted-foreground">{t('route.engine')}</dt>
              <dd className="min-w-0 break-all font-mono">{route.engineIdentity}</dd>
            </div>
          ) : null}
        </dl>
      </PopoverPopup>
    </Popover>
  );
}
