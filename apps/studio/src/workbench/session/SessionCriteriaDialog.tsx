import {
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import { type FormEvent, type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { CriteriaField } from '../CriteriaField.tsx';
import { readCriteria } from '../sessionCriteria.ts';

/**
 * How a save ended: saved (the dialog closes), a notice that leaves the next Save to the person,
 * or a failure. Both keep what was typed.
 */
export type CriteriaSave = { kind: 'saved' } | { kind: 'notice' | 'failed'; message: string };

/**
 * A work session's completion criteria, read and edited as a plain list, one per line
 * (docs/specs/workbench.md#세션-완료-기준). `criteria` opens it with the saved lines; `null`
 * closes it. Whatever the save says, what was typed stays.
 */
export function SessionCriteriaDialog({
  criteria,
  opener,
  onSave,
  onClose,
}: {
  criteria: readonly string[] | null;
  /** The control that opened it, which takes focus back when it closes. */
  opener: RefObject<HTMLElement | null>;
  onSave(criteria: string[]): Promise<CriteriaSave>;
  onClose(): void;
}) {
  const t = useTranslations('Sessions');
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [outcome, setOutcome] = useState<Exclude<CriteriaSave, { kind: 'saved' }> | null>(null);
  const [saving, setSaving] = useState(false);
  // Each opening starts from the saved lines; closing keeps the text while the dialog leaves.
  useEffect(() => {
    if (criteria === null) return;
    setText(criteria.join('\n'));
    setOutcome(null);
  }, [criteria]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || criteria === null) return;
    const lines = readCriteria(text);
    // Past a limit the field already says which; nothing is sent.
    if (!lines) return field.current?.focus();
    setSaving(true);
    setOutcome(null);
    try {
      const result = await onSave(lines);
      if (result.kind === 'saved') onClose();
      else setOutcome(result);
    } catch (failure) {
      setOutcome({
        kind: 'failed',
        message: t('failed', {
          message: failure instanceof Error ? failure.message : String(failure),
        }),
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open={criteria !== null}
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup
        initialFocus={field}
        // A menu item that opened it is gone by now: its menu's trigger stands in for it.
        finalFocus={() => (opener.current?.isConnected ? opener.current : true)}
        className="w-[min(95vw,560px)]"
      >
        <form onSubmit={save} aria-labelledby={`${id}-title`}>
          <DialogHeader>
            <DialogTitle id={`${id}-title`}>{t('criteria.label')}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-3">
              <CriteriaField
                id={`${id}-criteria`}
                labelHidden
                fieldRef={field}
                disabled={saving}
                value={text}
                onChange={setText}
              />
              {outcome?.kind === 'failed' ? (
                <p role="alert" className="text-body text-destructive">
                  {outcome.message}
                </p>
              ) : outcome ? (
                // Not a failure: what changed, and what the next Save does.
                <p role="status" className="text-body text-warning">
                  {outcome.message}
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button variant="tertiary" disabled={saving} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={saving}>
              {t('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
