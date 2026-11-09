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

/** One request's reasoning: the judgment line where one ran, else what was asked and sent. */
export function ReasoningSummary({ call }: { call: Call }) {
  const t = useTranslations('Reasoning');
  const resolution = call.reasoning;
  if (!resolution) return <span className="text-muted-foreground">{t('unrecorded')}</span>;
  if (resolution.source === 'off')
    return (
      <span
        data-testid="reasoning-summary"
        className="text-xs text-muted-foreground"
        title={resolution.preparationId}
      >
        {t('route.off')}
      </span>
    );
  if (resolution.route)
    return <RouteSummary call={call} resolution={resolution} route={resolution.route} />;
  const requested =
    resolution.requested.mode === 'fixed'
      ? resolution.requested.level
      : t(resolution.requested.mode);
  return (
    <span
      data-testid="reasoning-summary"
      className="text-xs text-muted-foreground"
      title={resolution.preparationId}
    >
      {t('label')}: {requested} → {resolution.resolved ?? t('provider_default')}
      {' · '}
      {t(`source.${resolution.source}`)}
      {' · '}
      {t('payload')}:{' '}
      {call.reasoningWire ? (call.reasoningWire.value ?? t('omitted')) : t('unverified')}
    </span>
  );
}

function RouteSummary({
  call,
  resolution,
  route,
}: {
  call: Call;
  resolution: ReasoningResolution;
  route: RouteRecord;
}) {
  const t = useTranslations('Reasoning');
  const td = useTranslations('DecisionApis');
  const format = useFormatter();
  const ms = (value: number) => t('route.ms', { ms: format.number(value) });
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
          wait: format.number(timing.callerWaitMs),
          deadline: format.number(timing.deadlineMs),
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
    [
      t('payload'),
      call.reasoningWire ? (call.reasoningWire.value ?? t('omitted')) : t('unverified'),
    ],
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
            className="text-xs text-muted-foreground"
          />
        }
      >
        {line}
      </PopoverTrigger>
      <PopoverPopup width="md">
        <PopoverTitle className="text-sm font-semibold">{t('route.detail')}</PopoverTitle>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
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
