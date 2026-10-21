import {
  type TextAttachment,
  type TextAttachmentProvenance,
  textAttachmentKey,
} from '@corral/contracts';
import { validTextAttachments } from '@corral/core';
import { ChevronRight, X } from '@corral/react/icons';
import { Button } from '@corral/react/ui';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';

export interface ContextSourceStatus {
  state: 'current' | 'stale' | 'unavailable';
  reason?: string;
}
export interface ContextAttachmentsProps {
  value: TextAttachment[];
  disabled?: boolean;
  onChange(value: TextAttachment[]): void;
  inspect(item: TextAttachment): Promise<ContextSourceStatus>;
  onOpen(item: TextAttachment): void | Promise<void>;
  onReplace(item: TextAttachment): Promise<TextAttachment | null>;
}

/** Display only: source metadata never resolves to HTML, a URL or executable content. */
export function AttachmentSource({ source }: { source: TextAttachmentProvenance }) {
  const t = useTranslations('Context');
  let label: string;
  switch (source.kind) {
    case 'code':
      label = `${t(source.snapshot === 'draft' ? 'draftCode' : 'savedCode')} · ${source.path} · L${source.range.startLine}:${source.range.startColumn}–L${source.range.endLine}:${source.range.endColumn} · ${source.bufferHash.slice(0, 8)}`;
      break;
    case 'terminal':
      label = `${t('terminalSource')} · ${source.cols}×${source.rows} · #${source.outputSequence}`;
      break;
    case 'hunk':
      label = `${t('hunkSource')} · ${source.path} · ${source.from.slice(0, 8)} → ${source.to.slice(0, 8)}`;
      break;
    case 'check':
      label = `${t('checkSource')} · ${source.commandId} · ${source.tree.slice(0, 8)}`;
      break;
  }
  return <p className="break-all text-xs text-muted">{label}</p>;
}

/** Only an explicit replacement can change the frozen capture; inspection is presentation state. */
export function ContextAttachments(props: ContextAttachmentsProps) {
  const t = useTranslations('Context');
  const latest = useRef(props);
  latest.current = props;
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const remove = (key: string) => {
    if (latest.current.disabled) return;
    const value = latest.current.value.filter((item) => textAttachmentKey(item) !== key);
    latest.current = { ...latest.current, value };
    latest.current.onChange(value);
  };
  const replace = async (item: TextAttachment) => {
    const key = textAttachmentKey(item);
    const replacement = await latest.current.onReplace(item);
    if (!alive.current || latest.current.disabled || !replacement) return;
    const current = latest.current.value;
    const index = current.findIndex((entry) => textAttachmentKey(entry) === key);
    if (index < 0) return;
    const value = current.map((entry, at) => (at === index ? replacement : entry));
    if (!validTextAttachments(value)) throw new Error('Invalid replacement capture');
    latest.current = { ...latest.current, value };
    latest.current.onChange(value);
  };
  if (!props.value.length) return null;
  return (
    <ul
      aria-label={t('attachments')}
      className="flex max-h-40 min-h-0 min-w-0 flex-col gap-1 overflow-y-auto overscroll-contain"
    >
      {props.value.map((item) => (
        <CaptureRow
          key={textAttachmentKey(item)}
          item={item}
          disabled={props.disabled}
          inspect={props.inspect}
          onOpen={props.onOpen}
          onReplace={replace}
          onRemove={() => remove(textAttachmentKey(item))}
        />
      ))}
    </ul>
  );
}

function CaptureRow({
  item,
  disabled,
  inspect,
  onOpen,
  onReplace,
  onRemove,
}: {
  item: TextAttachment;
  disabled?: boolean;
  inspect: ContextAttachmentsProps['inspect'];
  onOpen: ContextAttachmentsProps['onOpen'];
  onReplace(item: TextAttachment): Promise<void>;
  onRemove(): void;
}) {
  const t = useTranslations('Context');
  const latest = useRef({ item, inspect, onOpen, onReplace });
  latest.current = { item, inspect, onOpen, onReplace };
  const alive = useRef(true);
  const inspection = useRef(0);
  const [status, setStatus] = useState<ContextSourceStatus | { state: 'checking' }>({
    state: 'checking',
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const check = useCallback(async () => {
    if (!latest.current.item.provenance || !alive.current) return;
    const request = ++inspection.current;
    setStatus({ state: 'checking' });
    try {
      const next = await latest.current.inspect(latest.current.item);
      if (alive.current && request === inspection.current) setStatus(next);
    } catch {
      if (alive.current && request === inspection.current) setStatus({ state: 'unavailable' });
    }
  }, []);
  // Each row is keyed by immutable attachment identity; parent callback changes are not polling.
  useEffect(() => {
    alive.current = true;
    void check();
    return () => {
      alive.current = false;
      inspection.current += 1;
    };
  }, [check]);
  const open = async () => {
    setBusy(true);
    try {
      await latest.current.onOpen(item);
      await check();
    } catch {
      inspection.current += 1;
      if (alive.current) setStatus({ state: 'unavailable' });
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const replace = async () => {
    setBusy(true);
    setFailed(false);
    try {
      await latest.current.onReplace(item);
    } catch {
      if (alive.current) setFailed(true);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <li className="flex min-w-0 flex-col gap-0.5 rounded fill-group px-2 py-1">
      <div className="flex min-w-0 items-start gap-1">
        <details
          className="group min-w-0 flex-1"
          onToggle={(event) => {
            if (event.currentTarget.open) void check();
          }}
        >
          <summary className="flex cursor-pointer list-none items-center gap-1 rounded py-1 text-xs [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-3 shrink-0 group-open:rotate-90" />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex min-w-0 items-center gap-1">
                <span className="min-w-0 flex-1 truncate" title={item.name}>
                  {item.name}
                </span>
                <span className="shrink-0 text-muted">{item.bytes} B</span>
              </span>
              {item.provenance ? (
                <span
                  role="status"
                  title={t(status.state)}
                  className={`truncate leading-4 ${status.state === 'current' ? 'text-muted' : 'text-warning'}`}
                >
                  {t(status.state)}
                </span>
              ) : null}
            </span>
          </summary>
          {item.provenance ? (
            <div className="mt-1 flex min-w-0 flex-col gap-1">
              <AttachmentSource source={item.provenance} />
              {'reason' in status && status.reason ? (
                <p className="break-words text-xs text-muted">{status.reason}</p>
              ) : null}
              <div className="flex flex-wrap gap-1">
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={disabled || busy}
                  aria-label={`${t('openSource')}: ${item.name}`}
                  onClick={() => void open()}
                >
                  {t('openSource')}
                </Button>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  disabled={disabled || busy}
                  aria-label={`${t('replaceCapture')}: ${item.name}`}
                  onClick={() => void replace()}
                >
                  {t('replaceCapture')}
                </Button>
              </div>
            </div>
          ) : null}
          <p className="mt-1 text-xs text-muted">{t('preview')}</p>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded p-1 text-xs">
            {item.text}
          </pre>
        </details>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          aria-label={t('removeCapture', { name: item.name })}
          disabled={disabled}
          onClick={onRemove}
        >
          <X />
        </Button>
      </div>
      {failed ? (
        <p role="alert" className="text-xs text-danger">
          {t('replacementFailed')}
        </p>
      ) : null}
    </li>
  );
}
