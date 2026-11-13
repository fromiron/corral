import type { CorralDefinition } from '@corral/contracts';
import { isSessionAdvisor } from '@corral/core';
import { useCallback } from 'react';
import { useTranslations } from 'use-intl';

// How the screen names an advisor and its advice (docs/specs/features/advisor.md, 보이는 곳).

/**
 * A node's name: its label, or, for the advisor a conversation's session setting added, the one
 * word the screen calls it by (it has no name of its own).
 */
export function agentName(
  definition: CorralDefinition | null | undefined,
  nodeId: string,
  advisorWord: string,
): string {
  if (definition && isSessionAdvisor(definition, nodeId)) return advisorWord;
  return definition?.nodes.find((node) => node.id === nodeId)?.label ?? nodeId;
}

/** `agentName` in the reader's language. */
export function useAgentName(definition: CorralDefinition | null | undefined) {
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
