import {
  CheckPlan,
  CommandPlan,
  HashlineEditInput,
  PiEditInput,
  PiWriteInput,
  type Receipt,
  RunCommandArgs,
  ToolPermissionPlan,
} from '@corral/contracts';
import { type ApprovalView, validToolPermissionPlan } from '@corral/core';
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  AgentCard,
  AgentStatusIcon,
  Banner,
  BannerTitle,
  Button,
} from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { InteractionPanel } from './InteractionPanel.tsx';
import { RecipeStatusPanel } from './RecipeStatusPanel.tsx';
import { WorkPlanPanel } from './WorkPlanPanel.tsx';

/** A Loop that stopped for its budget or a stall is asked about in its own words. */
const copyKey = (approval: Pick<ApprovalView, 'kind' | 'loopStop'>) =>
  approval.kind === 'loop_cap' && approval.loopStop && approval.loopStop !== 'cap_reached'
    ? `loop_${approval.loopStop}`
    : approval.kind;

/**
 * Decisions waiting for the person: each names the exact versions and the
 * criteria it is about. Approving applies to that subject only; a newer version needs its own.
 */
export function ApprovalPanel({
  session,
  onOpenArtifact,
  className,
  compact = false,
  showPlan = true,
  showRelatedPanels = true,
  policySettingsAction,
}: {
  session: RunSessionStore;
  onOpenArtifact: (artifactVersionId: string) => void;
  /** Placement around the cards; nothing is drawn while no approval waits. */
  className?: string;
  /** A compact strip beside the result; exact subjects and decision criteria remain visible. */
  compact?: boolean;
  /** The session composer already presents the current plan; detail views retain it. */
  showPlan?: boolean;
  /** Conversation turns already own their workflow and question surfaces. */
  showRelatedPanels?: boolean;
  /** Navigation only: never grants broader permission to this call. */
  policySettingsAction?: ReactNode;
}) {
  const t = useTranslations('Approvals');
  const headingId = useId();
  const all = useStore(session, (s) => s.projection?.approvals);
  const artifacts = useStore(session, (s) => s.projection?.artifacts);
  const approvals = useMemo(
    () => Object.values(all ?? {}).filter((a) => a.status === 'pending'),
    [all],
  );
  const done = useMemo(
    () => Object.values(all ?? {}).filter((a) => a.status === 'approved'),
    [all],
  );
  const criteriaId = approvals[0]?.criteriaVersionId;
  const criteria = useStore(session, (s) => (criteriaId ? s.artifactTexts[criteriaId] : undefined));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Receipt | null>(null);
  const [toolPlans, setToolPlans] = useState<Record<string, ToolPermissionPlan | null>>({});
  const [checkPlans, setCheckPlans] = useState<Record<string, CheckPlan | null>>({});

  useEffect(() => {
    let active = true;
    for (const approval of approvals) {
      if (!approval.tool) continue;
      const { bodyRef, fingerprint, targetTree } = approval.tool;
      void (async () => {
        try {
          if (session.getState().artifactTexts[bodyRef] === undefined)
            await session.getState().loadArtifact(bodyRef);
          const text = session.getState().artifactTexts[bodyRef];
          if (approval.tool?.purpose === 'tool') {
            const plan = ToolPermissionPlan.parse(JSON.parse(text ?? 'null'));
            if (plan.fingerprint !== fingerprint || !validToolPermissionPlan(plan))
              throw new Error('permission changed');
            if (active) setToolPlans((previous) => ({ ...previous, [bodyRef]: plan }));
            return;
          }
          const plan = CheckPlan.parse(JSON.parse(text ?? 'null'));
          if (
            plan.fingerprint !== fingerprint ||
            plan.tree !== targetTree ||
            (plan.purpose ?? 'check') !== (approval.tool?.purpose ?? 'check')
          )
            throw new Error('approval changed');
          if (active) setCheckPlans((previous) => ({ ...previous, [bodyRef]: plan }));
        } catch {
          if (active) {
            setCheckPlans((previous) => ({ ...previous, [bodyRef]: null }));
            setToolPlans((previous) => ({ ...previous, [bodyRef]: null }));
          }
        }
      })();
    }
    return () => {
      active = false;
    };
  }, [approvals, session]);

  useEffect(() => {
    if (criteriaId) void session.getState().loadArtifact(criteriaId);
  }, [session, criteriaId]);

  if (approvals.length === 0)
    return (
      <>
        {showRelatedPanels ? (
          <RecipeStatusPanel session={session} onOpenArtifact={onOpenArtifact} />
        ) : null}
        {showRelatedPanels ? <InteractionPanel session={session} /> : null}
        {showPlan ? <WorkPlanPanel session={session} /> : null}
      </>
    );
  const label = (id: string) =>
    artifacts?.[id] ? `${artifacts[id].name} v${artifacts[id].version}` : id;
  const decide = async (approvalId: string, decision: 'approve' | 'reject') => {
    setBusy(true);
    try {
      const receipt = await session.getState().resolveApproval(approvalId, decision);
      setRefused(receipt.error ? receipt : null);
    } catch {
      // The session preserves the unconfirmed receipt; approval stays pending.
    } finally {
      setBusy(false);
    }
  };

  // Buttons are the only way to decide: the card has no Enter/Escape shortcut. As in the kit's
  // permission card, the decline sits left of the primary action.
  const decisionButtons = (approval: (typeof approvals)[number]) => (
    <>
      <Button
        variant="tertiary"
        size="compact"
        disabled={busy}
        onClick={() => void decide(approval.approvalId, 'reject')}
      >
        {approval.tool
          ? t(
              approval.tool.purpose === 'tool'
                ? 'rejectTool'
                : approval.tool.purpose === 'lsp'
                  ? 'rejectLsp'
                  : 'rejectCheck',
            )
          : t(`rejectAs.${copyKey(approval)}`)}
      </Button>
      <Button
        size="compact"
        disabled={
          busy ||
          !!(
            approval.tool &&
            !(approval.tool.purpose === 'tool'
              ? toolPlans[approval.tool.bodyRef]
              : checkPlans[approval.tool.bodyRef])
          )
        }
        title={
          approval.tool
            ? t(
                approval.tool.purpose === 'tool'
                  ? 'toolOnce'
                  : approval.tool.purpose === 'lsp'
                    ? 'lspOnce'
                    : 'checkOnce',
              )
            : t(`then.${copyKey(approval)}`)
        }
        onClick={() => void decide(approval.approvalId, 'approve')}
      >
        {approval.tool
          ? t(
              approval.tool.purpose === 'tool'
                ? 'approveTool'
                : approval.tool.purpose === 'lsp'
                  ? 'approveLsp'
                  : 'approveCheck',
            )
          : t(`approveAs.${copyKey(approval)}`)}
      </Button>
      {approval.tool?.purpose === 'tool' ? policySettingsAction : null}
    </>
  );

  return (
    <>
      {showRelatedPanels ? (
        <RecipeStatusPanel session={session} onOpenArtifact={onOpenArtifact} />
      ) : null}
      {showRelatedPanels ? <InteractionPanel session={session} /> : null}
      {showPlan ? <WorkPlanPanel session={session} /> : null}
      <section aria-labelledby={headingId} className={`flex flex-col gap-2 ${className ?? ''}`}>
        <h3 id={headingId} className={compact ? 'sr-only' : 'text-ui font-semibold'}>
          {t('heading')}
        </h3>
        {/* UX-11: decisions already made in this run stay in view, so the next one reads as a
          new step rather than a retry of the last. */}
        {(compact ? [] : done).map((approval) => (
          <p
            key={approval.approvalId}
            data-testid={`approved-${approval.approvalId}`}
            className="flex items-center gap-1.5 text-caption text-muted-foreground"
          >
            <AgentStatusIcon status="done" size={12} />
            {t('done', {
              step: t(`kind.${copyKey(approval)}`),
              subject: label(approval.subjectVersionIds[0] ?? ''),
            })}
          </p>
        ))}
        {approvals.map((approval) => (
          <AgentCard
            key={approval.approvalId}
            data-testid={`approval-${approval.approvalId}`}
            role="article"
            aria-label={t('heading')}
            className="text-caption"
          >
            <div
              className={
                compact
                  ? 'flex flex-wrap items-center gap-2.5 px-3 py-2'
                  : 'flex items-start gap-2.5 px-4 pt-3.5 pr-3.5'
              }
            >
              <AgentStatusIcon
                status="waiting"
                size={14}
                className={compact ? undefined : 'mt-0.5 self-start'}
              />
              <div className="grid min-w-0 flex-1">
                <p className="text-body font-medium text-foreground [overflow-wrap:anywhere]">
                  {approval.tool
                    ? t(
                        approval.tool.purpose === 'tool'
                          ? 'toolHeading'
                          : approval.tool.purpose === 'lsp'
                            ? 'lspHeading'
                            : 'checkHeading',
                      )
                    : t(`kind.${copyKey(approval)}`)}
                </p>
                {approval.tool && !compact ? (
                  <span className="truncate text-muted-foreground">
                    {approval.tool.executionId}
                  </span>
                ) : null}
              </div>
              {compact ? (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {decisionButtons(approval)}
                </div>
              ) : null}
            </div>
            <div
              className={
                compact
                  ? 'flex min-w-0 flex-col gap-2 px-3 pb-2'
                  : 'flex min-w-0 flex-col gap-2 py-3 pr-4 pl-10'
              }
            >
              {approval.tool?.purpose === 'tool' ? (
                <PermissionDetails plan={toolPlans[approval.tool.bodyRef]} />
              ) : approval.tool ? (
                <div className="flex min-w-0 flex-col gap-1">
                  {checkPlans[approval.tool.bodyRef] ? (
                    <>
                      <p>{checkPlans[approval.tool.bodyRef]?.name}</p>
                      {checkPlans[approval.tool.bodyRef]?.query ? (
                        <p>
                          {checkPlans[approval.tool.bodyRef]?.query?.operation} ·{' '}
                          {checkPlans[approval.tool.bodyRef]?.query?.path}
                        </p>
                      ) : null}
                      <code className="whitespace-pre-wrap break-all">
                        {checkPlans[approval.tool.bodyRef]?.argv.join(' ')}
                      </code>
                      <p className="text-muted-foreground">
                        {t('checkScope', {
                          execution: approval.tool.executionId,
                          attempt: approval.tool.attemptNo,
                          revision: checkPlans[approval.tool.bodyRef]?.configRevision ?? 0,
                          fingerprint: approval.tool.fingerprint.slice(0, 12),
                          tree: approval.tool.targetTree?.slice(0, 12) ?? '—',
                        })}
                      </p>
                      <p className="text-muted-foreground">
                        {t(approval.tool.purpose === 'lsp' ? 'lspOnce' : 'checkOnce')}
                      </p>
                    </>
                  ) : (
                    <p role={checkPlans[approval.tool.bodyRef] === null ? 'alert' : 'status'}>
                      {t(
                        checkPlans[approval.tool.bodyRef] === null
                          ? 'checkUnavailable'
                          : 'checkLoading',
                      )}
                    </p>
                  )}
                </div>
              ) : null}
              {compact || approval.tool ? null : (
                <p className="text-muted-foreground">{t(`explain.${copyKey(approval)}`)}</p>
              )}
              {approval.tool ? null : (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">{t('subject')}</span>
                  {approval.subjectVersionIds.map((id) => (
                    <Button
                      key={id}
                      variant="tertiary"
                      size="compact"
                      title={id}
                      onClick={() => onOpenArtifact(id)}
                    >
                      {label(id)}
                    </Button>
                  ))}
                </div>
              )}
              {criteria ? (
                <div className="text-muted-foreground">
                  {t('criteria')}
                  <ul className="list-disc pl-5">
                    {criteria.split('\n').map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
            {compact ? null : (
              <div className="flex flex-wrap justify-end gap-2 border-t border-border px-4 pt-3 pb-4">
                {decisionButtons(approval)}
              </div>
            )}
            {refused?.error ? (
              <Banner role="alert" status="error" size="compact" className="mx-3 mb-3">
                <BannerTitle>{t('refused', { message: refused.error.message })}</BannerTitle>
              </Banner>
            ) : null}
          </AgentCard>
        ))}
      </section>
    </>
  );
}

function PermissionDetails({ plan }: { plan: ToolPermissionPlan | null | undefined }) {
  const t = useTranslations('Approvals');
  const ko = useLocale().startsWith('ko');
  if (!plan)
    return (
      <p role={plan === null ? 'alert' : 'status'}>
        {t(plan === null ? 'checkUnavailable' : 'checkLoading')}
      </p>
    );
  const summary = permissionSummary(plan, ko);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {summary ?? (
        <>
          <p className="font-medium">
            {plan.descriptor.name} · {plan.descriptor.source}
          </p>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2">
            {JSON.stringify(plan.arguments, null, 2)}
          </pre>
        </>
      )}
      <p className="text-muted-foreground">{t('toolOnce')}</p>
      <Accordion>
        <AccordionItem value="identity">
          <AccordionTrigger>{t('toolIdentity')}</AccordionTrigger>
          <AccordionContent>
            {summary ? (
              <>
                <p className="mt-2">
                  {plan.descriptor.name} · {plan.descriptor.source}
                </p>
                <pre className="my-2 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-muted p-2">
                  {JSON.stringify(plan.arguments, null, 2)}
                </pre>
              </>
            ) : null}
            <p className="break-all">{plan.descriptorHash}</p>
            <p>{t('toolPolicyRevision', { revision: plan.policyRevision })}</p>
            <p className="break-all">{plan.fingerprint}</p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </div>
  );
}

const ResolvedCommand = CommandPlan.extend({ request: RunCommandArgs.optional() });
const shellNames = {
  powershell: 'PowerShell',
  pwsh: 'PowerShell 7',
  cmd: 'Command Prompt',
  'git-bash': 'Git Bash',
  bash: 'Bash',
  sh: 'Shell',
};

/** Summaries only change presentation. The verified body/fingerprint still authorizes the exact call. */
function permissionSummary(plan: ToolPermissionPlan, ko: boolean) {
  if (plan.descriptor.source !== 'corral') return null;
  if (plan.descriptor.name === 'write_file' || plan.descriptor.name === 'write') {
    const args = plan.arguments;
    if (
      plan.descriptor.name === 'write_file' &&
      Object.keys(args).some((key) => key !== 'path' && key !== 'text')
    )
      return null;
    const parsed = PiWriteInput.safeParse(
      plan.descriptor.name === 'write_file' ? { path: args.path, content: args.text } : args,
    );
    if (!parsed.success) return null;
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-medium">{ko ? '쓸 파일 내용' : 'Proposed file content'}</p>
        <p className="break-words font-mono">{parsed.data.path}</p>
        <pre
          data-testid="file-approval-content"
          className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono"
        >
          {parsed.data.content}
        </pre>
      </div>
    );
  }
  if (plan.descriptor.name === 'edit') {
    const parsed = PiEditInput.safeParse(plan.arguments);
    if (!parsed.success) return null;
    return (
      <div className="flex min-w-0 flex-col gap-2">
        <p className="font-medium">{ko ? '요청한 교체 내용' : 'Requested replacements'}</p>
        <p className="break-words font-mono">{parsed.data.path}</p>
        <ol className="max-h-80 space-y-3 overflow-auto">
          {parsed.data.edits.map((edit, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the fingerprint fixes this immutable ordered edit list.
            <li key={`${plan.fingerprint}:${index}`}>
              <p className="text-muted-foreground">{ko ? '교체 전' : 'Before'}</p>
              <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono">
                {edit.oldText}
              </pre>
              <p className="text-muted-foreground">{ko ? '교체 후' : 'After'}</p>
              <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono">
                {edit.newText}
              </pre>
            </li>
          ))}
        </ol>
      </div>
    );
  }
  if (plan.descriptor.name === 'run_command') {
    const parsed = ResolvedCommand.safeParse(plan.arguments);
    if (!parsed.success) return null;
    const command = parsed.data;
    const source = command.command ?? command.request?.command;
    if (!source) return null;
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="command-approval-summary">
        <p className="font-medium">{ko ? '명령 실행' : 'Run command'}</p>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono">
          {source}
        </pre>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{ko ? '셸' : 'Shell'}</dt>
          <dd>{shellNames[command.shellId]}</dd>
          <dt className="text-muted-foreground">{ko ? '작업 폴더' : 'Working directory'}</dt>
          <dd className="break-words font-mono">
            {command.cwd === '.'
              ? ko
                ? '세션 작업 사본의 루트'
                : 'Session working-copy root'
              : command.cwd}
          </dd>
          <dt className="text-muted-foreground">{ko ? '실행 방식' : 'Mode'}</dt>
          <dd>
            {command.mode === 'service'
              ? ko
                ? '서비스'
                : 'Service'
              : ko
                ? '완료까지 실행'
                : 'Foreground'}
          </dd>
          <dt className="text-muted-foreground">{ko ? '시간 제한' : 'Timeout'}</dt>
          <dd>{command.timeoutMs / 1000} s</dd>
        </dl>
      </div>
    );
  }
  if (plan.descriptor.name === 'edit_hashline') {
    const parsed = HashlineEditInput.safeParse(plan.arguments);
    if (!parsed.success) return null;
    return (
      <div className="flex min-w-0 flex-col gap-2" data-testid="hashline-approval-summary">
        <p className="font-medium">{ko ? '파일 변경' : 'Edit file'}</p>
        <p className="break-words font-mono">{parsed.data.path}</p>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono">
          {parsed.data.ops}
        </pre>
      </div>
    );
  }
  return null;
}
