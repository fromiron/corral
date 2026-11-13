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
import { ArrowRight, ChevronDown } from '@corral/react/icons';
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
 * the tool line's left side, next to Send. It shows whole or not at all: where the line runs
 * short the folder notice gives way first, and only then does the hint drop (the send menu
 * lists the same keys). While the run's record is being read the keys are not known yet: the
 * line keeps its place, empty.
 */
export function KeyHint({
  keys,
  situation,
  loading = false,
  sendKey,
}: {
  keys: Record<SendKeyRole, SendKind>;
  situation: Situation;
  loading?: boolean;
  sendKey: Preferences['sendKey'];
}) {
  const tc = useTranslations('Composer');
  const labels = sendKeyLabels(sendKey);
  const shown = loading ? [] : usableRoles(keys, situation);
  return (
    <p
      data-slot="composer-keys"
      className="m-0 ml-auto flex h-5 min-w-0 shrink flex-wrap content-start items-center justify-end overflow-hidden whitespace-nowrap text-caption text-muted-foreground"
    >
      {/* Holds the first line, so a hint that does not fit moves to the hidden next one whole. */}
      <span aria-hidden="true" className="h-5 w-0" />
      <span data-slot="composer-keys-hint" className="inline-flex h-5 items-center gap-1.5 pl-1.5">
        {shown.map((role, index) => (
          <span key={role} data-slot="composer-key" className="inline-flex items-center gap-1">
            {index > 0 ? (
              <span aria-hidden="true" className="pr-0.5">
                ·
              </span>
            ) : null}
            <Kbd className="text-foreground">{labels[role]}</Kbd>
            {tc(`keyHint.${keys[role]}`)}
          </span>
        ))}
      </span>
    </p>
  );
}

/**
 * The keys usable now, each once: a key that sends the same as one before it is left out, and
 * while a fixed instruction is blocked its join and interrupt keys are, as the send menu's are.
 */
export function usableRoles(keys: Record<SendKeyRole, SendKind>, situation: Situation) {
  const blocked = situation === 'blocked';
  return ROLES.filter(
    (role, index) =>
      !(blocked && (keys[role] === 'join' || keys[role] === 'interrupt')) &&
      !ROLES.slice(0, index).some((before) => keys[before] === keys[role]),
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
  onClose,
}: {
  situation: Situation;
  sendKey: Preferences['sendKey'];
  /** Nothing to send, or sending is held. */
  disabled: boolean;
  onSend: (choice: SendChoice) => void;
  /** The menu closed, by a send or Escape. */
  onClose?: () => void;
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
    <Menu onOpenChange={(open) => (open ? undefined : onClose?.())}>
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
 * line saying so. Nothing while no run goes, nor while the run's record is being read.
 */
export function TargetChip({
  situation,
  target,
  targets,
  name,
  loading = false,
  disabled,
  onChoose,
  onClose,
}: {
  situation: Situation;
  target: string | null;
  targets: readonly SteerTarget[];
  /** The target's name, also after it ended. */
  name: string;
  /** The run's record is being read: where an instruction goes is not known yet. */
  loading?: boolean;
  disabled: boolean;
  onChoose: (id: string) => void;
  /** The list closed, by a pick or Escape. */
  onClose?: () => void;
}) {
  const tc = useTranslations('Composer');
  if (situation === 'idle') return null;
  // Nothing to say yet, and no room taken from the folder notice, which keeps its width.
  if (loading) return <span aria-hidden="true" data-slot="composer-target-pending" />;
  if (situation === 'noTarget' || !target)
    // The reason keeps the room before the folder notice does, and gives way before the keys.
    return (
      <span
        title={tc('targetNone')}
        className="min-w-0 truncate px-1 text-caption text-muted-foreground sm:min-w-12 sm:max-w-max sm:grow-[100] sm:basis-0"
      >
        {tc('targetNone')}
      </span>
    );
  const shown = situation === 'awaiting' ? tc('targetAwaiting', { name }) : name;
  // A target with nothing else to choose is a fixed badge; with a choice it opens the list.
  const choosable = targets.some((item) => item.id !== target);
  const badge = (
    // A fixed target that can no longer take its instruction reads as a warning.
    <KitBadge color={situation === 'blocked' ? 'amber' : 'gray'}>
      <span className="inline-flex max-w-56 items-center gap-1.5">
        <ArrowRight aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{shown}</span>
        {choosable ? <ChevronDown aria-hidden="true" className="size-3 shrink-0" /> : null}
      </span>
    </KitBadge>
  );
  if (!choosable)
    return (
      <span data-slot="composer-target" className="flex shrink-0">
        {badge}
      </span>
    );
  return (
    <Menu onOpenChange={(open) => (open ? undefined : onClose?.())}>
      <MenuTrigger
        data-slot="composer-target"
        disabled={disabled}
        aria-label={tc('targetLabel', { name })}
        className="flex shrink-0 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {badge}
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
