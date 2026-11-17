// Asks before closing a terminal's tab ends a command that may be running (features/session-panel.md
// 터미널 탭): "그대로 두기" first and focused, then "끝내기". Nothing is sent while it asks.
import {
  Button,
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import { useTranslations } from 'use-intl';
import { useModalConfirmation } from '../modalConfirmation.ts';

export function EndTerminalDialog({
  open,
  onKeep,
  onEnd,
}: {
  open: boolean;
  /** "그대로 두기", Escape or closing the dialog: the tab and the terminal stay. */
  onKeep: () => void;
  onEnd: () => void;
}) {
  const t = useTranslations('Terminals');
  // While it is up, global shortcuts and the panel's actions are held back.
  useModalConfirmation(open);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onKeep())}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t('endTitle')}</DialogTitle>
          <DialogDescription>{t('endBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="tertiary" onClick={onKeep}>
            {t('keepRunning')}
          </Button>
          <Button variant="destructive" onClick={onEnd}>
            {t('end')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
