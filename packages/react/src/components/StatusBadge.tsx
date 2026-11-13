import { useTranslations } from 'use-intl';
import { KitBadge } from '../design-kit/index.ts';

// Status is never conveyed by colour alone: every badge has a dot and text. These are the words of
// Tasks, instruction delivery, receipts and questions; a Run's or execution's state is its
// presence (PresenceBadge, docs/specs/features/presence.md).

type Tone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';

const TONE: Record<string, Tone> = {
  // A check's or a terminal's, never a Run's.
  running: 'active',
  in_progress: 'active',
  attached_to_request: 'active',
  completed: 'success',
  delivered: 'success',
  submitted: 'success',
  failed: 'danger',
  rejected: 'danger',
  cancelled: 'warning',
  expired: 'warning',
  not_delivered: 'warning',
  delivery_unknown: 'warning',
  open: 'active',
  answered: 'success',
  timed_out: 'warning',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-muted-foreground/60',
  active: 'bg-primary animate-pulse',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

const COLOR = {
  neutral: 'gray',
  active: 'gray',
  success: 'green',
  warning: 'amber',
  danger: 'red',
} as const;

export function statusTone(status: string): Tone {
  return TONE[status] ?? 'neutral';
}

/**
 * A status as a dot. Decorative beside a text label; with `label` it carries the status itself
 * (sidebar rows), so colour is never the only signal.
 */
export function StatusDot({ status, label }: { status: string; label?: string }) {
  const className = `inline-block size-2 shrink-0 rounded-full ${DOT[statusTone(status)]}`;
  return label ? (
    <span role="img" aria-label={label} title={label} data-status={status} className={className} />
  ) : (
    <span aria-hidden="true" data-status={status} className={className} />
  );
}

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('Status');
  const label = t.has(status) ? t(status) : status;
  return (
    <KitBadge variant="dot" color={COLOR[statusTone(status)]} data-status={status}>
      {label}
    </KitBadge>
  );
}
