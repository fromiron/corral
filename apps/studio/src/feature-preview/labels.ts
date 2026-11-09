import type {
  AgentFindingsLabels,
  AgentTaskStatus,
  AgentTasksFilter,
  AgentTasksLabels,
  DiffReviewLabels,
} from '@corral/react/design-kit';
import { useCallback, useMemo } from 'react';
import { useFormatter, useLocale, useTranslations } from 'use-intl';
import type { SampleText } from './fixture.ts';

// The kit parts' localized text for the previews; everything they say comes from the
// FeaturePreview catalog.

/** Picks the sample text in the interface language. */
export function useSample() {
  const locale = useLocale();
  return useCallback((text: SampleText) => (locale.startsWith('ko') ? text.ko : text.en), [locale]);
}

const TASK_FILTERS = ['all', 'running', 'review', 'merged'] as const satisfies AgentTasksFilter[];

export function useTaskLabels() {
  const t = useTranslations('FeaturePreview.tasks');
  return useMemo(() => {
    const status = (value: AgentTaskStatus) => t(`status.${value}`);
    const labels: Partial<AgentTasksLabels> = {
      filterTasks: t('filterTasks'),
      filterCount: (filter, count) => t('filterCount', { filter, count }),
      empty: () => t('empty'),
      tasks: t('list'),
      status: {
        queued: status('queued'),
        running: status('running'),
        ready: status('ready'),
        merged: status('merged'),
        failed: status('failed'),
        cancelled: status('cancelled'),
      },
      change: {
        added: t('change.added'),
        modified: t('change.modified'),
        deleted: t('change.deleted'),
        renamed: t('change.renamed'),
      },
      checks: { passed: t('checks.passed'), failed: t('checks.failed') },
      files: (count) => t('files', { count }),
      lineStats: (added, removed) => t('lineStats', { added, removed }),
      fileStats: (added, removed) => t('fileStats', { added, removed }),
      cancel: t('cancel'),
      retry: t('retry'),
      pullRequest: (number, state) => t('pullRequest', { number, state: state ?? 'none' }),
      pullRequestShort: (number, state) =>
        t('pullRequestShort', { number, state: state ?? 'none' }),
      steps: t('steps'),
      noSteps: t('noSteps'),
      changedFiles: t('changedFiles'),
      noFiles: t('noFiles'),
      stepFailed: t('stepFailed'),
      stepActive: t('stepActive'),
      started: (title) => t('started', { title }),
      ready: (title) => t('ready', { title }),
      failed: (title, error) =>
        error ? t('failedWith', { title, error }) : t('failed', { title }),
      cancelled: (title) => t('cancelled', { title }),
      merged: (title) => t('merged', { title }),
      pullRequestOpened: (number) => t('pullRequestOpened', { number }),
    };
    const filters = Object.fromEntries(
      TASK_FILTERS.map((filter) => [filter, t(`filter.${filter}`)]),
    ) as Record<AgentTasksFilter, string>;
    return { labels, filters, status };
  }, [t]);
}

/** DiffReview's text for a pull request: Reject asks for fixes and Approve approves. */
export function useDiffLabels(merged: boolean) {
  const t = useTranslations('FeaturePreview.diff');
  return useMemo(() => {
    const counts = (added: number, removed: number) =>
      [
        ...(added || !removed ? [t('added', { count: added })] : []),
        ...(removed ? [t('removed', { count: removed })] : []),
      ].join(', ');
    const labels: Partial<DiffReviewLabels> = {
      counts,
      line: (type, number) =>
        number === undefined ? t('line', { type }) : t('lineAt', { type, number }),
      showUnchanged: (count) => t('showUnchanged', { count }),
      showUnchangedRange: (count, from, to) =>
        from === undefined || to === undefined
          ? t('showUnchanged', { count })
          : t('showUnchangedRange', { count, from, to }),
      unchanged: (count) => t('unchanged', { count }),
      newFile: t('newFile'),
      deletedFile: t('deletedFile'),
      showFileDiff: (path, added, removed) =>
        t('showFileDiff', { path, counts: counts(added, removed) }),
      filesChanged: t('filesChanged'),
      changedFiles: t('changedFiles'),
      review: (count) => t('review', { count }),
      writing: (count) => t('writing', { count }),
      // A merged sample pull request is fixture state; an approval here is simulated.
      wrote: (count) => (merged ? t('mergedFiles', { count }) : t('approvedFiles', { count })),
      sentBack: t('sentBack'),
      nothingWritten: t('simulatedNote'),
      showDiff: t('showDiff'),
      hideDiff: t('hideDiff'),
      approved: t('approved'),
      feedbackLabel: t('feedbackLabel'),
      feedbackPrefix: t('feedbackPrefix'),
      cancel: t('cancel'),
      feedbackRequired: t('feedbackRequired'),
      rejectCancelled: t('rejectCancelled'),
      announcePending: (count, added, removed) =>
        t('announcePending', { count, counts: counts(added, removed) }),
      announceApproved: (count) => t('announceApproved', { count }),
      announceWritten: (count) => t('announceApproved', { count }),
      announceRejected: (feedback) =>
        feedback ? t('announceRejectedWith', { feedback }) : t('announceRejected'),
    };
    return {
      labels,
      approveLabel: t('approve'),
      rejectLabel: t('requestFixes'),
      sendLabel: t('send'),
      feedbackPlaceholder: t('placeholder'),
      hint: t('hint'),
    };
  }, [t, merged]);
}

export function useFindingLabels() {
  const t = useTranslations('FeaturePreview.findings');
  const format = useFormatter();
  return useMemo(() => {
    const labels: Partial<AgentFindingsLabels> = {
      checks: (done, total) => t('checks', { done, total }),
      severityWord: (severity, count) =>
        severity === 'critical' ? t('critical') : t('warning', { count }),
      counts: (critical, warnings) => t('counts', { critical, warnings }),
      severity: {
        critical: t('severity.critical'),
        warning: t('severity.warning'),
        note: t('severity.note'),
      },
      agents: t('agents'),
      clearFilter: (name) => t('clearFilter', { name }),
      empty: (name) => (name ? t('emptyFrom', { name }) : t('empty')),
      time: (at, now) => format.relativeTime(at, now),
    };
    return { labels, title: t('title'), feedLabel: t('feed') };
  }, [t, format]);
}
