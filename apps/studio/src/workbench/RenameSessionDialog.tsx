import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
} from '@corral/react/design-kit';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';

/**
 * Renaming a session, wherever it starts: the sidebar row, the session menu or `/rename`
 * (#92). `title` opens the dialog with the current name; `null` closes it.
 */
export function RenameSessionDialog({
  title,
  busy = false,
  error,
  onSave,
  onClose,
}: {
  title: string | null;
  busy?: boolean;
  error?: string | null;
  /** Resolves true once the name is saved, which closes the dialog. */
  onSave(title: string): Promise<boolean>;
  onClose(): void;
}) {
  const t = useTranslations('Desktop');
  const [value, setValue] = useState(title ?? '');
  useEffect(() => {
    if (title !== null) setValue(title);
  }, [title]);
  const save = () => {
    if (busy || !value.trim()) return;
    void onSave(value).then((saved) => saved && onClose());
  };
  return (
    <Dialog open={title !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogPopup data-testid="rename-session-dialog">
        <DialogHeader>
          <DialogTitle>{t('rename')}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label={t('sessionTitle')}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) save();
            }}
          />
        </DialogPanel>
        {error ? (
          <p role="alert" className="px-6 text-sm text-danger">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button disabled={busy || !value.trim()} onClick={save}>
            {t('save')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
