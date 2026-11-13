import {
  type MeetingConfig,
  type MeetingRoundRequest,
  type MeetingView,
  type QueuedMeetingMessage,
  SECRETARY_ID,
  type TextAttachment,
  textAttachmentKey,
} from '@corral/contracts';
import type { MeetingResult } from '@corral/core';
import {
  Banner,
  BannerActions,
  BannerTitle,
  Button,
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  type QueuedMessage as QueuedCard,
  Textarea,
  Tooltip,
} from '@corral/react/design-kit';
import { FileText, ListChecks, Plus, X } from '@corral/react/icons';
import {
  type Ref,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useTranslations } from 'use-intl';
import { newCommandId } from '../../../sessionActions.ts';
import { ComposerSurface } from '../../ComposerSurface.tsx';
import { MeetingActivity } from '../../MeetingActivity.tsx';
import { MeetingEvidencePicker } from '../../MeetingEvidence.tsx';
import { usePreferences } from '../../preferences.ts';
import {
  COMPOSER_DRAFT_SENT,
  clearSentComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from '../../sessionDraft.ts';
import { QueueLine } from '../ComposerQueue.tsx';
import { ComposerCard, type SendTarget } from './ComposerCard.tsx';
import { backToInput, menuOpenChange } from './focus.ts';
import { RecipientChip, type Recipients } from './SendControls.tsx';

// A meeting's send target (features/composer-flow.md, the send table's meeting row): every key
// sends to the meeting, and the badge in the target's place chooses the recipients — whoever
// the meeting picks, the chosen participants, or no one (posted, nobody asked to reply;
// workbench.md "회의"). Of the conversation's tools a meeting keeps what it supports: evidence
// from the add menu, the waiting message, Stop in Send's place and the activity bar, and the
// secretary's plan beside Send. `/` and
// `@` are text here; `@name` in the text is a mention the meeting reads.

/** An answer that is not a reply. */
export const FAILED_ANSWER = new Set(['failed', 'refused', 'interrupted', 'not_started']);

export const nameOf = (config: MeetingConfig, id: string, secretary: string) =>
  id === SECRETARY_ID
    ? secretary
    : (config.participants.find((p) => p.participantId === id)?.name ?? id);

/** What the participant row asks of the composer. */
export interface MeetingComposerHandle {
  /** Puts `@name ` at the caret and focuses the input, without sending. */
  mention(name: string): void;
}

export interface MeetingComposerProps {
  handle: Ref<MeetingComposerHandle>;
  projectId: string;
  view: MeetingView;
  mode: 'mock' | 'live';
  error: string;
  /** Stops the replies running and waiting; absent while nothing runs. */
  onStop?: (() => Promise<unknown> | undefined) | undefined;
  send(request: MeetingRoundRequest): Promise<MeetingResult | null>;
  /** The person sent. The conversation follows the end again. */
  onSent?: () => void;
  sendQueued(): Promise<MeetingResult | null>;
  dropQueued(): Promise<MeetingResult | null>;
  editQueued(message: QueuedMeetingMessage): Promise<MeetingResult | null>;
}

/** The people a message can be for: the participants, then the secretary on its own. */
function recipientsOf(config: MeetingConfig, secretary: string) {
  return [
    ...config.participants.map((participant) => ({
      id: participant.participantId,
      name: participant.name,
    })),
    { id: SECRETARY_ID, name: secretary },
  ];
}

/** A kept draft's recipients; names the meeting no longer has are dropped. */
function restoredRecipients(
  draft: ReturnType<typeof readComposerDraft>,
  config: MeetingConfig,
): Recipients {
  if (draft.meetingRecipients === 'none') return 'none';
  const known = new Set(recipientsOf(config, '').map((person) => person.id));
  const kept = (draft.meetingMentions ?? []).filter((id) => known.has(id));
  return kept.length ? kept : 'auto';
}

// Under the kit toolbar's `sm` the tool line may wrap. There the meeting's tools take a width
// that does not change with its state, so the line count, and the input's edges, stay put.
const COMPACT = '(max-width: 639px)';
const compactNow = () =>
  typeof window.matchMedia === 'function' && window.matchMedia(COMPACT).matches;
function onCompactChange(change: () => void) {
  if (typeof window.matchMedia !== 'function') return () => {};
  const media = window.matchMedia(COMPACT);
  media.addEventListener?.('change', change);
  return () => media.removeEventListener?.('change', change);
}

/** A meeting's composer: the conversation's card with the recipients as its send target. */
export function MeetingSend({
  handle,
  projectId,
  view,
  mode,
  error,
  onStop,
  send,
  onSent,
  sendQueued,
  dropQueued,
  editQueued,
}: MeetingComposerProps) {
  const t = useTranslations('Meetings');
  const { sendKey } = usePreferences();
  const compact = useSyncExternalStore(onCompactChange, compactNow, () => false);
  const badgeId = useId();
  const [restored] = useState(() => readComposerDraft(view.sessionId));
  const [text, setText] = useState(restored.text);
  const [recipients, setRecipients] = useState<Recipients>(() =>
    restoredRecipients(restored, view.config),
  );
  const [attachments, setAttachments] = useState(restored.attachments ?? []);
  const draft = useMemo(
    () => ({
      text,
      meetingMentions: typeof recipients === 'string' ? [] : [...recipients],
      ...(recipients === 'none' ? { meetingRecipients: 'none' as const } : {}),
      attachments,
      intent: null,
      target: null,
      targetLabel: null,
      references: [],
    }),
    [text, recipients, attachments],
  );
  const draftRevision = useRef(0);
  useEffect(() => {
    draftRevision.current = writeComposerDraft(view.sessionId, draft);
  }, [view.sessionId, draft]);
  useEffect(() => {
    const sent = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId: string; revision: number }>).detail;
      if (detail.sessionId !== view.sessionId || detail.revision !== draftRevision.current) return;
      setText('');
      setRecipients('auto');
      setAttachments([]);
    };
    window.addEventListener(COMPOSER_DRAFT_SENT, sent);
    return () => window.removeEventListener(COMPOSER_DRAFT_SENT, sent);
  }, [view.sessionId]);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  // A message whose answer was lost keeps its command ID, so sending it again is the same command.
  const pending = useRef<{ key: string; commandId: string } | null>(null);
  const active = view.rounds.some((round) => round.active);
  const dispatch = async (
    request: Omit<Extract<MeetingRoundRequest, { kind: 'message' }>, 'commandId' | 'mode'>,
  ) => {
    if (inFlight.current || attachmentLoading) return;
    onSent?.();
    const key = JSON.stringify([request, mode]);
    if (pending.current?.key !== key) pending.current = { key, commandId: newCommandId() };
    inFlight.current = true;
    setSending(true);
    try {
      const result = await send({ ...request, commandId: pending.current.commandId, mode });
      if (result?.ok) pending.current = null;
      return result;
    } finally {
      inFlight.current = false;
      setSending(false);
    }
  };
  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const submittedRevision = writeComposerDraft(view.sessionId, draft);
    const result = await dispatch({
      kind: 'message',
      text: trimmed,
      ...(typeof recipients === 'string' ? {} : { mentions: [...recipients] }),
      ...(recipients === 'none' ? { recipients: 'none' as const } : {}),
      ...(attachments.length ? { attachments } : {}),
    });
    if (result?.ok) clearSentComposerDraft(view.sessionId, submittedRevision);
  };
  const input = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once an inserted mention is in the field (a new object each time).
  const [mentionCaret, setMentionCaret] = useState<{ at: number } | null>(null);
  useImperativeHandle(
    handle,
    () => ({
      mention(name) {
        const box = input.current;
        const start = box?.selectionStart ?? text.length;
        const end = box?.selectionEnd ?? start;
        const before = text.slice(0, start);
        const token = `${before && !/\s$/.test(before) ? ' ' : ''}@${name} `;
        setText(`${before}${token}${text.slice(end)}`);
        setMentionCaret({ at: start + token.length });
        // Calling on someone is speaking to them: a message for no one goes back to Auto.
        if (recipients === 'none') setRecipients('auto');
      },
    }),
    [text, recipients],
  );
  useLayoutEffect(() => {
    if (!mentionCaret || !input.current) return;
    input.current.focus();
    input.current.setSelectionRange(mentionCaret.at, mentionCaret.at);
  }, [mentionCaret]);
  const latestMinutes = view.minutes?.at(-1);
  const latestSecretary = view.rounds
    .findLast((round) => round.kind === 'secretary')
    ?.answers.find((answer) => answer.participantId === SECRETARY_ID);
  const summaryFailed = Boolean(
    latestMinutes?.error || (latestSecretary && FAILED_ANSWER.has(latestSecretary.status)),
  );
  // Evidence is chosen in a dialog the add menu opens; what is chosen stays in the composer.
  const [evidenceOpen, setEvidenceOpen] = useState(false);
  const showEvidence = (open: boolean) => {
    setEvidenceOpen(open);
    // Closing ends the picker and drops its pending read, so nothing is loading any more.
    if (!open) setAttachmentLoading(false);
  };
  const requestPlan = () =>
    void dispatch({ kind: 'message', text: t('summaryRequest'), mentions: [SECRETARY_ID] });
  const held = sending || attachmentLoading;
  // One stop at a time: pressed again while it is on its way, it sends nothing.
  const [stopping, setStopping] = useState(false);
  const stoppingNow = useRef(false);
  const stop = onStop
    ? () => {
        if (stoppingNow.current) return;
        stoppingNow.current = true;
        setStopping(true);
        void Promise.resolve(onStop()).finally(() => {
          stoppingNow.current = false;
          setStopping(false);
        });
      }
    : undefined;
  const toInput = () => backToInput(input);
  const meeting: SendTarget = {
    badge: (
      <RecipientChip
        id={badgeId}
        value={recipients}
        people={recipientsOf(view.config, t('secretary'))}
        alone={SECRETARY_ID}
        compact={compact}
        disabled={sending}
        onChange={setRecipients}
        onClose={toInput}
      />
    ),
    row: 'meeting',
    keys: { send: 'meeting', interrupt: 'meeting', queue: 'meeting' },
    // Send sends to the meeting and says nothing more than its name.
    meaning: t('send'),
    // Every key sends the same, so there is no send menu; its place is kept, and Send stands
    // where a conversation's does.
    menu: (
      <span aria-hidden="true" data-slot="composer-send-menu-place" className="size-7 shrink-0" />
    ),
    sendDisabled: held || !text.trim(),
    send: () => void submit(),
  };
  return (
    <ComposerSurface.Shell>
      <ComposerCard
        label={t('message')}
        placeholder={t('placeholder')}
        // The box is described by whom it goes to, as a conversation's is by its target.
        describedBy={badgeId}
        maxLength={20000}
        inputRef={input}
        text={text}
        onText={setText}
        sendKey={sendKey}
        sendLabel={t('send')}
        target={meeting}
        menus={null}
        // One raised surface, as a conversation's: the activity bar, the waiting message, the input.
        activity={
          <MeetingActivity
            view={view}
            name={(id) => nameOf(view.config, id, t('secretary'))}
            onStop={stop}
            stopping={stopping}
          />
        }
        above={
          view.queued ? (
            <QueuedMessage
              key={view.queued.commandId}
              queued={view.queued}
              config={view.config}
              projectId={projectId}
              active={active}
              edit={editQueued}
              send={() => void sendQueued()}
              drop={() => void dropQueued()}
            />
          ) : null
        }
        // While nothing is written and replies run, Send's place stops them, as a conversation's.
        stop={stop ? { label: t('stopRound'), disabled: stopping, onStop: stop } : null}
        notices={
          summaryFailed || attachments.length ? (
            <>
              {summaryFailed ? (
                <Banner role="alert" status="error" contrast="high">
                  <BannerTitle>{t('summaryFailed')}</BannerTitle>
                  <BannerActions>
                    <Button variant="tertiary" disabled={sending || active} onClick={requestPlan}>
                      {t('retrySummary')}
                    </Button>
                  </BannerActions>
                </Banner>
              ) : null}
              {attachments.length ? (
                <EvidenceChips value={attachments} onChange={setAttachments} disabled={held} />
              ) : null}
            </>
          ) : null
        }
        attach={
          <Menu onOpenChange={menuOpenChange(toInput)}>
            <Tooltip content={t('attachmentActions')}>
              <MenuTrigger
                render={
                  <Button variant="ghost" size="icon-compact" aria-label={t('attachmentActions')} />
                }
              >
                <Plus />
              </MenuTrigger>
            </Tooltip>
            <MenuPopup align="start">
              <MenuItem disabled={held} onClick={() => showEvidence(true)}>
                {t('evidence')}
              </MenuItem>
            </MenuPopup>
          </Menu>
        }
        // The secretary's plan comes before the keys, as a conversation's request settings do:
        // the key hint stays right beside Send. Narrow, it is an icon with its name.
        settings={
          compact ? (
            <Tooltip content={t('summarise')}>
              <Button
                size="icon-compact"
                variant="ghost"
                aria-label={t('summarise')}
                disabled={held || view.rounds.length === 0}
                onClick={requestPlan}
              >
                <ListChecks aria-hidden />
              </Button>
            </Tooltip>
          ) : (
            <Button
              size="compact"
              variant="ghost"
              disabled={held || view.rounds.length === 0}
              onClick={requestPlan}
            >
              {t('summarise')}
            </Button>
          )
        }
      />
      {error ? (
        <p role="alert" className="px-4 pt-1 text-caption text-danger wrap-anywhere">
          {error}
        </p>
      ) : null}
      <Dialog open={evidenceOpen} onOpenChange={showEvidence}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{t('evidence')}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {evidenceOpen ? (
              <MeetingEvidencePicker
                projectId={projectId}
                value={attachments}
                onChange={(next) => {
                  setAttachments(next);
                  // A new item is the choice made; the composer shows it from here.
                  if (next.length > attachments.length) showEvidence(false);
                }}
                onLoading={setAttachmentLoading}
                disabled={sending}
              />
            ) : null}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
    </ComposerSurface.Shell>
  );
}

/** The evidence chosen for the next message, each removable before it is sent. */
function EvidenceChips({
  value,
  onChange,
  disabled,
}: {
  value: TextAttachment[];
  onChange(next: TextAttachment[]): void;
  disabled: boolean;
}) {
  const t = useTranslations('Meetings');
  return (
    <ul
      aria-label={t('evidenceSelected', { count: value.length })}
      className="flex flex-wrap gap-1"
    >
      {value.map((item) => (
        <li
          key={textAttachmentKey(item)}
          className="flex max-w-full items-center gap-1 rounded-md bg-subtle py-0.5 pr-0.5 pl-2 text-caption"
        >
          <FileText size={12} aria-hidden className="shrink-0 text-muted-foreground" />
          <span className="truncate" title={item.name}>
            {item.name}
          </span>
          <Button
            variant="ghost"
            size="icon-tiny"
            disabled={disabled}
            aria-label={t('removeEvidence', { name: item.name })}
            onClick={() =>
              onChange(
                value.filter((entry) => textAttachmentKey(entry) !== textAttachmentKey(item)),
              )
            }
          >
            <X />
          </Button>
        </li>
      ))}
    </ul>
  );
}

/**
 * A message an earlier version left waiting, in the conversation's queue line: sent now while
 * nothing answers, edited in place (keeping its command), or removed.
 */
function QueuedMessage({
  queued,
  config,
  projectId,
  active,
  edit,
  send,
  drop,
}: {
  queued: QueuedMeetingMessage;
  config: MeetingConfig;
  projectId: string;
  active: boolean;
  edit(message: QueuedMeetingMessage): Promise<MeetingResult | null>;
  send(): void;
  drop(): void;
}) {
  const t = useTranslations('Meetings');
  const [editing, setEditing] = useState(false);
  const identity = [
    queued.commandId,
    queued.text,
    ...(queued.attachments ?? []).map((item) => item.sha256),
  ].join('\u0000');
  // biome-ignore lint/correctness/useExhaustiveDependencies: rebuilt only when the message changes
  const items = useMemo<QueuedCard[]>(
    () => [
      {
        id: queued.commandId,
        text: queued.text,
        files: (queued.attachments ?? []).map(
          (item) => new File([item.text], item.name, { type: item.mime }),
        ),
      },
    ],
    [identity],
  );
  if (editing)
    return (
      <QueuedMessageEditor
        queued={queued}
        config={config}
        projectId={projectId}
        edit={edit}
        onDone={() => setEditing(false)}
      />
    );
  const names = queued.mentions.map((id) => nameOf(config, id, t('secretary'))).join(', ');
  return (
    <QueueLine
      items={items}
      onEdit={() => setEditing(true)}
      onRemove={drop}
      renderActions={() => (
        <>
          {names ? (
            <span className="min-w-0 truncate text-caption text-muted-foreground" title={names}>
              {t('to', { names })}
            </span>
          ) : null}
          {active ? null : (
            <Button variant="ghost" onClick={send}>
              {t('sendQueued')}
            </Button>
          )}
        </>
      )}
    />
  );
}

/** The waiting message, edited where it stands: its recipients, words and evidence. */
function QueuedMessageEditor({
  queued,
  config,
  projectId,
  edit,
  onDone,
}: {
  queued: QueuedMeetingMessage;
  config: MeetingConfig;
  projectId: string;
  edit(message: QueuedMeetingMessage): Promise<MeetingResult | null>;
  onDone(): void;
}) {
  const t = useTranslations('Meetings');
  const [text, setText] = useState(queued.text);
  const [mentions, setMentions] = useState(queued.mentions);
  const [attachments, setAttachments] = useState(queued.attachments ?? []);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  return (
    <div className="mx-auto mb-2 flex w-full max-w-(--chat-content-max-width) flex-col gap-2 rounded-lg fill-control p-2">
      {/* The same recipients as the composer's; a waiting message has no No one. */}
      <div className="flex">
        <RecipientChip
          value={mentions.length ? mentions : 'auto'}
          people={recipientsOf(config, t('secretary'))}
          alone={SECRETARY_ID}
          none={false}
          disabled={saving}
          onChange={(next) => setMentions(typeof next === 'string' ? [] : [...next])}
        />
      </div>
      <Textarea
        aria-label={t('queued')}
        value={text}
        maxLength={20000}
        rows={2}
        disabled={saving}
        className="w-full"
        onChange={(event) => setText(event.target.value)}
      />
      <MeetingEvidencePicker
        projectId={projectId}
        value={attachments}
        onChange={setAttachments}
        onLoading={setAttachmentLoading}
        disabled={saving}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={saving || attachmentLoading || !text.trim()}
          onClick={async () => {
            setSaving(true);
            try {
              const result = await edit({
                ...queued,
                text: text.trim(),
                mentions,
                ...(attachments.length || queued.attachments ? { attachments } : {}),
              });
              if (result?.ok) onDone();
            } finally {
              setSaving(false);
            }
          }}
        >
          {t('saveQueued')}
        </Button>
        <Button variant="tertiary" disabled={saving} onClick={onDone}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  );
}
