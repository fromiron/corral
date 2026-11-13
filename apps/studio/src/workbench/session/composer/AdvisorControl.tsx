import type { SessionAdvisor } from '@corral/core';
import {
  Button,
  LiveDot,
  Popover,
  PopoverPopup,
  PopoverTrigger,
  Switch,
  Tooltip,
} from '@corral/react/design-kit';
import { Eye } from '@corral/react/icons';
import { useEffect, useState } from 'react';
import { useTranslations } from 'use-intl';
import { AutoModelMenu } from '../../AutoModelMenu.tsx';
import type { ProfileInfo } from '../../useModels.ts';

// The conversation's advisor on the tool line (features/advisor.md "두는 곳" 대화, "보이는 곳"):
// a small control beside the team menu that is quiet while off and plainly on once on, and a
// small popover to turn it on or off and choose its model from the conversation's model list.
// The setting has no name of its own: the screen calls it Advisor once, in the popover.

const OPEN_ADVISOR = 'corral:open-advisor';

/** Opens the advisor control, from wherever its refusal is said. */
export function openAdvisorControl() {
  window.dispatchEvent(new Event(OPEN_ADVISOR));
}

export function AdvisorControl({
  value,
  defaultModel,
  profiles,
  saving,
  disabled,
  problem,
  onChange,
}: {
  /** What the session's record says. */
  value: SessionAdvisor | null;
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
  const on = value !== null;
  const held = saving || disabled;
  const model = value
    ? (profiles?.find((profile) => profile.profileId === value.modelProfile)?.label ??
      value.modelProfile)
    : null;
  const name = tc('advisor.name');
  const state = model ? tc('advisor.on', { model }) : tc('advisor.off');
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip content={model ? `${name} · ${model}` : name}>
        <PopoverTrigger
          render={
            <Button
              variant="ghost"
              size="icon-compact"
              data-slot="composer-advisor"
              data-state={on ? 'on' : 'off'}
              aria-label={name}
              aria-description={state}
              disabled={disabled}
              // On, it reads at a glance; off, it only holds its place. Its size never changes.
              className={on ? 'relative text-emphasis' : 'relative text-muted-foreground'}
            />
          }
        >
          <Eye />
          {on ? <LiveDot live={false} className="absolute top-1 right-1" /> : null}
        </PopoverTrigger>
      </Tooltip>
      <PopoverPopup side="top" align="start" padding="compact" aria-label={name}>
        <div data-slot="advisor-popover" className="flex min-w-0 flex-col gap-1">
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
          {problem ? (
            <p role="alert" className="m-0 max-w-64 px-2 pb-1 text-caption text-destructive">
              {problem}
            </p>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
