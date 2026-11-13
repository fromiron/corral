import {
  Button,
  Kbd,
  KitBadge,
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuShortcut,
  MenuTrigger,
} from '@corral/react/design-kit';
import { ChevronDown } from '@corral/react/icons';
import { useTranslations } from 'use-intl';
import { sendKeyLabels } from '../../../shortcuts.ts';
import type {
  SendChoice,
  SendKeyRole,
  SendKind,
  Situation,
  SteerTarget,
} from '../../composerIntent.ts';
import type { Preferences } from '../../preferences.ts';

// The tool line's send controls (features/composer-flow.md "전송", "합류 대상"): the target on the
// left, the keys and what they send on the right, and the send menu beside Send. The layout says
// what a message does; there is no caption.

const ROLES: readonly SendKeyRole[] = ['send', 'interrupt', 'queue'];

/**
 * The keys usable now and what each sends, on one line whose height never changes: Send alone
 * while nothing runs, the three keys while a run goes. A key that sends the same as one before
 * it is left out (an execution that cannot be cut joins with the interrupt key too). It closes
 * the tool line's left side, next to Send, and gives way first where the line runs short: a key
 * that no longer fits drops whole (the send menu lists the same keys).
 */
export function KeyHint({
  keys,
  sendKey,
}: {
  keys: Record<SendKeyRole, SendKind>;
  sendKey: Preferences['sendKey'];
}) {
  const tc = useTranslations('Composer');
  const labels = sendKeyLabels(sendKey);
  const shown = ROLES.filter(
    (role, index) => !ROLES.slice(0, index).some((before) => keys[before] === keys[role]),
  );
  return (
    <p
      data-slot="composer-keys"
      className="m-0 ml-auto flex h-5 min-w-0 shrink flex-wrap content-start items-center justify-end overflow-hidden whitespace-nowrap text-caption text-muted-foreground"
    >
      {/* Holds the first line, so a key that does not fit moves to the hidden next one whole. */}
      <span aria-hidden="true" className="h-5 w-0" />
      {shown.map((role, index) => (
        <span key={role} className="inline-flex h-5 items-center gap-1 pl-1.5">
          {index > 0 ? (
            <span aria-hidden="true" className="pr-0.5">
              ·
            </span>
          ) : null}
          <Kbd className="text-foreground">{labels[role]}</Kbd>
          {tc(`keyHint.${keys[role]}`)}
        </span>
      ))}
    </p>
  );
}

/** Which sends the send menu offers now; the others stay listed, disabled. */
export function menuSends(situation: Situation): Record<SendChoice, boolean> {
  return {
    join: situation === 'join' || situation === 'joinOnly' || situation === 'awaiting',
    interrupt: situation === 'join',
    queue: situation !== 'idle',
  };
}

/** The menu beside Send: the same three sends as the keys, by pointer. */
export function SendMenu({
  situation,
  sendKey,
  disabled,
  onSend,
}: {
  situation: Situation;
  sendKey: Preferences['sendKey'];
  /** Nothing to send, or sending is held. */
  disabled: boolean;
  onSend: (choice: SendChoice) => void;
}) {
  const tc = useTranslations('Composer');
  const labels = sendKeyLabels(sendKey);
  const offered = menuSends(situation);
  const items: [SendChoice, SendKeyRole][] = [
    ['join', 'send'],
    ['interrupt', 'interrupt'],
    ['queue', 'queue'],
  ];
  return (
    <Menu>
      <MenuTrigger
        disabled={situation === 'idle'}
        render={
          <Button
            variant="ghost"
            size="icon-compact"
            aria-label={tc('sendMenu')}
            data-slot="composer-send-menu"
          />
        }
      >
        <ChevronDown />
      </MenuTrigger>
      <MenuPopup align="end" side="top">
        {items.map(([choice, role]) => (
          <MenuItem
            key={choice}
            label={tc(`sendAs.${choice}`)}
            disabled={disabled || !offered[choice]}
            onClick={() => onSend(choice)}
          >
            <span className="flex w-full items-center gap-6">
              {tc(`sendAs.${choice}`)}
              <MenuShortcut>{labels[role]}</MenuShortcut>
            </span>
          </MenuItem>
        ))}
      </MenuPopup>
    </Menu>
  );
}

/**
 * Where an instruction goes, on the left of the tool line: the target role, which opens the
 * list of executions that can take an instruction now; while a run goes and none can, the one
 * line saying so. Nothing while no run goes.
 */
export function TargetChip({
  situation,
  target,
  targets,
  name,
  disabled,
  onChoose,
}: {
  situation: Situation;
  target: string | null;
  targets: readonly SteerTarget[];
  /** The target's name, also after it ended. */
  name: string;
  disabled: boolean;
  onChoose: (id: string) => void;
}) {
  const tc = useTranslations('Composer');
  if (situation === 'idle') return null;
  if (situation === 'noTarget' || !target)
    return (
      <span className="min-w-0 truncate px-1 text-caption text-muted-foreground">
        {tc('targetNone')}
      </span>
    );
  const shown = situation === 'awaiting' ? tc('targetAwaiting', { name }) : name;
  return (
    <Menu>
      <MenuTrigger
        data-slot="composer-target"
        disabled={disabled}
        aria-label={tc('targetLabel', { name })}
        className="flex min-w-0 shrink rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* A fixed target that can no longer take its instruction reads as a warning. */}
        <KitBadge
          color={situation === 'blocked' ? 'amber' : 'gray'}
          className="min-w-0 max-w-56 gap-1.5"
        >
          <span aria-hidden="true">→</span>
          <span className="min-w-0 truncate">{shown}</span>
        </KitBadge>
      </MenuTrigger>
      <MenuPopup align="start" side="top">
        <MenuRadioGroup value={target} onValueChange={(value) => onChoose(String(value))}>
          {targets.map((item) => (
            <MenuRadioItem key={item.id} value={item.id} closeOnClick>
              {item.label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}
