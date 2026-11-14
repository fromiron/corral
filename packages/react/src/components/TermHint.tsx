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
export type TermId = 'corral' | 'execution' | 'harness' | 'paddock' | 'outrider';

/**
 * What a term means, as both forms show it on the kit tooltip's surface: its name (and, where
 * the control said one, its state), then one sentence under it, at a width that reads
 * (features/term-hints.md). Plain blocks, so the surface trims its first and last line alike.
 */
export function TermContent({ term, state }: { term: TermId; state?: string }) {
  const t = useTranslations('Terms');
  return (
    <span className="block max-w-64 text-left">
      <span
        data-term-name=""
        className="block"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {state ? `${t(`${term}.name`)} · ${state}` : t(`${term}.name`)}
      </span>
      <span data-term-meaning="" className="mt-1 block">
        {t(`${term}.meaning`)}
      </span>
    </span>
  );
}

/** Words read as a description while the explanation is closed; never drawn. */
function Described({ id, children }: { id: string; children: string }) {
  return (
    <span id={id} hidden>
      {children}
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
 * (`openOnHover`, which keeps it open while the pointer moves onto it) and here on keyboard focus,
 * drawn on the tooltip's surface so both forms look alike.
 */
export function TermHint({ term, className }: { term: TermId; className?: string }) {
  const t = useTranslations('Terms');
  const meaningId = useId();
  const [open, setOpen] = useState(false);
  // How it was opened: one opened by focus stays while the focus does.
  const openedBy = useRef<string | null>(null);
  // A press focuses the icon too; that focus is the press's, which opens and closes it itself.
  // The press ends with its click (on a touch screen the focus comes after the finger lifts).
  const pressing = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const change = (next: boolean, reason: string | null) => {
    openedBy.current = next ? reason : null;
    setOpen(next);
  };
  /** The focus is on the icon or in its explanation. */
  const focusHere = () => {
    const active = document.activeElement;
    const popup = document.querySelector(`[data-term-popup="${meaningId}"]`);
    return !!active && (active === trigger.current || !!popup?.contains(active));
  };
  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next, details) => {
          const reason = details?.reason ?? null;
          if (openedBy.current === 'focus') {
            // Opened by focus, a pointer leaving does not close it while the focus stays (it closes
            // when the focus leaves). Cancelled, not only ignored: Base UI would
            // otherwise take the pointer for its opener and stop managing the focus, and the next
            // Tab would go through the page. (While it is open, Base UI reports no hover opening.)
            if (!next && reason === 'trigger-hover' && focusHere()) {
              details?.cancel();
              return;
            }
          }
          change(next, reason);
        }}
      >
        <PopoverTrigger
          ref={trigger}
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
          onClick={() => {
            pressing.current = false;
          }}
          onPointerCancel={() => {
            pressing.current = false;
          }}
          onPointerLeave={(event) => {
            // A mouse dragged off the icon makes no click; a finger leaves on lifting, before its
            // focus, so it keeps the press.
            if (event.pointerType === 'mouse') pressing.current = false;
          }}
          onFocus={() => {
            if (!pressing.current && !open) change(true, 'focus');
          }}
          onBlur={() => {
            // The focus may pass through the explanation's focus guards on its way to the next
            // control: judge where it went once it has landed, so a Tab goes straight on.
            if (openedBy.current !== 'focus') return;
            setTimeout(() => {
              if (openedBy.current === 'focus' && !focusHere()) change(false, null);
            }, 0);
          }}
        >
          <Info aria-hidden="true" />
        </PopoverTrigger>
        <PopoverPopup
          surface="tooltip"
          side="bottom"
          align="start"
          // The explanation is read, not worked in: the focus stays on the icon.
          initialFocus={false}
          // Nor does it hand the focus back when it closes: a focus returned to the icon would open
          // it again (a tap outside on a touch screen does that).
          finalFocus={false}
          data-term-popup={meaningId}
          aria-label={t(`${term}.name`)}
        >
          <TermContent term={term} />
        </PopoverPopup>
      </Popover>
      <Described id={meaningId}>{t(`${term}.meaning`)}</Described>
    </>
  );
}

/**
 * A control named by the term (a tool line button or selector, a view tab): its tooltip says the
 * term's name, with the state the control said beside it, and the one sentence under it. The
 * state and the sentence are the control's description; its own name stays. Props other than
 * these go to the control (a tab list's index, for one).
 */
export function TermTooltip({
  term,
  state,
  closed,
  side,
  align,
  children,
  ...control
}: {
  term: TermId;
  /** The state the control's tooltip said, kept on the name line and in the description. */
  state?: string;
  /** Kept closed, as while the control's own menu is open. */
  closed?: boolean;
  /**
   * The wrapped control's value, passed on to it and shown here to a list that reads its
   * children's values (a tab list orders its tabs by them).
   */
  value?: string;
  side?: 'top' | 'bottom' | 'left' | 'right';
  align?: 'start' | 'center' | 'end';
  children: ReactElement<{ 'aria-describedby'?: string }>;
  [prop: string]: unknown;
}) {
  const t = useTranslations('Terms');
  const meaningId = useId();
  const stateId = useId();
  const described = [children.props['aria-describedby'], state ? stateId : null, meaningId]
    .filter(Boolean)
    .join(' ');
  return (
    <>
      <Tooltip
        content={<TermContent term={term} {...(state ? { state } : {})} />}
        {...(closed ? { forceOpen: false } : {})}
        {...(side ? { side } : {})}
        {...(align ? { align } : {})}
      >
        {cloneElement(children, { ...control, 'aria-describedby': described })}
      </Tooltip>
      {state ? <Described id={stateId}>{state}</Described> : null}
      <Described id={meaningId}>{t(`${term}.meaning`)}</Described>
    </>
  );
}
