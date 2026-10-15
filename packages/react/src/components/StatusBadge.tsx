import { useTranslations } from 'use-intl';

// Status is never conveyed by colour alone (Spec §10.3): every badge has a symbol and text.

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

const SYMBOL: Record<Tone, string> = {
  neutral: '○',
  active: '◐',
  success: '✓',
  warning: '!',
  danger: '✕',
};

const CLASSES: Record<Tone, string> = {
  neutral: 'border-line text-muted',
  active: 'border-accent text-accent',
  success: 'border-success text-success',
  warning: 'border-warning text-warning',
  danger: 'border-danger text-danger',
};

export function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('Status');
  const tone = TONE[status] ?? 'neutral';
  const label = t.has(status) ? t(status) : status;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium ${CLASSES[tone]}`}
    >
      <span aria-hidden="true">{SYMBOL[tone]}</span>
      {label}
    </span>
  );
}
