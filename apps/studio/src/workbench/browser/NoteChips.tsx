// The composer's collected browser annotations (features/browser-annotate.md 모아 두기): one chip
// per note with its number, the note mark and its name tag, opening what goes with it, and a
// remove that takes its screenshot along. Everything shown came from a page and is plain text.
import { type ImageAttachment, type TextAttachment, textAttachmentKey } from '@corral/contracts';
import { AnnotationContents } from '@corral/react';
import { Button, Popover, PopoverPopup, PopoverTrigger } from '@corral/react/design-kit';
import { SquarePen, X } from '@corral/react/icons';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { noteScreenshotHash, noteView, withoutNote } from './noteChips.ts';

export function NoteChips({
  sessionId,
  attachments,
  images,
  disabled,
  onChange,
}: {
  sessionId: string;
  /** The draft's whole lists: the chips are its notes, and a removal changes both. */
  attachments: TextAttachment[];
  images: ImageAttachment[];
  disabled?: boolean;
  onChange(next: { attachments: TextAttachment[]; images: ImageAttachment[] }): void;
}) {
  const t = useTranslations('Browser');
  const { workspaces } = useServices();
  const notes = attachments.flatMap((item) => {
    const view = noteView(item);
    return view ? [{ item, view }] : [];
  });
  if (!notes.length) return null;
  return (
    <ul aria-label={t('notes')} className="flex flex-wrap gap-1">
      {notes.map(({ item, view }) => {
        const key = textAttachmentKey(item);
        const hash = noteScreenshotHash(item);
        const shot = hash ? images.find((image) => image.sha256 === hash) : undefined;
        const name = t('noteChip', { n: view.n, label: view.label });
        return (
          <li
            key={key}
            data-note-chip={view.n}
            className="flex max-w-full items-center gap-0.5 rounded-md bg-subtle p-0.5 text-caption"
          >
            <Popover>
              <PopoverTrigger
                aria-label={name}
                render={<Button variant="ghost" size="compact" className="min-w-0 gap-1 px-1.5" />}
              >
                <span className="tabular-nums">{view.n}</span>
                <SquarePen className="size-3 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-mono">
                  <bdi>{view.label}</bdi>
                </span>
              </PopoverTrigger>
              <PopoverPopup align="start" width="md" aria-label={name}>
                <AnnotationContents
                  page={view.page}
                  label={view.label}
                  selector={view.selector}
                  text={view.text}
                  styles={view.styles}
                  console={view.console}
                  screenshot={
                    shot && workspaces
                      ? {
                          src: workspaces.imageUrl(sessionId, shot.imageId),
                          alt: t('noteShot', { n: view.n }),
                        }
                      : 'none'
                  }
                />
              </PopoverPopup>
            </Popover>
            <Button
              type="button"
              variant="ghost"
              size="icon-tiny"
              disabled={disabled}
              aria-label={t('removeNote', { n: view.n })}
              onClick={() => onChange(withoutNote({ attachments, images }, key))}
            >
              <X />
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
