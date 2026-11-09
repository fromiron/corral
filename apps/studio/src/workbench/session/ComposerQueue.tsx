import type { SessionEntry } from '@corral/core';
import { Button, Switch } from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import { TextAttachmentList } from '../TextAttachments.tsx';

/** Saved requests for the next run: start one now, edit it back into the box, or remove it. */
export function ComposerQueue({
  queued,
  autoStart,
  onAutoStartChange,
  startDisabled,
  onStart,
  onEdit,
  onRemove,
}: {
  queued: SessionEntry[];
  /** Start the next saved request when a run of this session ends. */
  autoStart: boolean;
  onAutoStartChange: (value: boolean) => void;
  startDisabled: boolean;
  onStart: (entry: SessionEntry) => void;
  onEdit: (entry: SessionEntry) => void;
  onRemove: (entry: SessionEntry) => void;
}) {
  const t = useTranslations('Sessions');
  return queued.length > 0 ? (
    <section aria-label={t('queueHeading')} className="mx-3 rounded-t-xl bg-raised px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">
          {t('queueHeading')} · {queued.length}
        </h3>
        <Switch
          label={t('autoStart')}
          title={t('autoStartHint')}
          checked={autoStart}
          onToggle={() => onAutoStartChange(!autoStart)}
        />
      </div>
      <ul className="mt-1 flex flex-col">
        {queued.map((entry) => (
          <li key={entry.entryId} className="group/queued flex items-center gap-1 text-ui">
            <div className="min-w-0 flex-1">
              <p className="truncate" title={entry.text}>
                {entry.text}
              </p>
              {entry.attachments?.length ? (
                <TextAttachmentList attachments={entry.attachments} />
              ) : null}
            </div>
            <Button
              variant="ghost"
              size="compact"
              disabled={startDisabled}
              onClick={() => onStart(entry)}
            >
              {t('startNow')}
            </Button>
            <Button variant="ghost" size="compact" onClick={() => onEdit(entry)}>
              {t('editQueued')}
            </Button>
            <Button variant="ghost" size="compact" onClick={() => onRemove(entry)}>
              {t('remove')}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  ) : null;
}
