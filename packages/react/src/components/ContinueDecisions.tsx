import type { ApprovalView } from '@corral/core';
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { Banner, BannerTitle, type Decision, DecisionInbox } from '../design-kit/index.ts';
import type { RunSessionStore } from '../run/session.ts';
import { RequestRunContext } from './RequestCard.tsx';
import { nextResponseTarget } from './responseFocus.ts';

/**
 * A pause that only asks whether the run goes on: a run limit (no progress, a count reached).
 * Approvals about a version, a route, a check or a tool call are not.
 */
export const isContinueDecision = (approval: ApprovalView) =>
  !approval.tool && Boolean(approval.limit);

/**
 * A run's waiting continue-or-stop decisions in the kit's decision stack (DESIGN.md
 * `DecisionInbox`). The kit's optimistic answer is off: a click sends the decision, both answers
 * wait for its receipt and cannot be sent again, the receipt brings the confirmation, and the row
 * leaves when the run closes the request. A refused decision says why and can be answered again.
 */
export function ContinueDecisions({ session }: { session: RunSessionStore }) {
  const t = useTranslations('Approvals');
  const all = useStore(session, (s) => s.projection?.approvals);
  // A run limit is the run's, not a role's: with several runs' requests in one place, the run.
  const run = useContext(RequestRunContext);
  const open = useMemo(
    () => Object.values(all ?? {}).filter((a) => a.status === 'pending' && isContinueDecision(a)),
    [all],
  );
  // Decisions sent and waiting for their receipt; the ref closes the gap before a render.
  const inFlight = useRef(new Set<string>());
  const [sent, setSent] = useState<ReadonlySet<string>>(new Set());
  const [answered, setAnswered] = useState<Readonly<Record<string, string>>>({});
  const [refused, setRefused] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const handoff = useRef<{ approvalId: string; chat: Element | null; tray: Element | null } | null>(
    null,
  );
  // Pressable again (refused, or not confirmed) with the focus lost on the way: back to the
  // answer it was on. Focus the person moved elsewhere stays.
  const [refocus, setRefocus] = useState<{ approvalId: string; choice: string } | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: once when asked, not again as the waiting decisions change.
  useLayoutEffect(() => {
    if (!refocus) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    // The stack's rows are the open decisions, in order.
    const index = open.findIndex((approval) => approval.approvalId === refocus.approvalId);
    const row = box.current?.querySelectorAll('ul > li')[index];
    [...(row?.querySelectorAll<HTMLButtonElement>('button:not([disabled])') ?? [])]
      .find((button) => button.textContent?.trim() === refocus.choice)
      ?.focus({ preventScroll: true });
  }, [refocus]);
  const openIds = open.map((approval) => approval.approvalId).join(',');
  // Answered with focus on its buttons: the confirmation took their place, so focus moves on to
  // the next waiting card's first answer, else to the request box. Focus moved elsewhere stays.
  useEffect(() => {
    void openIds;
    const owned = handoff.current;
    if (!owned || answered[owned.approvalId] === undefined) return;
    const frame = requestAnimationFrame(() => {
      handoff.current = null;
      if (document.activeElement && document.activeElement !== document.body) return;
      nextResponseTarget(owned.tray?.isConnected ? owned.tray : box.current, owned.chat)?.focus({
        preventScroll: true,
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [answered, openIds]);
  // The area left with the answer (its run waits on nothing else): the same hand-off, from the
  // response place the decision stood in.
  useEffect(
    () => () => {
      const owned = handoff.current;
      if (!owned) return;
      requestAnimationFrame(() => {
        if (document.activeElement && document.activeElement !== document.body) return;
        nextResponseTarget(owned.tray?.isConnected ? owned.tray : null, owned.chat)?.focus({
          preventScroll: true,
        });
      });
    },
    [],
  );
  if (!open.length) return null;

  const title = (approval: ApprovalView) =>
    approval.limit
      ? t(`limit.title.${approval.limit.kind}`, {
          used: approval.limit.used,
          max: approval.limit.max,
        })
      : '';
  // Who waits comes first, where the place names it, as under a request card's title.
  const detail = run ? `${run}\n${t('limit.explain')}` : t('limit.explain');
  const answers = (approval: ApprovalView) => ({
    primary: {
      label: t('limit.approve'),
      doneLabel: t('doneLimit', { limit: title(approval) }),
    },
    secondary: { label: t('limit.reject'), doneLabel: t('continueStopped') },
  });
  const decide = async (approvalId: string, choice: 'primary' | 'secondary') => {
    const approval = open.find((item) => item.approvalId === approvalId);
    if (!approval || inFlight.current.has(approvalId) || answered[approvalId] !== undefined) return;
    inFlight.current.add(approvalId);
    handoff.current = box.current?.contains(document.activeElement)
      ? {
          approvalId,
          chat: box.current.closest('[data-chat-view]'),
          // The response place: a conversation's needed-now tray, else the run's whole response
          // area (Needs you, the Run page), so an approval card beside it is next.
          tray:
            box.current.closest('[data-pending-tray]') ??
            box.current.closest('[data-run-response]'),
        }
      : null;
    setSent((current) => new Set(current).add(approvalId));
    setRefused(null);
    // Answered from its buttons and pressable again: the focus goes back to the answer pressed.
    const giveBack = () => {
      if (handoff.current?.approvalId !== approvalId) return;
      handoff.current = null;
      const action = answers(approval)[choice];
      setRefocus({ approvalId, choice: action.label });
    };
    const settle = () => {
      inFlight.current.delete(approvalId);
      setSent((current) => {
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
    };
    try {
      const receipt = await session
        .getState()
        .resolveApproval(approvalId, choice === 'primary' ? 'approve' : 'reject');
      settle();
      if (receipt.error) {
        giveBack();
        setRefused(t('refused', { message: receipt.error.message }));
        return;
      }
      const action = answers(approval)[choice];
      setAnswered((current) => ({ ...current, [approvalId]: action.doneLabel }));
    } catch {
      // The session keeps the unconfirmed command; the decision still waits and may be sent again.
      giveBack();
      settle();
    }
  };
  const decisions: Decision[] = open.map((approval) => ({
    id: approval.approvalId,
    title: title(approval),
    detail,
    ...answers(approval),
    pending: sent.has(approval.approvalId),
    ...(answered[approval.approvalId] === undefined
      ? {}
      : { resolution: answered[approval.approvalId] }),
  }));
  return (
    <div ref={box} data-continue-decisions className="flex flex-col gap-2">
      <DecisionInbox
        decisions={decisions}
        optimistic={false}
        onDecide={(id, choice) => void decide(id, choice)}
        heading={(count) => (count > 0 ? t('continueHeading', { count }) : t('continueAnswered'))}
        clearHeading={t('continueAnswered')}
        emptyLabel=""
        // Several runs' stacks stand together in the tray: each named by its run as well.
        labels={{ region: run ? t('continueRegionOfRun', { run }) : t('continueRegion') }}
      />
      {refused ? (
        <Banner role="alert" status="error">
          <BannerTitle>{refused}</BannerTitle>
        </Banner>
      ) : null}
    </div>
  );
}
