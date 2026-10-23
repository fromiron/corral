import {
  TEXT_ATTACHMENT_MAX_BYTES,
  TEXT_ATTACHMENT_MAX_COUNT,
  type TextAttachment,
  textAttachmentKey,
} from '@corral/contracts';
import { createTextAttachment, validTextAttachments } from '@corral/core';
import { Button } from '@corral/react/ui';
import { type RefObject, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AttachmentSource } from './context/ContextAttachments.tsx';

const sourceFile = /\.(txt|md|markdown|json|csv|ts|tsx|js|jsx|py|css|html|xml|ya?ml|log)$/i;

export function TextAttachmentPicker({
  value,
  onChange,
  onLoading,
  disabled,
  enabled,
  inputRef,
  hideList = false,
}: {
  value: TextAttachment[];
  onChange(value: TextAttachment[]): void;
  onLoading(loading: boolean): void;
  disabled: boolean;
  enabled: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  hideList?: boolean;
}) {
  const t = useTranslations('Composer');
  const input = useRef<HTMLInputElement>(null);
  const epoch = useRef(0);
  const latest = useRef({ value, onChange });
  latest.current = { value, onChange };
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  useEffect(
    () => () => {
      epoch.current += 1;
    },
    [],
  );
  async function attach(files: File[]) {
    const owner = ++epoch.current;
    setError(false);
    setLoading(true);
    onLoading(true);
    try {
      if (files.length + value.length > TEXT_ATTACHMENT_MAX_COUNT)
        throw new Error('too many files');
      const added = await Promise.all(
        files.map(async (file) => {
          if (
            file.size > TEXT_ATTACHMENT_MAX_BYTES ||
            (!file.type.startsWith('text/') && !sourceFile.test(file.name))
          )
            throw new Error('unsupported text file');
          const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer());
          const mime =
            file.type === 'application/json' ||
            file.type === 'text/markdown' ||
            file.type === 'text/csv'
              ? file.type
              : 'text/plain';
          return createTextAttachment(file.name, mime, text);
        }),
      );
      if (epoch.current === owner) {
        const next = [
          ...new Map(
            [...latest.current.value, ...added].map((item) => [textAttachmentKey(item), item]),
          ).values(),
        ];
        if (!validTextAttachments(next)) throw new Error('invalid text attachments');
        latest.current.onChange(next);
      }
    } catch {
      if (epoch.current === owner) setError(true);
    } finally {
      if (epoch.current === owner) {
        setLoading(false);
        onLoading(false);
      }
    }
  }
  return (
    <div className="flex flex-col gap-1">
      <input
        ref={inputRef ?? input}
        type="file"
        multiple
        accept="text/*,.txt,.md,.json,.csv,.ts,.tsx,.js,.jsx,.py,.css,.html,.xml,.yaml,.yml,.log"
        aria-label={t('attachText')}
        className="sr-only"
        tabIndex={-1}
        disabled={disabled || !enabled || loading}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          if (files.length) void attach(files);
        }}
      />
      <div className="flex flex-wrap gap-1">
        {!inputRef ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            disabled={disabled || !enabled || loading || value.length >= TEXT_ATTACHMENT_MAX_COUNT}
            onClick={() => input.current?.click()}
          >
            {t(loading ? 'attachmentLoading' : 'attachText')}
          </Button>
        ) : null}
        {!hideList &&
          value.map((item) => (
            <Button
              key={textAttachmentKey(item)}
              type="button"
              size="xs"
              variant="outline"
              disabled={disabled || loading}
              aria-label={t('removeAttachment', { name: item.name })}
              onClick={() =>
                onChange(
                  value.filter((entry) => textAttachmentKey(entry) !== textAttachmentKey(item)),
                )
              }
            >
              {item.name} · {item.bytes} B ×
            </Button>
          ))}
      </div>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {t('attachmentError')}
        </p>
      ) : null}
    </div>
  );
}

export function TextAttachmentList({ attachments }: { attachments: TextAttachment[] }) {
  const t = useTranslations('Composer');
  return (
    <ul aria-label={t('attachments')} className="mt-2 flex flex-col gap-1 text-xs">
      {attachments.map((item) => (
        <li key={textAttachmentKey(item)}>
          <details>
            <summary className="cursor-pointer">
              {item.name} · {item.bytes} B · {item.sha256.slice(0, 12)}
            </summary>
            {item.provenance ? <AttachmentSource source={item.provenance} /> : null}
            <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded fill-group p-2">
              {item.text}
            </pre>
          </details>
        </li>
      ))}
    </ul>
  );
}
