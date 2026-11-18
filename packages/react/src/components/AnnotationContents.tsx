import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { ImageIcon } from '../design-kit/icons.ts';
import { Button } from '../design-kit/index.ts';

// What a page annotation carries (docs/specs/features/browser-annotate.md 보내는 것: 보이는 것),
// shown the same wherever a person checks it: the overlay note's label popover and the composer's
// note chip popover. Everything in it came from a page, so it is drawn as text only, each piece
// isolated so a direction mark in it cannot turn the line around it.

/** Longer than this, the element's text starts folded. */
const FOLD_AT = 160;

export interface AnnotationContentsProps {
  /** The page as the note carries it: origin and path, nothing else of the address. */
  page: { origin: string; path: string };
  /** The element's name tag (`button.pay 120×32`). */
  label: string;
  selector: string;
  /** The element's visible text, without field values. */
  text: string;
  styles: readonly { property: string; before: string; after: string }[];
  /** The preview page's console messages the note carries, or null when it carries none. */
  console: readonly { level: string; message: string }[] | null;
  /**
   * The screenshot: whether the note will take one (the overlay's note takes it at the send), or
   * the one it took, as a small picture.
   */
  screenshot: 'included' | 'none' | { src: string; alt: string };
}

export function AnnotationContents({
  page,
  label,
  selector,
  text,
  styles,
  console,
  screenshot,
}: AnnotationContentsProps) {
  const t = useTranslations('Annotate.what');
  const [unfolded, setUnfolded] = useState(false);
  const folds = text.length > FOLD_AT || text.split('\n').length > 3;
  return (
    <div className="flex min-w-0 flex-col gap-3 text-caption text-foreground">
      <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="text-muted-foreground">{t('page')}</dt>
        <dd className="min-w-0 break-all font-mono">
          <bdi>{`${page.origin}${page.path}`}</bdi>
        </dd>
        <dt className="text-muted-foreground">{t('element')}</dt>
        <dd className="min-w-0 break-all font-mono">
          <bdi>{label}</bdi>
        </dd>
        <dt className="text-muted-foreground">{t('selector')}</dt>
        <dd className="min-w-0 break-all font-mono">
          <bdi>{selector}</bdi>
        </dd>
        {text && (
          <>
            <dt className="text-muted-foreground">{t('text')}</dt>
            <dd className="flex min-w-0 flex-col items-start gap-1">
              <bdi
                className={`block whitespace-pre-wrap break-words ${folds && !unfolded ? 'line-clamp-3' : ''}`}
              >
                {text}
              </bdi>
              {folds && !unfolded && (
                <Button
                  variant="ghost"
                  size="compact"
                  aria-expanded={false}
                  onClick={() => setUnfolded(true)}
                >
                  {t('showMore')}
                </Button>
              )}
            </dd>
          </>
        )}
        {styles.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t('styles')}</dt>
            <dd className="min-w-0">
              <ul className="flex flex-col gap-0.5 font-mono">
                {styles.map((change) => (
                  <li key={change.property} className="break-all">
                    <bdi>{change.property}</bdi>: <bdi>{change.before}</bdi>
                    <span className="text-muted-foreground"> → </span>
                    <bdi>{change.after}</bdi>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {console && console.length > 0 && (
          <>
            <dt className="text-muted-foreground">{t('console')}</dt>
            <dd className="min-w-0">
              <ul className="flex flex-col gap-0.5 font-mono">
                {console.map((entry, index) => (
                  // The messages have no id of their own; their order is the page's.
                  // biome-ignore lint/suspicious/noArrayIndexKey: a fixed list, never reordered.
                  <li key={index} className="break-all">
                    <span className="text-muted-foreground">{entry.level}</span>{' '}
                    <bdi>{entry.message}</bdi>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
      </dl>
      {typeof screenshot === 'object' ? (
        <img
          src={screenshot.src}
          alt={screenshot.alt}
          className="max-h-32 max-w-full self-start rounded-md border border-border object-contain"
        />
      ) : (
        <p className="flex items-center gap-1.5 text-muted-foreground">
          <ImageIcon className="size-3.5 shrink-0" aria-hidden="true" />
          {screenshot === 'included' ? t('screenshotIncluded') : t('noScreenshot')}
        </p>
      )}
    </div>
  );
}
