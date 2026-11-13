import { type MeetingView, SECRETARY_ID } from '@corral/contracts';
import { AgentAvatar, Button, fontWeights, Tooltip } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import { useModelProfiles } from './useModels.ts';

/**
 * Who is in the meeting, by name; a click addresses one of them. Whether one answers, waits or
 * failed is said by the answer rows and the activity bar, not here (workbench.md, the meeting).
 */
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
  const people = [
    ...view.config.participants.map((participant) => ({
      id: participant.participantId,
      name: participant.name,
      role: participant.role,
      model: label(participant.modelProfile),
    })),
    {
      id: SECRETARY_ID,
      name: t('secretary'),
      role: undefined,
      model: label(view.config.secretary.modelProfile),
    },
  ];
  return (
    <ul aria-label={t('participants')} className="flex flex-wrap items-center gap-1 pb-2">
      {people.map((person) => {
        return (
          <li key={person.id} data-participant={person.id} className="min-w-0">
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
                {person.role ? (
                  <span className="truncate text-caption text-muted-foreground">{person.role}</span>
                ) : null}
                {/* A participant still named after its model shows that name once. */}
                {person.model === person.name ? null : (
                  <span className="truncate text-caption text-muted-foreground">
                    {person.model}
                  </span>
                )}
              </Button>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
