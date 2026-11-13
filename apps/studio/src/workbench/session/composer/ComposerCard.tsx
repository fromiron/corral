import { InputMessage, Tooltip } from '@corral/react/design-kit';
import type { KeyboardEvent, ReactNode, RefObject } from 'react';
import type { AppCommand } from '../../../commandRegistry.ts';
import { sendKeyLabel } from '../../../shortcuts.ts';
import { ComposerInput } from '../../ComposerInput.tsx';
import type { SendKeyRole } from '../../composerIntent.ts';
import type { MentionItem } from '../../composerMenu.ts';
import type { Preferences } from '../../preferences.ts';
import { KeyHint, type KeyMeaning, type SendRow } from './SendControls.tsx';

// The composer's card (features/composer-flow.md "화면 틀"): the input, then one tool line with
// the add menu, where a send goes, the keys and what they send, and Send with its menu. A
// conversation and a meeting draw the same card; what differs is the send target adapter, and
// which of the tools the place supports.

/**
 * Where a send goes and what each key sends: the adapter between the one composer and what it
 * sends to. A conversation's is the join target ("합류 대상"); a meeting's is its recipients (the
 * send table's meeting row, where every key sends to the meeting).
 */
export interface SendTarget {
  /** The badge on the tool line's left: where a send goes, and the menu that changes it. */
  badge: ReactNode;
  /** The send table's row now. */
  row: SendRow;
  /** What each key sends now. */
  keys: Record<SendKeyRole, KeyMeaning>;
  /** What the keys send is not known yet (the run's record is being read). */
  loading?: boolean;
  /** What Send does now, said where it is pressed; Send's name stays Send. */
  meaning: string;
  /** The menu beside Send. */
  menu: ReactNode;
  /** Send is held: nothing to send, or this send cannot go now. */
  sendDisabled: boolean;
  /** A send key, or Send, was pressed. */
  send: (role: SendKeyRole) => void;
}

/** The input's `/` command and `@` reference menu, where the place offers them. */
export interface ComposerMenus {
  commands: AppCommand[];
  searchMentions: (query: string) => Promise<MentionItem[]>;
  onMention: (item: MentionItem) => MentionItem;
}

const noMentions = async () => [];
const same = (item: MentionItem) => item;

export function ComposerCard({
  label,
  placeholder,
  describedBy,
  maxLength,
  inputRef,
  text,
  onText,
  onKeyDown,
  sendKey,
  sendLabel,
  target,
  menus,
  notices,
  attach,
  beforeTarget,
  afterTarget,
  settings,
  end,
}: {
  /** The region's and the box's name. */
  label: string;
  placeholder: string;
  describedBy?: string;
  maxLength?: number;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  text: string;
  onText: (value: string) => void;
  /** Keys the menu and the send keys do not take. */
  onKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  sendKey: Preferences['sendKey'];
  sendLabel: string;
  target: SendTarget;
  /** Without menus, `/` and `@` are plain text. */
  menus: ComposerMenus | null;
  /** Above the input: notices and chips. */
  notices?: ReactNode;
  /** The add menu, first on the tool line. */
  attach: ReactNode;
  beforeTarget?: ReactNode;
  afterTarget?: ReactNode;
  /** The request's settings, right before the keys. */
  settings?: ReactNode;
  /** Right before Send. */
  end?: ReactNode;
}) {
  return (
    <InputMessage
      toolbar="single"
      data-slot="composer-host"
      role="region"
      aria-label={label}
      inputRef={inputRef}
      value={text}
      onValueChange={onText}
      onSend={() => target.send('send')}
      placeholder={placeholder}
      textareaProps={{
        'aria-label': label,
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(maxLength ? { maxLength } : {}),
      }}
      sendDisabled={target.sendDisabled}
      sendLabel={sendLabel}
      // A description that only repeats the name is not read twice.
      sendDescription={target.meaning === sendLabel ? undefined : target.meaning}
      renderAction={(action) => (
        <>
          <Tooltip content={target.meaning} shortcut={sendKeyLabel(sendKey)}>
            {action}
          </Tooltip>
          {target.menu}
        </>
      )}
      contentSlot={notices}
      renderInput={(inputProps) => (
        <ComposerInput
          inputRef={inputProps.ref}
          textareaProps={inputProps}
          label={label}
          placeholder={placeholder}
          value={text}
          onChange={onText}
          onKeyDown={onKeyDown ?? (() => {})}
          sendKey={sendKey}
          onSend={target.send}
          menus={menus !== null}
          commands={menus?.commands ?? []}
          searchMentions={menus?.searchMentions ?? noMentions}
          onMention={menus?.onMention ?? same}
        />
      )}
      leftSlot={
        <>
          {attach} {beforeTarget}
          {target.badge}
          {afterTarget}
          {/* The request's settings, then the keys, right before Send. */}
          <span className="ml-auto flex min-w-0 items-center gap-1.5">
            {settings}
            <KeyHint
              keys={target.keys}
              situation={target.row}
              loading={target.loading ?? false}
              sendKey={sendKey}
            />
          </span>
        </>
      }
      rightSlot={end}
    />
  );
}
