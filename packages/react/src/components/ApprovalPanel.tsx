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
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
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
  SizeScope,
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

/** One line of a call's main subject: the command it runs or the file it touches. */
function callSubject(plan: ToolPermissionPlan): string | null {
  if (plan.descriptor.source !== 'corral') return null;
  const args = plan.arguments as Record<string, unknown>;
  const request = args.request as Record<string, unknown> | undefined;
  const text =
    plan.descriptor.name === 'run_command'
      ? [args.command, request?.command].find((value) => typeof value === 'string')
      : [args.path, args.from].find((value) => typeof value === 'string');
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.trim().split('\n');
  const first = lines[0]?.trim() ?? '';
  return first.length > 80 || lines.length > 1 ? `${first.slice(0, 79)}…` : first;
}

/**
 * Decisions waiting for the person: each says in words what it is about (the versions and
 * criteria, the call, or the run limit that paused the run). Approving applies to that subject
 * only; a newer version needs its own. Internal identifiers stay in titles and collapsed details.
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
  const executions = useStore(session, (s) => s.projection?.executions);
  const toolCalls = useStore(session, (s) => s.projection?.toolCalls);
  const nodes = useStore(session, (s) => s.definition?.nodes);
  const tTurn = useTranslations('Turn');
  const approvals = useMemo(
    () => Object.values(all ?? {}).filter((a) => a.status === 'pending'),
    [all],
  );
  // A card the run-wide decision covered leaves with no line of its own: that decision says it.
  const done = useMemo(
    () =>
      Object.values(all ?? {}).filter(
        (a) => a.status === 'approved' && a.reason !== 'allowed_for_run',
      ),
    [all],
  );
  // The criteria a decision about versions is judged by; a run limit and a tool call have none.
  const criteriaId = approvals.find((a) => !a.limit && !a.tool)?.criteriaVersionId;
  const criteria = useStore(session, (s) => (criteriaId ? s.artifactTexts[criteriaId] : undefined));
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<Receipt | null>(null);
  const [toolPlans, setToolPlans] = useState<Record<string, ToolPermissionPlan | null>>({});
  const [checkPlans, setCheckPlans] = useState<Record<string, CheckPlan | null>>({});

  // Waiting calls show their details; calls already allowed are named by them in their line.
  const described = useMemo(
    () => [...approvals, ...(compact ? [] : done)].filter((approval) => approval.tool),
    [approvals, done, compact],
  );
  useEffect(() => {
    let active = true;
    for (const approval of described) {
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
  }, [described, session]);

  useEffect(() => {
    if (criteriaId) void session.getState().loadArtifact(criteriaId);
  }, [session, criteriaId]);

  // A decision sent while focus was in its card hands focus on once the card has left and the
  // decision's receipt is in (the buttons are enabled again), as an answered question does: to
  // the next waiting card's main action (its decline when that action cannot be taken), else, in
  // a chat view, to the request box. Focus the person moved elsewhere stays; other hosts (the Run
  // page, Needs you) place focus themselves once nothing waits.
  const section = useRef<HTMLElement>(null);
  const handoff = useRef<{ approvalId: string; chat: Element | null } | null>(null);
  useEffect(() => {
    const owned = handoff.current;
    if (!owned || busy || approvals.some((approval) => approval.approvalId === owned.approvalId))
      return;
    const frame = requestAnimationFrame(() => {
      handoff.current = null;
      if (document.activeElement && document.activeElement !== document.body) return;
      const next = section.current?.querySelector<HTMLElement>('[data-approval]');
      const target =
        next?.querySelector<HTMLButtonElement>('[data-approval-action="primary"]:not(:disabled)') ??
        next?.querySelector<HTMLButtonElement>('[data-approval-action]:not(:disabled)') ??
        (owned.chat?.isConnected
          ? owned.chat.querySelector<HTMLTextAreaElement>('[data-testid=chat-composer] textarea')
          : null);
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [approvals, busy]);

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
  /** A version by its name; an id the run does not name stays out of the visible text. */
  const label = (id: string) =>
    artifacts?.[id] ? `${artifacts[id].name} v${artifacts[id].version}` : null;
  /** Which limit paused the run, and at what count. */
  const limitText = (limit: NonNullable<ApprovalView['limit']>) =>
    t(`limit.title.${limit.kind}`, { used: limit.used, max: limit.max });
  /** What waits; a breakpoint names the step it holds, a run limit the limit. */
  const kindText = (approval: ApprovalView) =>
    approval.limit
      ? limitText(approval.limit)
      : t(`kind.${copyKey(approval)}`, {
          step: nodes?.find((node) => node.id === approval.nodeId)?.label ?? approval.nodeId ?? '',
        });
  const toolLabel = (name: string) => (tTurn.has(`tool.${name}`) ? tTurn(`tool.${name}`) : name);
  /** A decision already made, in words: the limit, the call or check, or the version. */
  const doneText = (approval: ApprovalView) => {
    if (approval.limit) return t('doneLimit', { limit: limitText(approval.limit) });
    if (approval.tool?.purpose === 'tool') {
      const plan = toolPlans[approval.tool.bodyRef];
      const name = plan?.descriptor.name ?? toolCalls?.[approval.tool.toolCallId]?.name;
      const subject = plan ? callSubject(plan) : null;
      const tool = name ? toolLabel(name) : t('toolHeading');
      const call = subject ? `${tool} · ${subject}` : tool;
      return t(approval.scope === 'run' ? 'doneToolRun' : 'doneTool', { call });
    }
    if (approval.tool) {
      const name = checkPlans[approval.tool.bodyRef]?.name;
      const step = t(approval.tool.purpose === 'lsp' ? 'doneLsp' : 'doneCheck');
      return name ? `${step}: ${name}` : step;
    }
    const subject = label(approval.subjectVersionIds[0] ?? '');
    return subject
      ? t('done', { step: kindText(approval), subject })
      : t('doneBare', { step: kindText(approval) });
  };
  /** The agent that asks, named only where the run has more than one. */
  const askedBy = (executionId: string) => {
    if (Object.keys(executions ?? {}).length < 2) return null;
    const nodeId = executions?.[executionId]?.nodeId;
    return nodes?.find((node) => node.id === nodeId)?.label ?? null;
  };
  const decide = async (
    approvalId: string,
    decision: 'approve' | 'reject',
    options?: { routeId?: string; scope?: 'run' },
  ) => {
    // Focus in this decision's card is handed on when the card leaves.
    handoff.current = document.activeElement?.closest(`[data-approval="${approvalId}"]`)
      ? { approvalId, chat: section.current?.closest('[data-chat-view]') ?? null }
      : null;
    setBusy(true);
    try {
      const receipt = options
        ? await session.getState().resolveApproval(approvalId, decision, options)
        : await session.getState().resolveApproval(approvalId, decision);
      setRefused(receipt.error ? receipt : null);
      // Refused: the card stays, and so does the person's focus.
      if (receipt.error && handoff.current?.approvalId === approvalId) handoff.current = null;
    } catch {
      // The session preserves the unconfirmed receipt; approval stays pending.
    } finally {
      setBusy(false);
    }
  };

  // Buttons are the only way to decide: the card has no Enter/Escape shortcut. As in the kit's
  // permission card, the decline sits left of the primary action, and as there and in the kit
  // run screen's approval card, the decision row is compact at every interface density.
  const decisionButtons = (approval: (typeof approvals)[number]) => (
    <SizeScope size="compact">{decisionRow(approval)}</SizeScope>
  );
  /** Decline, then approve; a tool call also offers approving it for the run. */
  const answers = (approval: (typeof approvals)[number]) => (
    <>
      <Button
        variant="tertiary"
        disabled={busy}
        data-approval-action="decline"
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
          : approval.limit
            ? t('limit.reject')
            : t(`rejectAs.${copyKey(approval)}`)}
      </Button>
      {approval.tool?.purpose === 'tool' ? (
        // The same call again needs no answer until the run ends; a command is matched by its
        // launch, so it reaches past the run's file changes, and any other change asks again.
        <Button
          variant="secondary"
          data-approval-action="run"
          disabled={busy || !toolPlans[approval.tool.bodyRef]}
          title={t(approval.tool.grantFingerprint ? 'toolRunCommand' : 'toolRun')}
          onClick={() => void decide(approval.approvalId, 'approve', { scope: 'run' })}
        >
          {t('approveToolRun')}
        </Button>
      ) : null}
      <Button
        data-approval-action="primary"
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
            : approval.limit
              ? t('limit.then')
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
          : approval.limit
            ? t('limit.approve')
            : t(`approveAs.${copyKey(approval)}`)}
      </Button>
    </>
  );
  const decisionRow = (approval: (typeof approvals)[number]) =>
    approval.kind === 'route' ? (
      // A router that could not choose: each connected route is its own answer.
      <>
        <Button
          variant="tertiary"
          disabled={busy}
          data-approval-action="decline"
          onClick={() => void decide(approval.approvalId, 'reject')}
        >
          {t('rejectAs.route')}
        </Button>
        {(approval.routes ?? []).map((route, index) => (
          <Button
            key={route.id}
            variant="secondary"
            disabled={busy}
            // The first route is the card's main action when focus is handed to it.
            data-approval-action={index === 0 ? 'primary' : 'route'}
            title={t('then.route')}
            onClick={() => void decide(approval.approvalId, 'approve', { routeId: route.id })}
          >
            {route.label}
          </Button>
        ))}
      </>
    ) : approval.tool?.purpose === 'tool' ? (
      <>
        {policySettingsAction ? (
          // The rules of later runs are a way out of the card, apart from its decisions.
          <span className="mr-auto flex">{policySettingsAction}</span>
        ) : null}
        {/* The decisions wrap as one group, so a narrow card never parts them. */}
        <span className="flex flex-wrap justify-end gap-2">{answers(approval)}</span>
      </>
    ) : (
      answers(approval)
    );

  return (
    <>
      {related}
      {showPlan ? <WorkPlanPanel session={session} /> : null}
      <section
        ref={section}
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
            // The exact versions stay at hand for diagnostics, never as the line's words.
            title={approval.subjectVersionIds.join(', ')}
            className="flex items-center gap-1.5 text-caption text-muted-foreground"
          >
            {index === 0 ? <RowAction action={doneAction} /> : null}
            <AgentStatusIcon status="done" size={12} />
            {doneText(approval)}
          </p>
        ))}
        {approvals.map((approval, index) => (
          <AgentCard
            key={approval.approvalId}
            data-testid={`approval-${approval.approvalId}`}
            data-approval={approval.approvalId}
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
                {approval.tool && !compact && askedBy(approval.tool.executionId) ? (
                  <span className="truncate text-muted-foreground">
                    {askedBy(approval.tool.executionId)}
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
                        {t(approval.tool.purpose === 'lsp' ? 'lspOnce' : 'checkOnce')}
                      </p>
                      <Accordion>
                        <AccordionItem value="identity">
                          <AccordionTrigger>{t('checkIdentity')}</AccordionTrigger>
                          <AccordionContent>
                            <p className="break-all">
                              {t('checkScope', {
                                execution: approval.tool.executionId,
                                attempt: approval.tool.attemptNo,
                                revision: checkPlans[approval.tool.bodyRef]?.configRevision ?? 0,
                                fingerprint: approval.tool.fingerprint.slice(0, 12),
                                tree: approval.tool.targetTree?.slice(0, 12) ?? '—',
                              })}
                            </p>
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
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
                <p className="text-muted-foreground">
                  {approval.limit ? t('limit.explain') : t(`explain.${copyKey(approval)}`)}
                </p>
              )}
              {/* A run limit is about the run, not a version: it names no subject or criteria. */}
              {approval.tool ||
              approval.limit ||
              !approval.subjectVersionIds.some((id) => label(id)) ? null : (
                <div className="flex flex-wrap items-center gap-1">
                  <span className="text-muted-foreground">{t('subject')}</span>
                  {approval.subjectVersionIds.flatMap((id) => {
                    const name = label(id);
                    return name
                      ? [
                          <Button
                            key={id}
                            variant="tertiary"
                            size="compact"
                            title={id}
                            onClick={() => onOpenArtifact(id)}
                          >
                            {name}
                          </Button>,
                        ]
                      : [];
                  })}
                </div>
              )}
              {criteria && !approval.limit && approval.criteriaVersionId === criteriaId ? (
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
              <Banner role="alert" status="error" className="mx-3 mb-3">
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
