import { cloneElement, type ReactElement, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { Info } from '../design-kit/icons.ts';
import {
  Button,
  fontWeights,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Tooltip,
} from '../design-kit/index.ts';

/** The coined names that explain themselves (glossary.md, "설명이 붙는 용어"). */
export type TermId = 'corral' | 'execution' | 'workStyle' | 'advisor';

/**
 * What a term means, as both forms show it: its name, then one sentence under it, at a width
 * that reads (features/term-hints.md). It takes the colors of the surface it is in.
 */
export function TermContent({ term }: { term: TermId }) {
  const t = useTranslations('Terms');
  return (
    <span className="flex max-w-64 flex-col gap-0.5 text-left">
      <span data-term-name="" style={{ fontVariationSettings: fontWeights.semibold }}>
        {t(`${term}.name`)}
      </span>
      <span data-term-meaning="">{t(`${term}.meaning`)}</span>
    </span>
  );
}

/** The meaning as a description, read while the explanation is closed; never drawn. */
function Meaning({ id, term }: { id: string; term: TermId }) {
  const t = useTranslations('Terms');
  return (
    <span id={id} hidden>
      {t(`${term}.meaning`)}
    </span>
  );
}

/**
 * The info icon right after a term that stands as a title or label. A pointer resting on it,
 * keyboard focus or a press opens the explanation; the pointer may move onto it. Escape, a press
 * outside, or pointer and focus both leaving close it, and the focus stays on the icon.
 *
 * Base UI's tooltip opens on a mouse only (`mouseOnly` in TooltipTrigger.js) and never on a
 * press, so a touch could not reach it: this is the kit's popover, opened on a press, on hover
 * (`openOnHover`, which keeps it open while the pointer moves onto it) and here on keyboard focus.
 */
export function TermHint({ term, className }: { term: TermId; className?: string }) {
  const t = useTranslations('Terms');
  const meaningId = useId();
  const [open, setOpen] = useState(false);
  // How it was opened: one opened by focus closes when the focus leaves.
  const openedBy = useRef<string | null>(null);
  // A press focuses the icon too; that focus is the press's, which opens and closes it itself.
  const pressing = useRef(false);
  const change = (next: boolean, reason: string | null) => {
    openedBy.current = next ? reason : null;
    setOpen(next);
  };
  return (
    <>
      <Popover open={open} onOpenChange={(next, details) => change(next, details?.reason ?? null)}>
        <PopoverTrigger
          openOnHover
          delay={200}
          render={
            <Button
              variant="ghost"
              size="icon-compact"
              // 24px to press, with the glyph at the name's size; the negative margins keep the
              // line as tall as the name alone.
              className={`-my-1 size-6 shrink-0 align-middle [&_svg]:size-3.5 ${className ?? ''}`}
            />
          }
          aria-label={t('about', { term: t(`${term}.name`) })}
          aria-describedby={meaningId}
          data-term-hint={term}
          onPointerDown={() => {
            pressing.current = true;
          }}
          onFocus={() => {
            if (!pressing.current && !open) change(true, 'focus');
            pressing.current = false;
          }}
          onBlur={(event) => {
            const popup = document.querySelector(`[data-term-popup="${meaningId}"]`);
            if (openedBy.current === 'focus' && !popup?.contains(event.relatedTarget as Node))
              change(false, null);
          }}
        >
          <Info aria-hidden="true" />
        </PopoverTrigger>
        <PopoverPopup
          side="bottom"
          align="start"
          padding="compact"
          // The explanation is read, not worked in: the focus stays on the icon.
          initialFocus={false}
          data-term-popup={meaningId}
          aria-label={t(`${term}.name`)}
          className="text-caption"
        >
          <span className="block px-1">
            <TermContent term={term} />
          </span>
        </PopoverPopup>
      </Popover>
      <Meaning id={meaningId} term={term} />
    </>
  );
}

/**
 * A control whose tooltip already says its name: the tooltip says the term's name and its one
 * sentence, and the sentence becomes the control's description. Its own name stays.
 */
export function TermTooltip({
  term,
  children,
  side,
}: {
  term: TermId;
  children: ReactElement<{ 'aria-describedby'?: string }>;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  const meaningId = useId();
  const described = [children.props['aria-describedby'], meaningId].filter(Boolean).join(' ');
  return (
    <>
      <Tooltip content={<TermContent term={term} />} {...(side ? { side } : {})}>
        {cloneElement(children, { 'aria-describedby': described })}
      </Tooltip>
      <Meaning id={meaningId} term={term} />
    </>
  );
}
