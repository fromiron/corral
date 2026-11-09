import {
  AgentFindings,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardGroup,
  CardHeader,
  CardTitle,
  DiffReview,
  type DiffReviewState,
  EmptyState,
  fontWeights,
  KitBadge,
  SectionLabel,
  TabItem,
  TabPanel,
  Tabs,
  TabsList,
  Textarea,
} from '@corral/react/design-kit';
import { GitBranch, MessageSquare } from '@corral/react/icons';
import { useId, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { PREVIEW_NOW, SAMPLE_PROJECT, SAMPLE_PULLS, type SamplePull } from './fixture.ts';
import { useDiffLabels, useFindingLabels, useSample } from './labels.ts';
import { Simulated, useRunName } from './parts.tsx';
import {
  answerPull,
  type PostedComment,
  type PullAnswer,
  type PullTab,
  postComment,
  selectPull,
  showPullTab,
  usePreview,
} from './store.ts';

// PR review preview: the pull request list, one pull request's diff and checks, comments and a
// fix request, and their simulated results.

const failedChecks = (pull: SamplePull) =>
  pull.checks.filter((check) => check.status === 'failed').length;

export function PullReviewPreview() {
  const { selected, tab, answers, comments } = usePreview((state) => state.review);
  const pull = SAMPLE_PULLS.find((item) => item.number === selected) ?? SAMPLE_PULLS[0];
  if (!pull) return null;
  return (
    <div className="grid gap-8">
      <PullList selected={pull.number} answers={answers} />
      <PullDetail
        key={pull.number}
        pull={pull}
        tab={tab}
        answer={answers[pull.number]}
        posted={comments[pull.number] ?? []}
      />
    </div>
  );
}

function usePullName() {
  const t = useTranslations('FeaturePreview.pull');
  const say = useSample();
  return (pull: SamplePull) => t('named', { number: pull.number, title: say(pull.title) });
}

function StateBadge({ pull, answer }: { pull: SamplePull; answer: PullAnswer | undefined }) {
  const t = useTranslations('FeaturePreview.pull');
  const failed = failedChecks(pull);
  return (
    <>
      <KitBadge
        variant="dot"
        size="compact"
        color={
          pull.state === 'merged'
            ? 'violet'
            : answer?.kind === 'fixes'
              ? 'amber'
              : answer
                ? 'green'
                : 'gray'
        }
      >
        {pull.state === 'merged'
          ? t('state.merged')
          : answer
            ? t(`state.${answer.kind}`)
            : t('state.open')}
      </KitBadge>
      {answer ? <Simulated /> : null}
      <KitBadge variant="dot" size="compact" color={failed ? 'red' : 'green'}>
        {failed ? t('checksFailed', { count: failed }) : t('checksPassed')}
      </KitBadge>
    </>
  );
}

function PullList({
  selected,
  answers,
}: {
  selected: number;
  answers: Record<number, PullAnswer>;
}) {
  const t = useTranslations('FeaturePreview.pull');
  const name = usePullName();
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="grid gap-2">
      <div id={heading}>
        <SectionLabel count={SAMPLE_PULLS.length}>{t('list')}</SectionLabel>
      </div>
      <CardGroup border="outlined">
        {SAMPLE_PULLS.map((pull) => (
          <Card
            key={pull.number}
            data-pull={pull.number}
            selected={pull.number === selected}
            label={name(pull)}
            onClick={() => selectPull(pull.number)}
          >
            <CardHeader>
              <CardTitle className="m-0">{name(pull)}</CardTitle>
              <CardDescription>
                <code className="font-mono text-caption [overflow-wrap:anywhere]">
                  {pull.branch}
                </code>
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap items-center gap-2">
              <StateBadge pull={pull} answer={answers[pull.number]} />
            </CardContent>
          </Card>
        ))}
      </CardGroup>
    </section>
  );
}

function PullDetail({
  pull,
  tab,
  answer,
  posted,
}: {
  pull: SamplePull;
  tab: PullTab;
  answer: PullAnswer | undefined;
  posted: PostedComment[];
}) {
  const t = useTranslations('FeaturePreview.pull');
  const say = useSample();
  const name = usePullName();
  const runName = useRunName();
  const diff = useDiffLabels(pull.state === 'merged');
  const findings = useFindingLabels();
  const heading = useId();
  const open = pull.state === 'open';
  const state: DiffReviewState =
    !open || answer?.kind === 'approved'
      ? 'written'
      : answer?.kind === 'fixes'
        ? 'rejected'
        : 'pending';
  const commentCount = pull.comments.length + posted.length + (answer?.kind === 'fixes' ? 1 : 0);
  const views: { value: PullTab; name: string; count: number }[] = [
    { value: 'changes', name: t('changes'), count: pull.files.length },
    { value: 'checks', name: t('checks'), count: pull.checks.length },
    { value: 'comments', name: t('comments'), count: commentCount },
  ];
  return (
    <section aria-labelledby={heading} className="grid gap-4">
      <header className="grid gap-1.5">
        <h2
          id={heading}
          className="m-0 text-title text-foreground [overflow-wrap:anywhere]"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {name(pull)}
        </h2>
        <p className="m-0 flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-muted-foreground">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <GitBranch aria-hidden className="size-3.5 shrink-0" />
            <span className="[overflow-wrap:anywhere]">
              {t('into', { branch: pull.branch, base: SAMPLE_PROJECT.base })}
            </span>
          </span>
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <MessageSquare aria-hidden className="size-3.5 shrink-0" />
            {runName(pull.linked)}
          </span>
        </p>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => showPullTab(value as PullTab)}
        className="grid gap-4"
      >
        <div className="max-w-full overflow-x-auto">
          <TabsList aria-label={t('views')}>
            {views.map((view) => (
              <TabItem
                key={view.value}
                value={view.value}
                label={`${view.name} ${view.count}`}
                aria-label={t('tab', { name: view.name, count: view.count })}
                className="tabular-nums"
              />
            ))}
          </TabsList>
        </div>
        <TabPanel value="changes" keepMounted>
          <DiffReview
            files={pull.files}
            state={state}
            note={say(pull.description)}
            labels={diff.labels}
            hint={diff.hint}
            approveLabel={diff.approveLabel}
            rejectLabel={diff.rejectLabel}
            sendLabel={diff.sendLabel}
            feedbackPlaceholder={diff.feedbackPlaceholder}
            {...(answer?.kind === 'fixes' ? { feedback: answer.feedback } : {})}
            {...(open
              ? {
                  onApprove: () => answerPull(pull.number, { kind: 'approved' }),
                  onReject: (feedback: string) =>
                    answerPull(pull.number, { kind: 'fixes', feedback }),
                }
              : {})}
          />
        </TabPanel>
        <TabPanel value="checks" keepMounted>
          <AgentFindings
            title={findings.title}
            feedLabel={findings.feedLabel}
            labels={findings.labels}
            maxFindings={5}
            now={PREVIEW_NOW}
            agents={pull.checks.map((check) => ({
              id: check.id,
              name: say(check.name),
              status: check.status,
              done: check.done,
              total: check.total,
              ...(check.step ? { step: say(check.step) } : {}),
            }))}
            findings={pull.findings.map((finding) => ({
              id: finding.id,
              severity: finding.severity,
              title: say(finding.title),
              agentId: finding.check,
              at: finding.at,
              ...(finding.location ? { location: finding.location } : {}),
            }))}
          />
        </TabPanel>
        <TabPanel value="comments" keepMounted>
          <Comments pull={pull} answer={answer} posted={posted} />
        </TabPanel>
      </Tabs>
    </section>
  );
}

interface CommentItem {
  id: string;
  author: string;
  kind?: string;
  body: string;
  location?: string;
  at: number;
  simulated: boolean;
}

function Comments({
  pull,
  answer,
  posted,
}: {
  pull: SamplePull;
  answer: PullAnswer | undefined;
  posted: PostedComment[];
}) {
  const t = useTranslations('FeaturePreview.pull');
  const say = useSample();
  const format = useFormatter();
  const field = useId();
  const [draft, setDraft] = useState('');
  const items: CommentItem[] = [
    ...pull.comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      body: say(comment.body),
      at: comment.at,
      simulated: false,
      ...(comment.location ? { location: comment.location } : {}),
    })),
    ...posted.map((comment) => ({
      id: comment.id,
      author: t('you'),
      body: comment.body,
      at: comment.at,
      simulated: true,
    })),
    ...(answer?.kind === 'fixes'
      ? [
          {
            id: 'fixes',
            author: t('you'),
            kind: t('fixRequest'),
            body: answer.feedback,
            at: PREVIEW_NOW,
            simulated: true,
          },
        ]
      : []),
  ];
  return (
    <div className="grid gap-4">
      {items.length ? (
        <ol className="m-0 grid list-none gap-3 p-0">
          {items.map((item) => (
            <li key={item.id} className="grid gap-1 border-b border-border pb-3">
              <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted-foreground">
                <span
                  className="text-foreground"
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {item.author}
                </span>
                {item.kind ? <span>{item.kind}</span> : null}
                {item.location ? <code className="font-mono">{item.location}</code> : null}
                <time dateTime={new Date(item.at).toISOString()}>
                  {format.relativeTime(item.at, PREVIEW_NOW)}
                </time>
                {item.simulated ? <Simulated /> : null}
              </p>
              <p className="m-0 whitespace-pre-line text-body text-foreground [overflow-wrap:anywhere]">
                {item.body}
              </p>
            </li>
          ))}
        </ol>
      ) : (
        <EmptyState title={t('noComments')} text={t('noCommentsText')} />
      )}
      <form
        className="grid gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          postComment(pull.number, draft, PREVIEW_NOW);
          setDraft('');
        }}
      >
        <label htmlFor={field} className="sr-only">
          {t('comment')}
        </label>
        <Textarea
          id={field}
          value={draft}
          placeholder={t('commentPlaceholder')}
          onChange={(event) => setDraft(event.target.value)}
        />
        <div className="flex justify-end">
          <Button type="submit" variant="secondary" disabled={!draft.trim()}>
            {t('post')}
          </Button>
        </div>
      </form>
    </div>
  );
}
