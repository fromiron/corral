'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { useShape } from '../../lib/shape-context.tsx';
import { cn } from '../../lib/utils.ts';

// ─── Object URLs ─────────────────────────────────────────────────────────────
// One ref-counted blob URL per File. Created on subscribe (not in a memo) so
// StrictMode's remount mints a fresh URL instead of showing a revoked one.
const objectUrls = new Map<File, { url: string; users: number }>();

function subscribeObjectUrl(file: File) {
  let entry = objectUrls.get(file);
  if (!entry) {
    entry = { url: URL.createObjectURL(file), users: 0 };
    objectUrls.set(file, entry);
  }
  entry.users += 1;
  const held = entry;
  return () => {
    held.users -= 1;
    if (held.users === 0) {
      URL.revokeObjectURL(held.url);
      objectUrls.delete(file);
    }
  };
}

function useObjectUrl(file: File | null): string | null {
  const subscribe = useCallback(() => (file ? subscribeObjectUrl(file) : () => {}), [file]);
  return useSyncExternalStore(
    subscribe,
    () => (file ? (objectUrls.get(file)?.url ?? null) : null),
    () => null,
  );
}

// ─── File thumbnail ──────────────────────────────────────────────────────────
// Read-only square preview of a File: images via an object URL; other files use the source generic glyph.
// Corral does not load a PDF renderer or an external preview worker.
interface FileThumbnailProps {
  file: File;
  /** Side length of the square thumbnail in pixels. */
  size: number;
  /** Explicit corner radius for a known nested inset. Defaults to the active
   *  shape's regular image/control radius. */
  radius?: number;
  className?: string;
}

function FileThumbnail({ file, size, radius, className }: FileThumbnailProps) {
  const shape = useShape();
  const isImage = file.type.startsWith('image/');

  // The first render has no URL yet; bg-accent covers that frame.
  const imageUrl = useObjectUrl(isImage ? file : null);

  const previewUrl = imageUrl;
  const isPending = isImage && !imageUrl;

  return (
    <div
      className={cn(
        // An outline, unlike a border, paints over the preview without taking space.
        'relative shrink-0 overflow-hidden bg-accent outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10',
        shape.bg,
        className,
      )}
      style={{
        width: size,
        height: size,
        // Inline only when explicit, so className radius overrides still work.
        ...(radius == null ? {} : { borderRadius: radius }),
      }}
    >
      {previewUrl ? (
        <img
          src={previewUrl}
          alt={file.name}
          className="absolute inset-0 w-full h-full object-cover"
        />
      ) : isPending ? (
        <div className="absolute inset-0 flex items-center justify-center">
          <div
            className="w-6 h-6 rounded-full border-2 border-border border-t-muted-foreground motion-safe:animate-spin"
            aria-label="Loading preview"
            role="status"
          />
        </div>
      ) : (
        // Generic document glyph; inline SVG keeps the component self-contained.
        <div
          className="absolute inset-0 flex items-center justify-center text-muted-foreground"
          role="img"
          aria-label={file.name}
        >
          <svg
            width={Math.max(16, size * 0.35)}
            height={Math.max(16, size * 0.35)}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
            <path d="M14 3v5h5" />
          </svg>
        </div>
      )}
    </div>
  );
}

export type { FileThumbnailProps };
export { FileThumbnail };
