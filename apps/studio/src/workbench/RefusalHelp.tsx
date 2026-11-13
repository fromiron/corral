import type {
  CommandError,
  HarnessBindingRef,
  ImageAttachment,
  PermissionMode,
  RunReference,
  TextAttachment,
} from '@corral/contracts';
import { Button } from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { useSettingsNavigation } from './navigation.ts';
import { type RefusalKind, refusalKind, terminalOwner } from './refusal.ts';

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
    references?: RunReference[];
    taskScope?: 'work' | 'review_only';
    verificationScope?: 'targeted' | 'release';
  },
) {
  window.dispatchEvent(
    new CustomEvent(EDIT_REQUEST, { detail: metadata ? { text, ...metadata } : text }),
  );
}

/** What helps after a refusal of this kind; the one list both the composer and the meta line use. */
export type RefusalAction =
  | 'openTerminal'
  | 'connect'
  | 'chooseImageModel'
  | 'retry'
  | 'queue'
  | 'edit';

export function refusalActions(
  kind: RefusalKind,
  can: { terminal: boolean; retry: boolean; queue: boolean; edit: boolean },
): RefusalAction[] {
  const actions: RefusalAction[] = [];
  if ((kind === 'terminal' || kind === 'terminalUncertain') && can.terminal)
    actions.push('openTerminal');
  if (kind === 'signin' || kind === 'profile') actions.push('connect');
  if (kind === 'image') actions.push('chooseImageModel');
  if (kind === 'network' && can.retry) actions.push('retry');
  if (kind === 'busy' && can.queue) actions.push('queue');
  if (can.edit) actions.push('edit');
  return actions;
}

/** The kinds whose runtime words are diagnostics, folded away under the explanation. */
export const REFUSAL_DIAGNOSTICS = new Set<RefusalKind>([
  'terminal',
  'terminalUncertain',
  'busy',
  'image',
  'capability',
]);

export interface RefusalProps {
  message: string;
  code?: string | undefined;
  network?: boolean;
  onEdit?: (() => void) | undefined;
  onRetry?: (() => void) | undefined;
  onQueue?: (() => void) | undefined;
  sessionId?: string | undefined;
  owner?: CommandError['owner'] | undefined;
  /**
   * A line that is not the place's main action (a sent message's meta line): every button is
   * the kit's quiet variant with these classes, never the primary one.
   */
  quiet?: string | undefined;
}

/** The buttons that help after a refusal, in the order `refusalActions` gives. */
export function RefusalActions({
  message,
  code,
  network = false,
  onEdit,
  onRetry,
  onQueue,
  sessionId,
  owner,
  quiet,
}: RefusalProps) {
  const t = useTranslations('Refusal');
  // The variant each action has where it is the next step; on a quiet line, all are ghost.
  const look = (variant: 'primary' | 'tertiary') =>
    quiet !== undefined
      ? ({ variant: 'ghost', className: quiet } as const)
      : ({ variant, className: 'shrink-0' } as const);
  const navigation = useSettingsNavigation();
  const kind = refusalKind({ code, message, network, owner });
  const terminalSession = owner?.sessionId ?? sessionId;
  return refusalActions(kind, {
    terminal: Boolean(terminalSession),
    retry: Boolean(onRetry),
    queue: Boolean(onQueue),
    edit: Boolean(onEdit),
  }).map((action) => {
    switch (action) {
      case 'openTerminal':
        return (
          <Button
            key={action}
            {...look('tertiary')}
            render={
              <Link
                to="/sessions/$sessionId"
                params={{ sessionId: terminalSession ?? '' }}
                search={{ panel: 'terminal', terminal: owner?.id ?? terminalOwner(message) }}
              />
            }
          >
            {t('openTerminal')}
          </Button>
        );
      case 'connect':
      case 'chooseImageModel':
        return (
          <Button
            key={action}
            {...look('primary')}
            render={<Link {...navigation.link('models')} />}
          >
            {t(action)}
          </Button>
        );
      case 'retry':
        return (
          <Button key={action} {...look('primary')} onClick={onRetry}>
            {t('retry')}
          </Button>
        );
      case 'queue':
        return (
          <Button key={action} {...look('tertiary')} onClick={onQueue}>
            {t('queue')}
          </Button>
        );
      default:
        return (
          <Button key={action} {...look('tertiary')} onClick={onEdit}>
            {t('edit')}
          </Button>
        );
    }
  });
}

/**
 * Why a request did not start and what to do about it: a short explanation in the
 * person's language, the runtime's own words kept for detail, and only the actions that help.
 */
export function RefusalHelp(props: RefusalProps) {
  const { message, code, network = false, owner } = props;
  const t = useTranslations('Refusal');
  const kind = refusalKind({ code, message, network, owner });
  return (
    <div
      role="alert"
      data-testid="refusal"
      data-kind={kind}
      className="flex flex-col gap-1.5 rounded-lg border border-danger/40 bg-danger/5 px-3 py-2 text-caption"
    >
      <p className="text-danger">{t(kind)}</p>
      {REFUSAL_DIAGNOSTICS.has(kind) ? (
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
        <RefusalActions {...props} />
      </div>
    </div>
  );
}
