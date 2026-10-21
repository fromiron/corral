import type {
  HarnessBindingRef,
  ImageAttachment,
  PermissionMode,
  TextAttachment,
  UltraSelection,
} from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from './navigation.ts';
import { refusalKind } from './refusal.ts';

/** Fired with a request's text to take it back into the request box (UX-04). */
export const EDIT_REQUEST = 'corral:edit-request';

export function editRequest(
  text: string,
  metadata?: {
    harness?: HarnessBindingRef;
    permissionMode?: PermissionMode;
    attachments?: TextAttachment[];
    images?: ImageAttachment[];
    qualityPreset?: 'default' | 'ultra';
    ultra?: UltraSelection;
    taskScope?: 'work' | 'review_only';
    verificationScope?: 'targeted' | 'release';
  },
) {
  window.dispatchEvent(
    new CustomEvent(EDIT_REQUEST, { detail: metadata ? { text, ...metadata } : text }),
  );
}

/**
 * Why a request did not start and what to do about it (UX-04): a short explanation in the
 * person's language, the runtime's own words kept for detail, and only the actions that help.
 */
export function RefusalHelp({
  message,
  code,
  network = false,
  onEdit,
  onRetry,
  onQueue,
}: {
  message: string;
  code?: string | undefined;
  network?: boolean;
  onEdit?: () => void;
  onRetry?: () => void;
  onQueue?: () => void;
}) {
  const t = useTranslations('Refusal');
  const navigation = useSettingsNavigation();
  const kind = refusalKind({ code, message, network });
  return (
    <div
      role="alert"
      data-testid="refusal"
      data-kind={kind}
      className="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs"
    >
      <p className="text-danger">{t(kind)}</p>
      <p className="text-muted wrap-anywhere" title={code}>
        {message}
      </p>
      <div className="flex flex-wrap gap-1">
        {kind === 'signin' || kind === 'profile' ? (
          <Button size="xs" render={<Link {...navigation.link('models')} />}>
            {t('connect')}
          </Button>
        ) : null}
        {kind === 'network' && onRetry ? (
          <Button size="xs" onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
        {kind === 'busy' && onQueue ? (
          <Button size="xs" variant="outline" onClick={onQueue}>
            {t('queue')}
          </Button>
        ) : null}
        {onEdit ? (
          <Button size="xs" variant="outline" onClick={onEdit}>
            {t('edit')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
