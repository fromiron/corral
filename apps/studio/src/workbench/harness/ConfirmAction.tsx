import { Button, Dialog, DialogDescription, DialogPopup, DialogTitle } from '@corral/react/ui';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

export function useManagementConfirmation() {
  const t = useTranslations('Resources');
  const [pending, setPending] = useState<{
    message: string;
    action: () => void;
  } | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  return {
    request(message: string, action: () => void) {
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setPending({ message, action });
    },
    dialog: (
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogPopup className="p-6" showCloseButton={false} finalFocus={returnFocus}>
          <DialogTitle>{t('confirmChange')}</DialogTitle>
          <DialogDescription className="my-4">{pending?.message}</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPending(null)}>
              {t('cancel')}
            </Button>
            <Button
              onClick={() => {
                const action = pending?.action;
                setPending(null);
                action?.();
              }}
            >
              {t('confirm')}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    ),
  };
}
