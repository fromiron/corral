import { useTranslations } from 'use-intl';

// Status is never conveyed by colour alone (Spec §10.3): every badge has a dot and text.

type Tone = 'neutral' | 'active' | 'success' | 'warning' | 'danger';

const TONE: Record<string, Tone> = {
  running: 'active',
  active: 'active',
  in_progress: 'active',
  attached_to_request: 'active',
  validating: 'active',
  succeeded: 'success',
  completed: 'success',
  delivered: 'success',
  submitted: 'success',
  failed: 'danger',
  rejected: 'danger',
  interrupted: 'danger',
  cancelled: 'warning',
  expired: 'warning',
  not_delivered: 'warning',
  delivery_unknown: 'warning',
  awaiting_user: 'warning',
  open: 'active',
  answered: 'success',
  timed_out: 'warning',
  waiting_children: 'active',
  waiting_message: 'active',
};

const DOT: Record<Tone, string> = {
  neutral: 'bg-muted/60',
  active: 'bg-accent animate-pulse',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

const TEXT: Record<Tone, string> = {
  neutral: 'text-muted',
  active: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

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
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-medium ${TEXT[statusTone(status)]}`}
    >
      <StatusDot status={status} />
      {label}
    </span>
  );
}
