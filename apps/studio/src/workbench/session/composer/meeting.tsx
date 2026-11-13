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
  fontWeights,
  Menu,
  MenuItem,
  MenuPopup,
  MenuTrigger,
  Textarea,
  Tooltip,
} from '@corral/react/design-kit';
import { FileText, Plus, Square, X } from '@corral/react/icons';
import {
  type Ref,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslations } from 'use-intl';
import { newCommandId } from '../../../sessionActions.ts';
import { ComposerSurface } from '../../ComposerSurface.tsx';
import { MeetingEvidencePicker } from '../../MeetingEvidence.tsx';
import { usePreferences } from '../../preferences.ts';
import {
  COMPOSER_DRAFT_SENT,
  clearSentComposerDraft,
  readComposerDraft,
  writeComposerDraft,
} from '../../sessionDraft.ts';
import { TextAttachmentList } from '../../TextAttachments.tsx';
import { ComposerCard, type SendTarget } from './ComposerCard.tsx';
import { RecipientChip, type Recipients, SendMenu } from './SendControls.tsx';

// A meeting's send target (features/composer-flow.md, the send table's meeting row): every key
// sends to the meeting, and the badge in the target's place chooses the recipients — whoever
// the meeting picks, the chosen participants, or no one (posted, nobody asked to reply;
// workbench.md "회의"). Of the conversation's tools a meeting keeps what it supports: evidence
// from the add menu, the waiting message, Stop and the secretary's plan beside Send. `/` and
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
  onStop?: (() => void) | undefined;
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

const restoredRecipients = (draft: ReturnType<typeof readComposerDraft>): Recipients =>
  draft.meetingRecipients === 'none'
    ? 'none'
    : draft.meetingMentions?.length
      ? draft.meetingMentions
      : 'auto';

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
  const tc = useTranslations('Composer');
  const { sendKey } = usePreferences();
  const [restored] = useState(() => readComposerDraft(view.sessionId));
  const [text, setText] = useState(restored.text);
  const [recipients, setRecipients] = useState<Recipients>(() => restoredRecipients(restored));
  const [attachments, setAttachments] = useState(restored.attachments ?? []);
  const clear = () => {
    setText('');
    setRecipients('auto');
    setAttachments([]);
  };
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
      },
    }),
    [text],
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
  // A menu of the composer, once used, gives the focus back to the box.
  const backToInput = () =>
    requestAnimationFrame(() => {
      const focused = document.activeElement;
      if (!focused || focused === document.body || focused.closest('[role="menu"]'))
        input.current?.focus();
    });
  const meeting: SendTarget = {
    badge: (
      <RecipientChip
        value={recipients}
        people={recipientsOf(view.config, t('secretary'))}
        alone={SECRETARY_ID}
        disabled={sending}
        onChange={setRecipients}
        onClose={backToInput}
      />
    ),
    row: 'meeting',
    keys: { send: 'meeting', interrupt: 'meeting', queue: 'meeting' },
    meaning: tc('sendAs.meeting'),
    menu: <SendMenu situation="meeting" sendKey={sendKey} disabled onSend={() => {}} />,
    sendDisabled: held || !text.trim(),
    send: () => void submit(),
  };
  return (
    <ComposerSurface.Shell>
      {view.queued ? (
        <div
          role="status"
          className="mb-2 flex flex-col gap-1 rounded-lg fill-control p-2 text-caption"
        >
          <span style={{ fontVariationSettings: fontWeights.semibold }}>{t('queued')}</span>
          <QueuedMessage
            key={view.queued.commandId}
            queued={view.queued}
            config={view.config}
            projectId={projectId}
            edit={editQueued}
          />
          <span className="text-muted-foreground">
            {active ? t('queuedHint') : t('queuedIdle')}
          </span>
          <div className="flex gap-2">
            {active ? null : <Button onClick={() => void sendQueued()}>{t('sendQueued')}</Button>}
            <Button variant="tertiary" onClick={() => void dropQueued()}>
              {t('dropQueued')}
            </Button>
          </div>
        </div>
      ) : null}
      <ComposerCard
        label={t('message')}
        placeholder={t('placeholder')}
        maxLength={20000}
        inputRef={input}
        text={text}
        onText={setText}
        sendKey={sendKey}
        sendLabel={t('send')}
        target={meeting}
        menus={null}
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
          <Menu onOpenChange={(open) => (open ? undefined : backToInput())}>
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
        afterTarget={
          text || recipients !== 'auto' || attachments.length ? (
            <Button size="compact" variant="ghost" disabled={sending} onClick={clear}>
              {t('clearDraft')}
            </Button>
          ) : null
        }
        // Stop and the secretary's plan come before the keys, as a conversation's request
        // settings do: the key hint stays right beside Send.
        settings={
          <>
            {onStop ? (
              <Button size="compact" variant="tertiary" onClick={onStop}>
                <Square size={12} aria-hidden />
                {t('stopRound')}
              </Button>
            ) : null}
            <Button
              size="compact"
              variant="ghost"
              disabled={held || view.rounds.length === 0}
              onClick={requestPlan}
            >
              {t('summarise')}
            </Button>
          </>
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

/** A message an earlier version left waiting: edited and sent as it was. */
function QueuedMessage({
  queued,
  config,
  projectId,
  edit,
}: {
  queued: QueuedMeetingMessage;
  config: MeetingConfig;
  projectId: string;
  edit(message: QueuedMeetingMessage): Promise<MeetingResult | null>;
}) {
  const t = useTranslations('Meetings');
  const [text, setText] = useState(queued.text);
  const [mentions, setMentions] = useState(queued.mentions);
  const [attachments, setAttachments] = useState(queued.attachments ?? []);
  const [attachmentLoading, setAttachmentLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  return editing ? (
    <div className="flex flex-col gap-2">
      {/* The same recipients as the composer's; a waiting message has no No one. */}
      <div className="flex">
        <RecipientChip
          value={mentions.length ? mentions : 'auto'}
          people={recipientsOf(config, t('secretary'))}
          alone={SECRETARY_ID}
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
              if (result?.ok) setEditing(false);
            } finally {
              setSaving(false);
            }
          }}
        >
          {t('saveQueued')}
        </Button>
        <Button variant="tertiary" disabled={saving} onClick={() => setEditing(false)}>
          {t('cancel')}
        </Button>
      </div>
    </div>
  ) : (
    <>
      <p className="whitespace-pre-wrap wrap-anywhere">{queued.text}</p>
      {queued.mentions.length ? (
        <p>
          {t('to', {
            names: queued.mentions.map((id) => nameOf(config, id, t('secretary'))).join(', '),
          })}
        </p>
      ) : null}
      {queued.attachments?.length ? <TextAttachmentList attachments={queued.attachments} /> : null}
      <div>
        <Button
          variant="tertiary"
          onClick={() => {
            setText(queued.text);
            setMentions(queued.mentions);
            setAttachments(queued.attachments ?? []);
            setEditing(true);
          }}
        >
          {t('editQueued')}
        </Button>
      </div>
    </>
  );
}
