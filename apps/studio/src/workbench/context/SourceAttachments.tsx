import {
  type TextAttachment,
  type TextAttachmentProvenance,
  type TextRange,
  textAttachmentKey,
  type WorkspaceTarget,
} from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
} from '@corral/react/design-kit';
import { createContext, useContext, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type StudioServices, useServices } from '../../services.tsx';
import { QuoteChip } from '../TextAttachments.tsx';
import {
  AttachmentSource,
  ContextAttachments,
  type ContextSourceStatus,
} from './ContextAttachments.tsx';
import { readAttachmentSource, recaptureAttachmentSource } from './sources.ts';

export const SourceNavigationContext = createContext<{
  openDocument(target: WorkspaceTarget, path: string, range?: TextRange): boolean;
  openTerminal(source: Extract<TextAttachmentProvenance, { kind: 'terminal' }>): void;
} | null>(null);

const isQuote = (item: TextAttachment) => item.provenance?.kind === 'reply';

type Preview = {
  owner: StudioServices;
  item: TextAttachment;
  state?: ContextSourceStatus['state'];
  replace: boolean;
};
export function SourceAttachments(props: {
  value: TextAttachment[];
  disabled?: boolean;
  onChange(value: TextAttachment[]): void;
}) {
  const services = useServices();
  const navigation = useContext(SourceNavigationContext);
  const t = useTranslations('Context');
  const tc = useTranslations('Composer');
  const current = useRef({ services, props });
  current.current = { services, props };
  const alive = useRef(true);
  const resolve = useRef<((item: TextAttachment | null) => void) | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      resolve.current?.(null);
      resolve.current = null;
    };
  }, []);
  const isCurrent = () => alive.current && current.current.services === services;
  const close = (replacement: TextAttachment | null = null) => {
    const finish = resolve.current;
    resolve.current = null;
    setPreview(null);
    finish?.(
      current.current.props.disabled || preview?.owner !== current.current.services
        ? null
        : replacement,
    );
  };
  const open = async (item: TextAttachment) => {
    let state: ContextSourceStatus['state'] = 'unavailable';
    try {
      const source = item.provenance;
      const read = await readAttachmentSource(services, item);
      if (!isCurrent()) return;
      state = read.state;
      if (source?.kind === 'code' && state === 'current' && navigation) {
        const loaded = await recaptureAttachmentSource(services, item);
        if (!isCurrent()) return;
        if (
          loaded?.provenance?.kind === 'code' &&
          loaded.provenance.bufferHash === source.bufferHash &&
          navigation.openDocument(source.target, source.path, source.range)
        )
          return;
        state = 'stale';
      } else if (source?.kind === 'terminal' && state === 'current' && navigation) {
        // TerminalView rechecks/reveals after its retained runtime is mounted.
        navigation.openTerminal(source);
        return;
      }
    } catch {
      state = 'unavailable';
    }
    if (isCurrent()) setPreview({ owner: services, item, state, replace: false });
  };
  const replace = async (item: TextAttachment): Promise<TextAttachment | null> => {
    if (current.current.props.disabled) return null;
    if (item.provenance?.kind === 'preview') throw new Error(t('previewRecapture'));
    const candidate = await recaptureAttachmentSource(services, item);
    if (!isCurrent() || current.current.props.disabled) return null;
    if (!candidate) throw new Error(t('replacementFailed'));
    resolve.current?.(null);
    return new Promise((done) => {
      resolve.current = done;
      setPreview({ owner: services, item: candidate, replace: true });
    });
  };
  // A reply quote is a chip; the other captures are source rows. Both edit the one list in order.
  const changeCaptures = (next: TextAttachment[]) => {
    const value = current.current.props.value;
    let at = 0;
    const kept = new Set(next.map(textAttachmentKey));
    current.current.props.onChange(
      next.length === value.filter((item) => !isQuote(item)).length
        ? value.map((item) => (isQuote(item) ? item : (next[at++] ?? item)))
        : value.filter((item) => isQuote(item) || kept.has(textAttachmentKey(item))),
    );
  };
  const removeQuote = (key: string) => {
    if (current.current.props.disabled) return;
    current.current.props.onChange(
      current.current.props.value.filter((item) => textAttachmentKey(item) !== key),
    );
  };
  const quotes = props.value.filter(isQuote);
  return (
    <>
      {quotes.length ? (
        <ul aria-label={tc('quotes')} className="flex flex-wrap gap-1">
          {quotes.map((item) => (
            <QuoteChip
              key={textAttachmentKey(item)}
              item={item}
              disabled={props.disabled}
              onRemove={() => removeQuote(textAttachmentKey(item))}
            />
          ))}
        </ul>
      ) : null}
      <ContextAttachments
        {...props}
        value={props.value.filter((item) => !isQuote(item))}
        onChange={changeCaptures}
        inspect={(item) => readAttachmentSource(services, item)}
        onOpen={open}
        onReplace={replace}
      />
      <Dialog
        open={Boolean(preview)}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        <DialogPopup className="flex max-w-3xl flex-col gap-3 p-6" showCloseButton={false}>
          <DialogTitle>{t(preview?.replace ? 'replacementPreview' : 'sourcePreview')}</DialogTitle>
          <DialogDescription>{t('readonlySnapshot')}</DialogDescription>
          {preview ? (
            <>
              {preview.item.provenance ? (
                <AttachmentSource source={preview.item.provenance} />
              ) : null}
              {preview.state ? (
                <p role="status" className="text-caption text-muted-foreground">
                  {t(
                    preview.item.provenance?.kind === 'preview' && preview.state === 'current'
                      ? 'previewCurrent'
                      : preview.state,
                  )}
                </p>
              ) : null}
              <section aria-label={t('preview')}>
                <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded fill-group p-3 text-caption">
                  {preview.item.text}
                </pre>
              </section>
              <div className="flex justify-end gap-2">
                <Button variant="tertiary" onClick={() => close()}>
                  {t(preview.replace ? 'cancel' : 'close')}
                </Button>
                {preview.replace ? (
                  <Button disabled={props.disabled} onClick={() => close(preview.item)}>
                    {t('confirmReplacement')}
                  </Button>
                ) : null}
              </div>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </>
  );
}
