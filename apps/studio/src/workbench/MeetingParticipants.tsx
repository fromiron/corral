import { type MeetingView, SECRETARY_ID } from '@corral/contracts';
import {
  AgentAvatar,
  type AgentStatus,
  AgentStatusLabel,
  Button,
  fontWeights,
  Tooltip,
} from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import { useModelProfiles } from './useModels.ts';

/** What a participant is doing now, read from the answers the meeting already shows. */
export type ParticipantState = 'answering' | 'waiting' | 'failed' | 'idle';

const FAILED = new Set(['failed', 'refused', 'interrupted', 'not_started']);
const KIT_STATUS: Record<Exclude<ParticipantState, 'idle'>, AgentStatus> = {
  answering: 'running',
  waiting: 'queued',
  failed: 'failed',
};
const LABEL = {
  answering: 'status.running',
  waiting: 'status.waiting',
  failed: 'status.failed',
} as const;

/**
 * A running answer is answering and a queued one is waiting; otherwise a participant whose
 * latest finished answer failed is failed, and everyone else is idle.
 */
export function participantStates(view: MeetingView): Map<string, ParticipantState> {
  const states = new Map<string, ParticipantState>();
  const latest = new Map<string, { at: number; status: string }>();
  view.rounds.forEach((round, index) => {
    round.answers.forEach((answer, n) => {
      const id = answer.participantId;
      if (answer.status === 'running') states.set(id, 'answering');
      else if (answer.status === 'waiting' && states.get(id) !== 'answering')
        states.set(id, 'waiting');
      if (answer.status === 'running' || answer.status === 'waiting') return;
      // The conversation's own order (MeetingPage), so the latest answer is the one shown last.
      const at = answer.order ?? (round.order ?? index * 7) + n + 1;
      const previous = latest.get(id);
      if (!previous || at >= previous.at) latest.set(id, { at, status: answer.status });
    });
  });
  for (const [id, { status }] of latest)
    if (!states.has(id) && FAILED.has(status)) states.set(id, 'failed');
  return states;
}

/** Who is in the meeting and whether they are answering; a click addresses one of them. */
export function MeetingParticipants({
  view,
  onMention,
}: {
  view: MeetingView;
  /** Puts `@name ` into the composer at its caret; nothing is sent. */
  onMention(name: string): void;
}) {
  const t = useTranslations('Meetings');
  const profiles = useModelProfiles();
  const label = (profile: string) =>
    profiles?.find((item) => item.profileId === profile)?.label ?? profile;
  const states = participantStates(view);
  const people = [
    ...view.config.participants.map((participant) => ({
      id: participant.participantId,
      name: participant.name,
      model: label(participant.modelProfile),
    })),
    { id: SECRETARY_ID, name: t('secretary'), model: label(view.config.secretary.modelProfile) },
  ];
  return (
    <ul aria-label={t('participants')} className="flex flex-wrap items-center gap-1 pb-2">
      {people.map((person) => {
        const state = states.get(person.id) ?? 'idle';
        return (
          <li key={person.id} data-participant={person.id} data-state={state} className="min-w-0">
            <Tooltip content={t('mentionParticipant', { name: person.name })}>
              <Button
                variant="ghost"
                className="max-w-full gap-1.5"
                onClick={() => onMention(person.name)}
              >
                <AgentAvatar name={person.name} size={20} />
                <span className="truncate" style={{ fontVariationSettings: fontWeights.semibold }}>
                  {person.name}
                </span>
                {state === 'idle' ? (
                  // A participant still named after its model shows that name once.
                  person.model === person.name ? null : (
                    <span className="truncate text-caption text-muted-foreground">
                      {person.model}
                    </span>
                  )
                ) : (
                  <AgentStatusLabel
                    status={KIT_STATUS[state]}
                    label={t(LABEL[state])}
                    className={state === 'failed' ? 'text-danger' : undefined}
                  />
                )}
              </Button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
