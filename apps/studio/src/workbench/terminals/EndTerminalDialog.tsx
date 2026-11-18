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
import { useRef } from 'react';
import { useTranslations } from 'use-intl';
import { useModalConfirmation } from '../modalConfirmation.ts';

export function EndTerminalDialog({
  open,
  onKeep,
  onEnd,
  afterEnd,
}: {
  open: boolean;
  /** "그대로 두기", Escape or closing the dialog: the tab and the terminal stay. */
  onKeep: () => void;
  onEnd: () => void;
  /**
   * Where the focus goes once 끝내기 has closed the tab: where the strip's close rule sends it, or
   * null when the focus was not in the tab (it goes back where it was).
   */
  afterEnd: () => HTMLElement | null;
}) {
  const t = useTranslations('Terminals');
  // While it is up, global shortcuts and the panel's actions are held back.
  useModalConfirmation(open);
  // After 끝내기 the tab is gone and the focus goes where the strip's close rule sends it; kept,
  // it goes back where it was when the close began.
  const ended = useRef(false);
  if (open) ended.current = false;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onKeep())}>
      <DialogPopup finalFocus={() => (ended.current ? (afterEnd() ?? true) : true)}>
        <DialogHeader>
          <DialogTitle>{t('endTitle')}</DialogTitle>
          <DialogDescription>{t('endBody')}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="tertiary" onClick={onKeep}>
            {t('keepRunning')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              ended.current = true;
              onEnd();
            }}
          >
            {t('end')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
