// A sent request's page notes (features/browser-annotate.md 보내는 것: 보이는 것): each shows what
// it carried, from its body, as its chip and the overlay show it, with its screenshot from the
// request's image. Everything in it came from a page, so it is plain text.
import { type ImageAttachment, type TextAttachment, textAttachmentKey } from '@corral/contracts';
import { AnnotationContents } from '@corral/react';
import { SquarePen } from '@corral/react/icons';
import { useTranslations } from 'use-intl';
import { noteScreenshotHash, pageNoteView } from './noteChips.ts';

export function SentNotes({
  attachments,
  images,
  imageUrl,
}: {
  attachments: TextAttachment[];
  images: ImageAttachment[];
  /** The request image's address, or null where images cannot be read. */
  imageUrl: (imageId: string) => string | null;
}) {
  const t = useTranslations('Browser');
  const notes = attachments.flatMap((item) => {
    const view = pageNoteView(item);
    return view ? [{ item, view }] : [];
  });
  if (!notes.length) return null;
  return (
    <ul aria-label={t('notes')} className="mt-2 flex flex-col gap-1 text-caption">
      {notes.map(({ item, view }) => {
        const hash = noteScreenshotHash(item);
        const shot = hash ? images.find((image) => image.sha256 === hash) : undefined;
        const src = shot ? imageUrl(shot.imageId) : null;
        return (
          <li key={textAttachmentKey(item)}>
            <details>
              <summary className="flex cursor-pointer items-center gap-1">
                <SquarePen className="size-3 shrink-0 text-muted-foreground" />
                <bdi className="min-w-0 truncate">
                  {view.n === null ? view.label : t('noteChip', { n: view.n, label: view.label })}
                </bdi>
              </summary>
              <div className="mt-2">
                <AnnotationContents
                  // A note sent at once is the request's own text, already above: it shows once.
                  note={view.n === null ? undefined : view.note}
                  page={view.page}
                  label={view.label}
                  selector={view.selector}
                  text={view.text}
                  styles={view.styles}
                  console={view.console}
                  screenshot={
                    src
                      ? {
                          src,
                          alt:
                            view.n === null
                              ? t('noteShotOf', { label: view.label })
                              : t('noteShot', { n: view.n }),
                        }
                      : 'none'
                  }
                />
              </div>
            </details>
          </li>
        );
      })}
    </ul>
  );
}
