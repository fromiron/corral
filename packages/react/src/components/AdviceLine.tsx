import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import {
  Collapse,
  cn,
  DisclosureChevron,
  focusRing,
  fontWeights,
  MetaDot,
  useSize,
} from '../design-kit/index.ts';
import { useAdviceSeen } from '../run/adviceSeen.tsx';
import { type AdviceEntry, firstLine, gravest, useSeverityName } from '../run/advisor.ts';

// An advisor's advice as one line that opens to its words (docs/specs/features/advisor.md, 보이는
// 곳): the advisor's name · its severity · its first line, and on the target's work the state of
// its delivery. The words are a model's: drawn as text, every piece it wrote isolated so a
// direction mark in it cannot turn the line around it.

/** A severity named, never told by its colour alone. */
const TONE: Record<string, string> = {
  concern: 'text-warning',
  blocker: 'text-danger',
};

/**
 * The line: one line high whatever it holds. Narrow, the first line gives way first; the name,
 * the severity and the state stay.
 */
export function AdviceSummary({
  name,
  items,
  status,
  open,
  controls,
  onToggle,
  className,
}: {
  /**
   * The advisor's name, or what names several advisors; left out where the line's row already
   * names it (a work log step's label).
   */
  name?: string;
  items: readonly AdviceEntry[];
  /** How its delivery stands, on the target's work. */
  status?: ReactNode;
  open: boolean;
  controls: string;
  onToggle: () => void;
  className?: string;
}) {
  const t = useTranslations('Advice');
  const severityName = useSeverityName();
  const severity = gravest(items);
  const sole = items.length === 1 ? items[0] : undefined;
  // Open, the words under the line begin with it: the line does not say it twice.
  const line = sole && !open ? firstLine(sole.text) : null;
  return (
    <button
      type="button"
      data-advice-line
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        'flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-sm text-left text-muted-foreground hover:text-foreground',
        focusRing,
        className,
      )}
    >
      {name ? (
        <>
          <bdi
            className="shrink-0 text-foreground"
            style={{ fontVariationSettings: fontWeights.semibold }}
          >
            {name}
          </bdi>
          {severity ? <MetaDot /> : null}
        </>
      ) : null}
      {severity ? (
        <span className={cn('shrink-0', TONE[severity])}>{severityName(severity)}</span>
      ) : null}
      {sole ? (
        line ? (
          <>
            <MetaDot />
            <bdi className="min-w-0 truncate">{line}</bdi>
          </>
        ) : null
      ) : (
        <>
          <MetaDot />
          <span className="shrink-0">{t('count', { count: items.length })}</span>
        </>
      )}
      {status ? (
        <>
          <MetaDot />
          <span className="shrink-0">{status}</span>
        </>
      ) : null}
      <DisclosureChevron open={open} size={12} className="shrink-0 text-current" />
    </button>
  );
}

/**
 * The advice's words in full, under its line. While they are open and on screen, `onSeen` hears
 * it: when they come into view, and when another advice joins them there.
 */
export function AdviceText({
  id,
  open,
  items,
  nameOf,
  onSeen,
  className,
}: {
  id: string;
  open: boolean;
  items: readonly AdviceEntry[];
  /** Each advice's advisor, named over its words when several are open together. */
  nameOf: (item: AdviceEntry) => string;
  onSeen?: (items: readonly AdviceEntry[]) => void;
  className?: string;
}) {
  const severityName = useSeverityName();
  const body = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const element = body.current;
    if (!open || !element || typeof IntersectionObserver === 'undefined') {
      setInView(false);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setInView(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [open]);
  const shownKey = items.map((item) => item.adviceId).join('\n');
  const heard = useRef(onSeen);
  heard.current = onSeen;
  const latest = useRef(items);
  latest.current = items;
  // biome-ignore lint/correctness/useExhaustiveDependencies: told again when what shows changes
  useEffect(() => {
    if (open && inView) heard.current?.(latest.current);
  }, [open, inView, shownKey]);
  const several = items.length > 1;
  // The line names one advisor already; each advice is named by its own only among several.
  const advisors = new Set(items.map((item) => nameOf(item))).size > 1;
  return (
    <Collapse id={id} open={open} hideWhenClosed className={cn('relative', className)}>
      <div ref={body} data-advice-text className="flex flex-col gap-2 pt-1">
        {items.map((item) => (
          <div key={item.adviceId} className="flex min-w-0 flex-col gap-0.5">
            {several ? (
              <p className="m-0 flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
                {advisors ? (
                  <>
                    <bdi className="text-foreground">{nameOf(item)}</bdi>
                    <MetaDot />
                  </>
                ) : null}
                <span className={TONE[item.severity]}>{severityName(item.severity)}</span>
              </p>
            ) : null}
            <p
              dir="auto"
              className="m-0 whitespace-pre-wrap text-foreground [overflow-wrap:anywhere]"
            >
              {item.text.replace(/^\s*\n/, '')}
            </p>
          </div>
        ))}
      </div>
    </Collapse>
  );
}

/**
 * A line and its words together, where nothing else shares the line: an advice in an execution's
 * record. Advice its target never read tells, once shown in full, that it was seen.
 */
export function AdviceBlock({
  runId,
  items,
  name,
  nameOf,
  status,
  initiallyOpen = false,
  unread = false,
}: {
  runId: string;
  items: readonly AdviceEntry[];
  name: string;
  nameOf: (item: AdviceEntry) => string;
  status?: ReactNode;
  initiallyOpen?: boolean;
  /** Its target never read it: shown in full, it leaves Needs you. */
  unread?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const id = useId();
  const seen = useAdviceSeen();
  const size = useSize();
  return (
    <div data-advice={unread ? 'unread' : 'delivered'} className="flex min-w-0 flex-col">
      <div className={cn(size.control, 'flex min-w-0 items-center text-caption')}>
        <AdviceSummary
          name={name}
          items={items}
          status={status}
          open={open}
          controls={id}
          onToggle={() => setOpen((value) => !value)}
        />
      </div>
      <AdviceText
        id={id}
        open={open}
        items={items}
        nameOf={nameOf}
        {...(unread && seen ? { onSeen: (shown) => seen.seen(runId, shown) } : {})}
        className="text-caption"
      />
    </div>
  );
}
