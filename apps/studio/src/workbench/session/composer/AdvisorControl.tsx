import type { SessionAdvisor } from '@corral/core';
import { TermTooltip } from '@corral/react';
import {
  Button,
  LiveDot,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Switch,
} from '@corral/react/design-kit';
import { Eye } from '@corral/react/icons';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AutoModelMenu } from '../../AutoModelMenu.tsx';
import type { ProfileInfo } from '../../useModels.ts';

// The conversation's advisor on the tool line (features/advisor.md "두는 곳" 대화, "보이는 곳"):
// a small control beside the team menu that is quiet while off and plainly on once on, and a
// small popover to turn it on or off and choose its model from the conversation's model list.
// Its tooltip names it Advisor with its state and says what an advisor is (features/term-hints.md);
// the popover's switch is named Advisor too.

export const OPEN_ADVISOR = 'corral:open-advisor';

/** Opens the advisor control, from wherever its refusal is said. */
export function openAdvisorControl() {
  window.dispatchEvent(new Event(OPEN_ADVISOR));
}

export function AdvisorControl({
  value,
  unknown,
  onRecheck,
  defaultModel,
  profiles,
  saving,
  disabled,
  problem,
  onChange,
}: {
  /** What the session's record says. */
  value: SessionAdvisor | null;
  /**
   * Neither on nor off: a save's outcome and the session's setting could not be read. The value
   * is not shown; reading the session again is.
   */
  unknown: boolean;
  /** Reads the session again; sends nothing. */
  onRecheck: () => void;
  /** The model turning it on uses: the conversation's. */
  defaultModel: string;
  /** The conversation's model list; none in the browser demo. */
  profiles: ProfileInfo[] | null;
  /** A save is on its way: nothing is pressed again until it answers. */
  saving: boolean;
  disabled: boolean;
  /** Why the last save did not land as asked, said where it was pressed. */
  problem: string | null;
  onChange: (next: SessionAdvisor | null) => void;
}) {
  const tc = useTranslations('Composer');
  const [open, setOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  useEffect(() => {
    const show = () => setOpen(true);
    window.addEventListener(OPEN_ADVISOR, show);
    return () => window.removeEventListener(OPEN_ADVISOR, show);
  }, []);
  const on = !unknown && value !== null;
  const held = saving || disabled;
  // A profile no longer listed is named as unavailable, never by its id. Without a model list
  // (the browser demo) no model is named.
  const model =
    value && profiles
      ? (profiles.find((profile) => profile.profileId === value.modelProfile)?.label ??
        tc('advisor.unavailable'))
      : null;
  const name = tc('advisor.name');
  const state = unknown
    ? tc('advisor.unknown')
    : on
      ? model
        ? tc('advisor.on', { model })
        : tc('advisor.onOnly')
      : tc('advisor.off');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <TermTooltip term="advisor" state={state}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-compact"
              data-slot="composer-advisor"
              data-state={unknown ? 'unknown' : on ? 'on' : 'off'}
              aria-label={name}
              disabled={disabled}
              // On, it reads at a glance; off, it only holds its place. Its size never changes.
              className={on ? 'relative text-emphasis' : 'relative text-muted-foreground'}
            />
          }
        >
          <Eye />
          {on ? <LiveDot live={false} className="absolute top-1 right-1" /> : null}
          {/* Not known: a mark of its own shape, not a colour of the on or off one. */}
          {unknown ? (
            <span aria-hidden="true" className="absolute top-0 right-0.5 text-micro text-warning">
              ?
            </span>
          ) : null}
        </PopoverTrigger>
      </TermTooltip>
      <PopoverPopup side="top" align="start" padding="compact" aria-label={name}>
        <div data-slot="advisor-popover" className="flex min-w-0 flex-col gap-1">
          {unknown ? (
            <div className="flex min-w-0 items-center gap-2 px-2 py-1">
              <p role="alert" className="m-0 max-w-64 text-caption text-warning">
                {problem}
              </p>
              <Button variant="tertiary" size="compact" disabled={saving} onClick={onRecheck}>
                {tc('advisor.recheck')}
              </Button>
            </div>
          ) : (
            <div className="flex min-w-0 items-center gap-1">
              <Switch
                size="compact"
                label={name}
                checked={on}
                disabled={held}
                onToggle={() => {
                  if (!held) onChange(on ? null : { modelProfile: defaultModel });
                }}
              />
              {value && profiles ? (
                <AutoModelMenu
                  value={{ modelProfile: value.modelProfile }}
                  profiles={profiles}
                  showReasoning={false}
                  missingName={tc('advisor.unavailable')}
                  disabled={held}
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                  onChange={(next) => {
                    if (!held && next.modelProfile !== value.modelProfile)
                      onChange({ modelProfile: next.modelProfile });
                  }}
                />
              ) : null}
            </div>
          )}
          {problem && !unknown ? (
            <p role="alert" className="m-0 max-w-64 px-2 pb-1 text-caption text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
