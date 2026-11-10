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
import { useTranslations } from 'use-intl';
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
  fontWeights,
} from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { FirstRow, RowAction } from './FirstRow.tsx';
import { InteractionPanel, interactionShown } from './InteractionPanel.tsx';
import { RecipeStatusPanel, recipeStatusShown } from './RecipeStatusPanel.tsx';
import { WorkPlanPanel } from './WorkPlanPanel.tsx';

/** A Loop that stopped for a stall is asked about in its own words. */
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
  headed = true,
  policySettingsAction,
  action,
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
  /**
   * False when the host already names this area or its state (the Run page's panel, Needs you's
   * detail, a session conversation under the top bar's waiting pill): no visible heading is
   * added, and the region keeps its name.
   */
  headed?: boolean;
  /** Navigation only: never grants broader permission to this call. */
  policySettingsAction?: ReactNode;
  /**
   * A control of the host's frame (the Run page's close), set at the end of the area's first row
   * (the first card's heading row, or the first line above it) so it never takes a row of its
   * own. For hosts that leave the plan out (`showPlan` false).
   */
  action?: ReactNode;
}) {
  const t = useTranslations('Approvals');
  const headingId = useId();
  // Which part draws the area's first row, and so carries the host's control.
  const lead = useStore(session, (s) =>
    !action || !showRelatedPanels
      ? 'approvals'
      : recipeStatusShown(s.events)
        ? 'recipe'
        : interactionShown(s.events, s.projection)
          ? 'interaction'
          : 'approvals',
  );
  const all = useStore(session, (s) => s.projection?.approvals);
  const artifacts = useStore(session, (s) => s.projection?.artifacts);
  const nodes = useStore(session, (s) => s.definition?.nodes);
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

  const related = showRelatedPanels ? (
    <>
      <RecipeStatusPanel
        session={session}
        onOpenArtifact={onOpenArtifact}
        action={lead === 'recipe' ? action : undefined}
      />
      <InteractionPanel session={session} action={lead === 'interaction' ? action : undefined} />
    </>
  ) : null;
  if (approvals.length === 0)
    return (
      <>
        {related}
        {/* Nothing else to stand beside: the host's control keeps its place. */}
        {lead === 'approvals' && action ? <FirstRow action={action}>{null}</FirstRow> : null}
        {showPlan ? <WorkPlanPanel session={session} /> : null}
      </>
    );
  const shownDone = compact ? [] : done;
  // The first row that shows: the visible heading, the first decision already made, or the
  // first card's heading row.
  const approvalsAction = lead === 'approvals' ? action : undefined;
  const headingAction = headed && !compact ? approvalsAction : undefined;
  const doneAction = headingAction ? undefined : approvalsAction;
  const cardAction = headingAction || shownDone.length ? undefined : approvalsAction;
  const label = (id: string) =>
    artifacts?.[id] ? `${artifacts[id].name} v${artifacts[id].version}` : id;
  /** What waits; a breakpoint names the step it holds. */
  const kindText = (approval: ApprovalView) =>
    t(`kind.${copyKey(approval)}`, {
      step: nodes?.find((node) => node.id === approval.nodeId)?.label ?? approval.nodeId ?? '',
    });
  const decide = async (approvalId: string, decision: 'approve' | 'reject', routeId?: string) => {
    setBusy(true);
    try {
      const receipt = routeId
        ? await session.getState().resolveApproval(approvalId, decision, routeId)
        : await session.getState().resolveApproval(approvalId, decision);
      setRefused(receipt.error ? receipt : null);
    } catch {
      // The session preserves the unconfirmed receipt; approval stays pending.
    } finally {
      setBusy(false);
    }
  };

  // Buttons are the only way to decide: the card has no Enter/Escape shortcut. As in the kit's
  // permission card, the decline sits left of the primary action.
  const decisionButtons = (approval: (typeof approvals)[number]) =>
    approval.kind === 'route' ? (
      // A router that could not choose: each connected route is its own answer.
      <>
        <Button
          variant="tertiary"
          size="compact"
          disabled={busy}
          onClick={() => void decide(approval.approvalId, 'reject')}
        >
          {t('rejectAs.route')}
        </Button>
        {(approval.routes ?? []).map((route) => (
          <Button
            key={route.id}
            variant="secondary"
            size="compact"
            disabled={busy}
            title={t('then.route')}
            onClick={() => void decide(approval.approvalId, 'approve', route.id)}
          >
            {route.label}
          </Button>
        ))}
      </>
    ) : (
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
      {related}
      {showPlan ? <WorkPlanPanel session={session} /> : null}
      <section
        {...(headed ? { 'aria-labelledby': headingId } : { 'aria-label': t('heading') })}
        className={`flex flex-col gap-2 ${className ?? ''}`}
      >
        {headed ? (
          <FirstRow action={headingAction}>
            <h3
              id={headingId}
              className={compact ? 'sr-only' : 'text-ui'}
              style={{ fontVariationSettings: fontWeights.semibold }}
            >
              {t('heading')}
            </h3>
          </FirstRow>
        ) : null}
        {/* UX-11: decisions already made in this run stay in view, so the next one reads as a
          new step rather than a retry of the last. */}
        {shownDone.map((approval, index) => (
          <p
            key={approval.approvalId}
            data-testid={`approved-${approval.approvalId}`}
            className="flex items-center gap-1.5 text-caption text-muted-foreground"
          >
            {index === 0 ? <RowAction action={doneAction} /> : null}
            <AgentStatusIcon status="done" size={12} />
            {t('done', {
              step: kindText(approval),
              subject: label(approval.subjectVersionIds[0] ?? ''),
            })}
          </p>
        ))}
        {approvals.map((approval, index) => (
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
              {index === 0 && !compact ? <RowAction action={cardAction} /> : null}
              <AgentStatusIcon
                status="waiting"
                size={14}
                className={compact ? undefined : 'mt-0.5 self-start'}
              />
              <div className="grid min-w-0 flex-1">
                <p
                  className="text-body text-foreground [overflow-wrap:anywhere]"
                  style={{ fontVariationSettings: fontWeights.semibold }}
                >
                  {approval.tool
                    ? t(
                        approval.tool.purpose === 'tool'
                          ? 'toolHeading'
                          : approval.tool.purpose === 'lsp'
                            ? 'lspHeading'
                            : 'checkHeading',
                      )
                    : kindText(approval)}
                </p>
                {approval.tool && !compact ? (
                  <span className="truncate text-muted-foreground">
                    {approval.tool.executionId}
                  </span>
                ) : null}
              </div>
              {compact ? (
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  {index === 0 ? <RowAction action={cardAction} /> : null}
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
  if (!plan)
    return (
      <p role={plan === null ? 'alert' : 'status'}>
        {t(plan === null ? 'checkUnavailable' : 'checkLoading')}
      </p>
    );
  const summary = permissionSummary(plan, t);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {summary ?? (
        <>
          <p style={{ fontVariationSettings: fontWeights.semibold }}>
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
function permissionSummary(
  plan: ToolPermissionPlan,
  t: ReturnType<typeof useTranslations<'Approvals'>>,
) {
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
        <p style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('toolSummary.proposedFileContent')}
        </p>
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
        <p style={{ fontVariationSettings: fontWeights.semibold }}>
          {t('toolSummary.requestedReplacements')}
        </p>
        <p className="break-words font-mono">{parsed.data.path}</p>
        <ol className="max-h-80 space-y-3 overflow-auto">
          {parsed.data.edits.map((edit, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the fingerprint fixes this immutable ordered edit list.
            <li key={`${plan.fingerprint}:${index}`}>
              <p className="text-muted-foreground">{t('toolSummary.before')}</p>
              <pre className="overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono">
                {edit.oldText}
              </pre>
              <p className="text-muted-foreground">{t('toolSummary.after')}</p>
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
        <p style={{ fontVariationSettings: fontWeights.semibold }}>{t('toolSummary.runCommand')}</p>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono">
          {source}
        </pre>
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">{t('toolSummary.shell')}</dt>
          <dd>{shellNames[command.shellId]}</dd>
          <dt className="text-muted-foreground">{t('toolSummary.workingDirectory')}</dt>
          <dd className="break-words font-mono">
            {command.cwd === '.' ? t('toolSummary.workingCopyRoot') : command.cwd}
          </dd>
          <dt className="text-muted-foreground">{t('toolSummary.mode')}</dt>
          <dd>
            {t(command.mode === 'service' ? 'toolSummary.service' : 'toolSummary.foreground')}
          </dd>
          <dt className="text-muted-foreground">{t('toolSummary.timeout')}</dt>
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
        <p style={{ fontVariationSettings: fontWeights.semibold }}>{t('toolSummary.editFile')}</p>
        <p className="break-words font-mono">{parsed.data.path}</p>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-2 font-mono">
          {parsed.data.ops}
        </pre>
      </div>
    );
  }
  return null;
}
