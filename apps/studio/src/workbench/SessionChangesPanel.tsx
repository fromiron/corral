import type { WorkSession } from '@corral/core';
import { Button } from '@corral/react/design-kit';
import { useRef } from 'react';
import { useTranslations } from 'use-intl';
import { WorkingCopyPanel } from '../pages/FilesViews.tsx';
import { ReviewContent } from '../pages/ReviewPage.tsx';
import { GitPanel } from './GitPanel.tsx';
import type { ReviewSearch } from './panels/routes.ts';

export function SessionChangesPanel({
  session,
  reviewSearch,
  onReviewChange,
  onSessionChange,
}: {
  session: WorkSession;
  reviewSearch?: ReviewSearch;
  onReviewChange(search: ReviewSearch | undefined): void;
  onSessionChange?: () => void | Promise<void>;
}) {
  const t = useTranslations('Workbench');
  const reviewing = reviewSearch !== undefined;
  const rememberedSearch = useRef<ReviewSearch | undefined>(undefined);
  if (reviewSearch) rememberedSearch.current = reviewSearch;
  const search = reviewSearch ?? rememberedSearch.current ?? {};
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-line p-3">
        <Button
          variant="tertiary"
          onClick={() => {
            onReviewChange(reviewing ? undefined : search);
          }}
        >
          {t(reviewing ? 'backToGit' : 'reviewFeedback')}
        </Button>
      </div>
      <div hidden={reviewing} className="min-h-0 flex-1 overflow-auto">
        <div className="flex flex-col gap-4 p-3">
          <WorkingCopyPanel sessionId={session.sessionId} projectId={session.projectId} />
          <GitPanel sessionId={session.sessionId} projectId={session.projectId} />
        </div>
      </div>
      <div hidden={!reviewing} className="min-h-0 flex-1">
        {rememberedSearch.current !== undefined ? (
          <ReviewContent
            session={session}
            search={search}
            onSearch={(patch) => onReviewChange({ ...search, ...patch })}
            embedded
            onPrepareCopy={() => onReviewChange(undefined)}
            onSessionChange={onSessionChange}
          />
        ) : null}
      </div>
    </div>
  );
}
