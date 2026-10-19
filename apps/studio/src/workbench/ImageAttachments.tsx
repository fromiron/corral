import { IMAGE_MAX_BYTES, IMAGE_MAX_COUNT, type ImageAttachment } from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { type RefObject, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';

async function normalizedImage(file: File): Promise<Blob> {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 10 * 1024 * 1024
  )
    throw new Error('image source limit');
  const image = await createImageBitmap(file);
  try {
    if (!image.width || !image.height || image.width * image.height > 16_777_216)
      throw new Error('image pixel limit');
    const ratio = Math.min(1, 2048 / image.width, 2048 / image.height);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.width * ratio));
    canvas.height = Math.max(1, Math.round(image.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('image conversion unavailable');
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob || blob.size > IMAGE_MAX_BYTES) throw new Error('normalized image limit');
    return blob;
  } finally {
    image.close();
  }
}

export function ImageAttachmentList({
  sessionId,
  images,
}: {
  sessionId: string;
  images: ImageAttachment[];
}) {
  const { workspaces } = useServices();
  const t = useTranslations('Composer');
  if (!images.length || !workspaces) return null;
  return (
    <ul aria-label={t('imageAttachments')} className="flex flex-wrap gap-2">
      {images.map((image) => (
        <li key={image.imageId}>
          <details className="rounded border border-line p-2 text-xs">
            <summary className="cursor-pointer">
              {image.name} · {image.width}×{image.height} · {image.sha256.slice(0, 12)}
            </summary>
            <img
              className="mt-2 max-h-80 max-w-full object-contain"
              src={workspaces.imageUrl(sessionId, image.imageId)}
              alt={image.name}
              loading="lazy"
            />
          </details>
        </li>
      ))}
    </ul>
  );
}

export function ImageAttachmentPicker({
  sessionId,
  value,
  disabled,
  onChange,
  onBusyChange,
  inputRef,
  enabled = true,
}: {
  sessionId: string;
  value: ImageAttachment[];
  disabled: boolean;
  onChange(value: ImageAttachment[]): void;
  onBusyChange(busy: boolean): void;
  inputRef?: RefObject<HTMLInputElement | null>;
  enabled?: boolean;
}) {
  const { mode, workspaces } = useServices();
  const t = useTranslations('Composer');
  const id = useId(),
    input = useRef<HTMLInputElement>(null);
  const request = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  if (mode === 'browser') return null;
  const pick = async (files: File[]) => {
    if (!workspaces || !files.length || busy) return;
    setError(null);
    if (files.length + value.length > IMAGE_MAX_COUNT) {
      setError(t('imageLimit'));
      return;
    }
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    onBusyChange(true);
    const images = [...value];
    try {
      for (const file of files) {
        const blob = await normalizedImage(file);
        if (controller.signal.aborted) return;
        const image = await workspaces.uploadImage(sessionId, file.name, blob, controller.signal);
        if (controller.signal.aborted) return;
        if (!images.some((item) => item.imageId === image.imageId)) images.push(image);
        onChange([...images]);
      }
    } catch {
      if (!controller.signal.aborted) setError(t('imageFailed'));
    } finally {
      if (!controller.signal.aborted) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2">
      <input
        ref={inputRef ?? input}
        id={id}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/webp"
        aria-label={t('attachImages')}
        className="sr-only"
        disabled={disabled || !enabled || busy}
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = '';
          void pick(files);
        }}
      />
      {!inputRef ? (
        <Button
          size="xs"
          variant="ghost"
          disabled={disabled || busy || value.length >= IMAGE_MAX_COUNT}
          onClick={() => input.current?.click()}
        >
          {t(busy ? 'imageUploading' : 'attachImages')}
        </Button>
      ) : null}
      {value.map((image) => (
        <Button
          key={image.imageId}
          size="xs"
          variant="outline"
          disabled={disabled || busy}
          aria-label={t('removeImage', { name: image.name })}
          onClick={() => onChange(value.filter((item) => item.imageId !== image.imageId))}
        >
          {image.name} · {image.width}×{image.height} ×
        </Button>
      ))}
      {error ? (
        <p role="alert" className="w-full text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
