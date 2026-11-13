import type { AdviceSeverity } from '@corral/contracts';
import type { RunProjection } from '../projection.ts';

// The advice a person should still see (features/inbox.md, `advice`): advice kept because its
// target had ended, and a concern or blocker whose target ended before it read it. A note that
// went unread is dropped; delivered advice is not listed.

export interface UnreadAdvice {
  adviceId: string;
  observerExecutionId: string;
  targetExecutionId: string;
  severity: AdviceSeverity;
  text: string;
  /** `preserved`: kept with its note; otherwise the state its directive ended in. */
  state: 'preserved' | 'expired' | 'not_delivered';
}

export function unreadAdvice(
  projection: Pick<RunProjection, 'advice' | 'directives'>,
): UnreadAdvice[] {
  const items: UnreadAdvice[] = [];
  const advice = Object.values(projection.advice ?? {}).sort(
    (a, b) => a.acceptedSeq - b.acceptedSeq,
  );
  for (const item of advice) {
    const head = {
      adviceId: item.adviceId,
      observerExecutionId: item.observerExecutionId,
      targetExecutionId: item.targetExecutionId,
      severity: item.severity,
    };
    if (item.delivery === 'preserve') {
      items.push({ ...head, text: item.note ?? '', state: 'preserved' });
      continue;
    }
    if (item.severity === 'nit' || !item.directiveId) continue;
    const directive = projection.directives[item.directiveId];
    if (directive?.status === 'expired' || directive?.status === 'not_delivered')
      items.push({ ...head, text: directive.text, state: directive.status });
  }
  return items;
}
