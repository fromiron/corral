import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import type { ComponentProps } from 'react';
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
  return (
    <Dialog
      open={path !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onDismiss();
      }}
    >
      <DialogPopup
        finalFocus={finalFocus}
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="flex flex-col gap-4 p-6"
      >
        <DialogTitle>{t('closeTitle', { path: path ?? '' })}</DialogTitle>
        <DialogDescription>{t('closeHint')}</DialogDescription>
        {failed ? (
          <p role="alert" className="text-sm text-danger">
            {t('closeFailed')}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" disabled={busy} onClick={() => onChoose('cancel')}>
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
