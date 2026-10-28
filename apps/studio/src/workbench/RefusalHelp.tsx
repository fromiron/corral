import type {
  CommandError,
  HarnessBindingRef,
  ImageAttachment,
  PermissionMode,
  TextAttachment,
} from '@corral/contracts';
import { Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from './navigation.ts';
import { refusalKind, terminalOwner } from './refusal.ts';

/** Fired with a request's text to take it back into the request box. */
export const EDIT_REQUEST = 'corral:edit-request';
export const RESEND_REQUEST = 'corral:resend-request';

export function editRequest(
  text: string,
  metadata?: {
    harness?: HarnessBindingRef;
    permissionMode?: PermissionMode;
    attachments?: TextAttachment[];
    images?: ImageAttachment[];
    taskScope?: 'work' | 'review_only';
    verificationScope?: 'targeted' | 'release';
  },
) {
  window.dispatchEvent(
    new CustomEvent(EDIT_REQUEST, { detail: metadata ? { text, ...metadata } : text }),
  );
}

/**
 * Why a request did not start and what to do about it: a short explanation in the
 * person's language, the runtime's own words kept for detail, and only the actions that help.
 */
export function RefusalHelp({
  message,
  code,
  network = false,
  onEdit,
  onRetry,
  onQueue,
  sessionId,
  owner,
}: {
  message: string;
  code?: string | undefined;
  network?: boolean;
  onEdit?: () => void;
  onRetry?: () => void;
  onQueue?: () => void;
  sessionId?: string;
  owner?: CommandError['owner'];
}) {
  const t = useTranslations('Refusal');
  const navigation = useSettingsNavigation();
  const kind = refusalKind({ code, message, network, owner });
  return (
    <div
      role="alert"
      data-testid="refusal"
      data-kind={kind}
      className="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-xs"
    >
      <p className="text-danger">{t(kind)}</p>
      {kind === 'terminal' || kind === 'terminalUncertain' || kind === 'busy' ? (
        <details>
          <summary>{t('diagnostics')}</summary>
          <p className="text-muted-foreground wrap-anywhere" title={code}>
            {message}
          </p>
          {owner ? (
            <p>
              <code>{owner.id}</code> · {owner.state}
            </p>
          ) : null}
        </details>
      ) : (
        <p className="text-muted-foreground wrap-anywhere" title={code}>
          {message}
        </p>
      )}
      <div className="flex flex-wrap gap-1">
        {(kind === 'terminal' || kind === 'terminalUncertain') &&
        (owner?.sessionId ?? sessionId) ? (
          <Button
            size="compact"
            variant="tertiary"
            render={
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: owner?.sessionId ?? sessionId ?? '' }}
                search={{ panel: 'terminal', terminal: owner?.id ?? terminalOwner(message) }}
              />
            }
          >
            {t('openTerminal')}
          </Button>
        ) : null}
        {kind === 'signin' || kind === 'profile' ? (
          <Button size="compact" render={<Link {...navigation.link('models')} />}>
            {t('connect')}
          </Button>
        ) : null}
        {kind === 'network' && onRetry ? (
          <Button size="compact" onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
        {kind === 'busy' && onQueue ? (
          <Button size="compact" variant="tertiary" onClick={onQueue}>
            {t('queue')}
          </Button>
        ) : null}
        {onEdit ? (
          <Button size="compact" variant="tertiary" onClick={onEdit}>
            {t('edit')}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
