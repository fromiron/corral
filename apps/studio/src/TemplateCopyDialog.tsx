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
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from './services.tsx';
import { createFromTemplate, type WorkspaceTemplateId } from './templates.ts';

export function TemplateCopyDialog({
  template,
  projectId,
  onSaved,
  onClose,
}: {
  template: WorkspaceTemplateId;
  projectId: string;
  onSaved(corralId: string): Promise<void>;
  onClose(): void;
}) {
  const t = useTranslations('Workspace');
  const { repository } = useServices();
  const [name, setName] = useState(
    t(template === 'blank' ? 'newName' : `template.${template}.name`),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    if (busy || !name.trim()) return;
    setBusy(true);
    setError('');
    try {
      const result = await createFromTemplate(repository, template, t('newName'), projectId, name);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await onSaved(result.corralId);
      onClose();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t('saveCopyTitle')}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label={t('copyName')}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save();
            }}
          />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="tertiary" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy || !name.trim()} onClick={() => void save()}>
            {t('saveCopyEdit')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
