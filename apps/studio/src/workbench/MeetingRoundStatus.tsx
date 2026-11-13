import { type MeetingConfig, type MeetingView, SECRETARY_ID } from '@corral/contracts';
import {
  Button,
  fontWeights,
  Meter,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  SizeScope,
} from '@corral/react/design-kit';
import { Check } from '@corral/react/icons';
import { useFormatter, useTranslations } from 'use-intl';
import { rankedScores, roundMeta } from './meetingSelection.ts';
import { LINE_BUTTON } from './session/EntryStatus.tsx';

type RoundView = MeetingView['rounds'][number];
type Selection = NonNullable<RoundView['selection']>;

/**
 * The always-shown end of a person's message's meta line in a meeting: who receives it, said
 * once (workbench.md, the meeting's timeline). The chosen and the @mentioned by name; the
 * meeting's own pick as "Auto", and nobody as "No reply"; a message whose answers a later one
 * took the place of, "Skipped". Auto, and a No reply the meeting chose, open how it was chosen.
 */
export function MeetingRoundStatus({ round, config }: { round: RoundView; config: MeetingConfig }) {
  const t = useTranslations('Meetings');
  const nameIn = (id: string) =>
    id === SECRETARY_ID
      ? t('secretary')
      : config.participants.find((person) => person.participantId === id)?.name;
  const meta = roundMeta(round, nameIn);
  if (!meta) return null;
  return (
    <SizeScope size="compact">
      <span data-testid="round-status" className="flex min-w-0 flex-nowrap items-center">
        {meta.kind === 'names' ? (
          <Words>{t('to', { names: meta.names.join(', ') })}</Words>
        ) : meta.kind === 'skipped' ? (
          <Words>{t('meta.skipped')}</Words>
        ) : meta.kind === 'auto' || meta.explained ? (
          <HowChosen
            label={meta.kind === 'auto' ? t('meta.auto') : t('meta.noReply')}
            round={round}
            nameIn={nameIn}
          />
        ) : (
          <Words>{t('meta.noReply')}</Words>
        )}
      </span>
    </SizeScope>
  );
}

const Words = ({ children }: { children: string }) => (
  <span className="min-w-0 truncate" title={children}>
    {children}
  </span>
);

/**
 * How a round was chosen, in one sentence: its reason, or for a reason code this screen does not
 * know, its method alone. What was stored is never drawn as it is.
 */
function sentence(t: ReturnType<typeof useTranslations<'Meetings'>>, selection: Selection) {
  const reason = `selection.reason.${selection.reason}` as const;
  if (t.has(reason)) return t(reason);
  const method = `selection.method.${selection.strategy}` as const;
  return t.has(method) ? t(method) : null;
}

/** The pick's method and reason in one sentence, and the selector's scores as a ranking. */
function HowChosen({
  label,
  round,
  nameIn,
}: {
  label: string;
  round: RoundView;
  nameIn: (id: string) => string | undefined;
}) {
  const t = useTranslations('Meetings');
  const format = useFormatter();
  const { selection } = round;
  const ranked = rankedScores(selection, round.participantIds, nameIn);
  return (
    <Popover>
      <PopoverTrigger
        aria-label={t('selection.open', { label })}
        render={<Button variant="ghost" className={LINE_BUTTON} />}
      >
        {label}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md" aria-label={t('selection.title')}>
        <div data-meeting-selection className="flex flex-col gap-3 text-caption">
          {selection ? <p className="text-foreground">{sentence(t, selection)}</p> : null}
          {ranked.length ? (
            <ol aria-label={t('selection.ranking')} className="flex flex-col gap-1.5">
              {ranked.map((item) => (
                <li
                  key={item.participantId}
                  data-picked={item.picked || undefined}
                  className="grid grid-cols-[1rem_minmax(0,1fr)_4rem_2.5rem] items-center gap-2"
                >
                  {/* The one the meeting picked stands out: marked, and in the foreground. */}
                  {item.picked ? (
                    <Check aria-hidden="true" className="size-3.5 text-foreground" />
                  ) : (
                    <span aria-hidden="true" />
                  )}
                  <span
                    className={`truncate ${item.picked ? 'text-foreground' : 'text-muted-foreground'}`}
                    style={
                      item.picked ? { fontVariationSettings: fontWeights.semibold } : undefined
                    }
                  >
                    {item.name}
                    {item.picked ? <span className="sr-only"> {t('selection.picked')}</span> : null}
                  </span>
                  <Meter
                    // The fit as it is, not against the best: a message that needs no reply
                    // shows every bar short.
                    value={Math.min(1, Math.max(0, item.score))}
                    color={item.picked ? 'var(--foreground)' : 'var(--muted-foreground)'}
                  />
                  <span className="text-right text-muted-foreground tabular-nums">
                    {format.number(item.score, { maximumFractionDigits: 2 })}
                  </span>
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
