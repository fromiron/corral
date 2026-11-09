import { useTranslations } from 'use-intl';
import { workHref } from '../workbench/navigation.ts';

// The library: teams, templates and resources (docs/specs/features/library.md).

export const LIBRARY_VIEWS = ['teams', 'templates', 'resources'] as const;
export type LibraryView = (typeof LIBRARY_VIEWS)[number];

export interface LibrarySearch {
  project?: string;
  returnTo?: string;
}

export function validateLibrarySearch(search: Record<string, unknown>): LibrarySearch {
  const returnTo = workHref(search.returnTo);
  return {
    ...(typeof search.project === 'string' && search.project && search.project.length <= 256
      ? { project: search.project }
      : {}),
    ...(returnTo ? { returnTo } : {}),
  };
}

export function LibraryPage({ view }: { view?: LibraryView | undefined }) {
  const t = useTranslations('Library');
  return (
    <main data-library-view={view} className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <h2 className="text-title font-semibold">{t('title')}</h2>
    </main>
  );
}
