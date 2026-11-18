// Collected browser annotations in the composer's draft (features/browser-annotate.md 모아 두기):
// a note chip is a text attachment named `annotation-{n}.json` with a page's provenance, and its
// screenshot is the draft image whose hash that provenance names. The number is the largest one
// in the draft plus one, so it survives a reload and never changes for the chips that stay.
import { type ImageAttachment, type TextAttachment, textAttachmentKey } from '@corral/contracts';

const NOTE_NAME = /^annotation-([1-9]\d{0,5})\.json$/;

/** The chip's number, or null when the attachment is not a collected note. */
export function noteNumber(item: TextAttachment): number | null {
  const kind = item.provenance?.kind;
  if (item.mime !== 'application/json' || (kind !== 'page' && kind !== 'preview')) return null;
  const match = NOTE_NAME.exec(item.name);
  return match ? Number(match[1]) : null;
}

export const isNote = (item: TextAttachment) => noteNumber(item) !== null;

/** The number the next collected note takes. */
export function nextNoteNumber(attachments: readonly TextAttachment[]): number {
  return Math.max(0, ...attachments.map((item) => noteNumber(item) ?? 0)) + 1;
}

/** The screenshot hash a note's provenance names, if it took one. */
export function noteScreenshotHash(item: TextAttachment): string | null {
  const source = item.provenance;
  return (source?.kind === 'page' || source?.kind === 'preview') && source.screenshotHash
    ? source.screenshotHash
    : null;
}

/** The draft images that are some note's screenshot: they go with their chips, not the row. */
export function noteImages(
  attachments: readonly TextAttachment[],
  images: readonly ImageAttachment[],
): ImageAttachment[] {
  const hashes = new Set(
    attachments.filter(isNote).flatMap((item) => noteScreenshotHash(item) ?? []),
  );
  return images.filter((image) => hashes.has(image.sha256));
}

/** The draft without one note: its screenshot goes too, unless another chip still holds it. */
export function withoutNote(
  draft: { attachments: readonly TextAttachment[]; images: readonly ImageAttachment[] },
  key: string,
): { attachments: TextAttachment[]; images: ImageAttachment[] } {
  const attachments = draft.attachments.filter((item) => textAttachmentKey(item) !== key);
  const removed = draft.attachments.find((item) => textAttachmentKey(item) === key);
  const hash = removed ? noteScreenshotHash(removed) : null;
  const held = hash !== null && attachments.some((item) => noteScreenshotHash(item) === hash);
  return {
    attachments,
    images: draft.images.filter((image) => held || hash === null || image.sha256 !== hash),
  };
}

/** What a chip shows of its note: the page body as written, read as plain values only. */
export interface NoteView {
  n: number;
  label: string;
  page: { origin: string; path: string };
  selector: string;
  text: string;
  styles: { property: string; before: string; after: string }[];
  console: { level: string; message: string }[] | null;
}

const text = (value: unknown, fallback = '') => (typeof value === 'string' ? value : fallback);

/** The chip's view of a note; a body without a name tag (an older one) shows its tag name. */
export function noteView(item: TextAttachment): NoteView | null {
  const n = noteNumber(item);
  if (n === null) return null;
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(item.text);
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch {
    // An unreadable body still names its chip by number.
  }
  const element = (body.element && typeof body.element === 'object' ? body.element : {}) as Record<
    string,
    unknown
  >;
  const page = (body.page && typeof body.page === 'object' ? body.page : {}) as Record<
    string,
    unknown
  >;
  const styles = Array.isArray(body.styles) ? body.styles : [];
  const console = Array.isArray(body.console) ? body.console : null;
  return {
    n,
    label: text(element.label) || text(element.tag),
    page: { origin: text(page.origin), path: text(page.path) },
    selector: text(element.selector),
    text: text(element.text),
    styles: styles.flatMap((change) =>
      change && typeof change === 'object'
        ? [
            {
              property: text((change as Record<string, unknown>).property),
              before: text((change as Record<string, unknown>).before),
              after: text((change as Record<string, unknown>).after),
            },
          ]
        : [],
    ),
    console: console
      ? console.flatMap((line) =>
          line && typeof line === 'object'
            ? [
                {
                  level: text((line as Record<string, unknown>).level),
                  message: text((line as Record<string, unknown>).message),
                },
              ]
            : [],
        )
      : null,
  };
}
