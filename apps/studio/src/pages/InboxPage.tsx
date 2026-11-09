import { useTranslations } from 'use-intl';
import { workHref } from '../workbench/navigation.ts';

// Needs you: every project's waiting items on one screen (docs/specs/features/inbox.md).

export interface InboxSearch {
  returnTo?: string;
}

export function validateInboxSearch(search: Record<string, unknown>): InboxSearch {
  const returnTo = workHref(search.returnTo);
  return returnTo ? { returnTo } : {};
}

export function InboxPage() {
  const t = useTranslations('Inbox');
  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
      <h2 className="text-title font-semibold">{t('title')}</h2>
    </main>
  );
}
