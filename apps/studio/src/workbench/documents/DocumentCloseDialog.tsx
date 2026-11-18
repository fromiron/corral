import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import { type ComponentProps, useRef } from 'react';
import { useTranslations } from 'use-intl';
import type { CloseChoice } from './store.ts';

/**
 * The one confirmation for closing a document with unsaved changes, wherever it was open
 * (#87): the same question, the same three answers in the same order.
 */
export function DocumentCloseDialog({
  path,
  busy,
  failed,
  saveDisabled = false,
  discardDisabled = false,
  finalFocus,
  onChoose,
  onDismiss,
}: {
  /** The document being closed; `null` keeps the dialog shut. */
  path: string | null;
  busy: boolean;
  failed: boolean;
  saveDisabled?: boolean;
  discardDisabled?: boolean;
  finalFocus?: ComponentProps<typeof DialogPopup>['finalFocus'];
  onChoose(choice: CloseChoice): void;
  onDismiss(): void;
}) {
  const t = useTranslations('Documents');
  const keep = useRef<HTMLButtonElement>(null);
  return (
    <Dialog
      open={path !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onDismiss();
      }}
    >
      <DialogPopup
        finalFocus={finalFocus}
        // Asked, the person keeps editing unless they choose otherwise.
        initialFocus={keep}
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="flex flex-col gap-4 p-6"
      >
        <DialogTitle>{t('closeTitle', { path: path ?? '' })}</DialogTitle>
        <DialogDescription>{t('closeHint')}</DialogDescription>
        {failed ? (
          <p role="alert" className="text-body text-danger">
            {t('closeFailed')}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button ref={keep} variant="ghost" disabled={busy} onClick={() => onChoose('cancel')}>
            {t('cancel')}
          </Button>
          <Button
            variant="tertiary"
            disabled={busy || discardDisabled}
            onClick={() => onChoose('discard')}
          >
            {t('discard')}
          </Button>
          <Button disabled={busy || saveDisabled} onClick={() => onChoose('save')}>
            {t('saveClose')}
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
