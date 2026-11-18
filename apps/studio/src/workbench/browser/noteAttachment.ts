// A browser annotation's text attachment (features/browser-annotate.md 보내는 것, 계약: 첨부):
// the PageAnnotation body under the untrusted warning, as `annotation.json` (sent at once) or
// `annotation-{n}.json` (collected), with the page's provenance. The pick ID and the PNG bytes
// stay out of the body: the image goes as its own attachment, named by its hash.
import {
  type AnnotationMaterial,
  PAGE_ANNOTATION_WARNING,
  PageAnnotation,
  type TextAttachment,
  type TextAttachmentProvenance,
} from '@corral/contracts';
import { createTextAttachment } from '@corral/core';

export function annotationBody(material: AnnotationMaterial): PageAnnotation {
  const { page } = material;
  return PageAnnotation.parse({
    warning: PAGE_ANNOTATION_WARNING,
    page: { kind: page.kind, origin: page.origin, path: page.path },
    pickedAt: material.pickedAt,
    generation: material.generation,
    note: material.note,
    element: material.element,
    styles: material.styles,
    ...(page.kind === 'preview' && material.console ? { console: material.console } : {}),
  });
}

/** An ordinary page's provenance; a preview's is built against its Paddock and lease. */
export function pageProvenance(
  material: AnnotationMaterial,
  screenshotHash?: string,
): TextAttachmentProvenance | null {
  const { page } = material;
  if (page.kind !== 'page') return null;
  return {
    kind: 'page',
    origin: page.origin,
    path: page.path,
    pickedAt: material.pickedAt,
    generation: material.generation,
    ...(screenshotHash ? { screenshotHash } : {}),
  };
}

export function noteAttachment(
  material: AnnotationMaterial,
  name: string,
  provenance: TextAttachmentProvenance,
): TextAttachment {
  return createTextAttachment(
    name,
    'application/json',
    JSON.stringify(annotationBody(material), null, 2),
    provenance,
  );
}

/** The screenshot's bytes, for the conversation's image store. */
export function screenshotBlob(data: string): Blob {
  const bytes = Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}
