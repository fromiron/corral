import { useTranslations } from 'use-intl';
import { workHref } from '../workbench/navigation.ts';

// Feature previews: sample flows with no real calls (docs/specs/features/feature-preview.md).

export const PREVIEW_FEATURES = ['task-board', 'pr-review', 'browser-qa'] as const;
export type PreviewFeature = (typeof PREVIEW_FEATURES)[number];

/** A known preview, or undefined so the screen shows the list. */
export function previewFeature(value: unknown): PreviewFeature | undefined {
  return PREVIEW_FEATURES.find((feature) => feature === value);
}

export interface PreviewSearch {
  returnTo?: string;
}

export function validatePreviewSearch(search: Record<string, unknown>): PreviewSearch {
  const returnTo = workHref(search.returnTo);
  return returnTo ? { returnTo } : {};
}

export function PreviewPage({ feature }: { feature?: string | undefined }) {
  const t = useTranslations('FeaturePreview');
  const current = previewFeature(feature);
  return (
    <main
      data-preview-feature={current}
      className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6"
    >
      <h2 className="text-title font-semibold">{t('title')}</h2>
    </main>
  );
}
