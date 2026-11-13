import type { AdviceSeverity, CorralDefinition } from '@corral/contracts';
import { isSessionAdvisor, type RunProjection, unreadAdvice } from '@corral/core';
import { useCallback } from 'react';
import { useTranslations } from 'use-intl';
import { type DeliveryState, deliveryState } from './delivery.ts';

// How the screen names an advisor and its advice (docs/specs/features/advisor.md, 보이는 곳).

/**
 * A node's name: its label, or, for the advisor a conversation's session setting added, the one
 * word the screen calls it by (it has no name of its own).
 */
export function agentName(
  definition: CorralDefinition | Pick<CorralDefinition, 'nodes'> | null | undefined,
  nodeId: string,
  advisorWord: string,
): string {
  if (definition && isSessionAdvisor(definition as CorralDefinition, nodeId)) return advisorWord;
  return definition?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

/** `agentName` in the reader's language. */
export function useAgentName(
  definition: CorralDefinition | Pick<CorralDefinition, 'nodes'> | null | undefined,
) {
  const t = useTranslations('Advice');
  return useCallback(
    (nodeId: string) => agentName(definition, nodeId, t('advisor')),
    [definition, t],
  );
}

/** A severity's name; one this version has no name for is shown as it was recorded. */
export function useSeverityName() {
  const t = useTranslations('Advice');
  return useCallback(
    (severity: string) => (t.has(`severity.${severity}`) ? t(`severity.${severity}`) : severity),
    [t],
  );
}

/** An advice as its line shows it. */
export interface AdviceEntry {
  adviceId: string;
  observerExecutionId: string;
  targetExecutionId: string;
  severity: AdviceSeverity;
  text: string;
  /** Where in the run's record it was accepted. */
  seq: number;
}

/** An advice on its way to its target, or delivered: its line in the target's work. */
export interface DeliveredAdvice extends AdviceEntry {
  state: DeliveryState;
}

/**
 * The advice given to one execution that its work shows: on its way or delivered, in the order
 * it was accepted. Advice its target ended before reading is not here: a concern or a blocker
 * stays on the run row's tail (`unreadAdviceOf`), a note is dropped. Dropped advice is never
 * advice here (it has no line in the conversation).
 */
export function deliveredAdvice(
  projection: RunProjection,
  targetExecutionId: string,
): DeliveredAdvice[] {
  return Object.values(projection.advice ?? {})
    .filter((item) => item.targetExecutionId === targetExecutionId && item.directiveId)
    .sort((a, b) => a.acceptedSeq - b.acceptedSeq)
    .flatMap((item) => {
      const directive = projection.directives[item.directiveId ?? ''];
      if (!directive) return [];
      const state = deliveryState(projection, directive);
      if (state === 'ended' || directive.status === 'rejected') return [];
      return [
        {
          adviceId: item.adviceId,
          observerExecutionId: item.observerExecutionId,
          targetExecutionId: item.targetExecutionId,
          severity: item.severity,
          text: directive.text,
          seq: item.acceptedSeq,
          state,
        },
      ];
    });
}

/**
 * The run's advice no target read: kept because its target had ended, or a concern or blocker
 * its target ended before reading (core `unreadAdvice`, the same list Needs you holds).
 */
export function unreadAdviceOf(projection: RunProjection): AdviceEntry[] {
  return unreadAdvice(projection).map((item) => ({
    adviceId: item.adviceId,
    observerExecutionId: item.observerExecutionId,
    targetExecutionId: item.targetExecutionId,
    severity: item.severity,
    text: item.text,
    seq: projection.advice?.[item.adviceId]?.acceptedSeq ?? 0,
  }));
}

/** An advice's first line that has text: a model's reply may open with blank lines. */
export function firstLine(text: string): string {
  return (
    text
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ''
  );
}

const RANK: Record<string, number> = { nit: 0, concern: 1, blocker: 2 };

/** The most serious of several advice, which names them together. */
export function gravest(items: readonly Pick<AdviceEntry, 'severity'>[]): AdviceSeverity | null {
  return items.reduce<AdviceSeverity | null>(
    (worst, item) =>
      worst === null || (RANK[item.severity] ?? -1) > (RANK[worst] ?? -1) ? item.severity : worst,
    null,
  );
}
