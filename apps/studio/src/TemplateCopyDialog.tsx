import type { CorralSummary } from '@corral/core';
import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Input,
  Textarea,
} from '@corral/react/design-kit';
import { useNavigate } from '@tanstack/react-router';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from './services.tsx';
import {
  createFromTemplate,
  templateCopyName,
  useTemplateText,
  type WorkspaceTemplateId,
} from './templates.ts';
import { openNewTeam } from './workbench/editorView.ts';

export function TemplateCopyDialog({
  template,
  projectId,
  corrals,
  onClose,
}: {
  template: WorkspaceTemplateId;
  projectId: string;
  corrals: CorralSummary[];
  onClose(): void;
}) {
  const t = useTranslations('Workspace');
  const { repository } = useServices();
  const navigate = useNavigate();
  const text = useTemplateText();
  const blank = template === 'blank';
  const [brief, setBrief] = useState('');
  const [criterion, setCriterion] = useState('');
  const [name, setName] = useState(t(blank ? 'newName' : `template.${template}.name`));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameHintId = useId();
  const savedName = templateCopyName(name.trim(), projectId, corrals);
  const adjustedName = name.trim() && savedName !== name.trim();
  const ready = Boolean(name.trim() && (!blank || (brief.trim() && criterion.trim())));
  const save = async () => {
    if (busy || !ready) return;
    setBusy(true);
    setError('');
    try {
      const result = await createFromTemplate(
        repository,
        template,
        text,
        projectId,
        name,
        blank ? { brief: brief.trim(), criteria: [criterion.trim()] } : undefined,
      );
      if (!result.ok) {
        setError(result.message);
        return;
      }
      await openNewTeam(navigate, result.corralId);
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
          <DialogTitle>{t(blank ? 'chooseBlank' : 'saveCopyTitle')}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label={t('copyName')}
            aria-describedby={adjustedName ? nameHintId : undefined}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save();
            }}
          />
          {adjustedName ? (
            <p id={nameHintId} role="status" className="text-body text-muted-foreground">
              {t('copyNameAdjusted', { name: savedName })}
            </p>
          ) : null}
          {blank ? (
            <>
              <label className="grid gap-1 text-body">
                {t('creationBrief')}
                <Textarea
                  aria-label={t('creationBrief')}
                  disabled={busy}
                  value={brief}
                  placeholder={t('creationBriefExample')}
                  onChange={(event) => setBrief(event.target.value)}
                />
              </label>
              <label className="grid gap-1 text-body">
                {t('creationCriterion')}
                <Input
                  aria-label={t('creationCriterion')}
                  disabled={busy}
                  value={criterion}
                  placeholder={t('creationCriterionExample')}
                  onChange={(event) => setCriterion(event.target.value)}
                />
              </label>
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-body text-danger">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="tertiary" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={busy || !ready} onClick={() => void save()}>
            {t(blank ? 'creationSave' : 'saveCopyEdit')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
