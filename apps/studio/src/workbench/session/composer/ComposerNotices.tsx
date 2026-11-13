import type { SessionIntent } from '@corral/core';
import { Banner, BannerActions, BannerTitle, Button } from '@corral/react/design-kit';
import { X } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import type { RefObject } from 'react';
import { useTranslations } from 'use-intl';
import type { Blocked, SendChoice } from '../../composerIntent.ts';
import { type MentionItem, mentionLabel } from '../../composerMenu.ts';
import { SourceAttachments } from '../../context/SourceAttachments.tsx';
import { DevelopmentMode } from '../../DevelopmentMode.tsx';
import { ImageAttachmentPicker } from '../../ImageAttachments.tsx';
import { useSettingsNavigation } from '../../navigation.ts';
import { RefusalHelp } from '../../RefusalHelp.tsx';
import { TerminalWriterNotice } from '../../TerminalWriterNotice.tsx';
import { TextAttachmentPicker } from '../../TextAttachments.tsx';
import type { RoleModel } from '../../useModels.ts';
import type { Refusal } from './send.ts';
import type { ComposerDraftState } from './useComposerDraft.ts';

// What sits inside the input surface above the text: why sending is held, the references and
// attachments the request carries, and where it goes.

/** Connect the models, or try the demo instead. */
function ConnectModels({ testId, title }: { testId: string; title: string }) {
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const navigation = useSettingsNavigation();
  return (
    <Banner data-testid={testId} status="warning" contrast="high">
      <BannerTitle>{title}</BannerTitle>
      <BannerActions>
        <Button render={<Link {...navigation.link('models')} />}>{tc('models.connect')}</Button>
        <Button variant="tertiary" render={<a href="/demo" target="_blank" rel="noreferrer" />}>
          {t('tryDemo')}
        </Button>
      </BannerActions>
    </Banner>
  );
}

export function ComposerNotices({
  sessionId,
  intent,
  viewingOtherRun,
  onViewRun,
  blocked,
  onChooseIntent,
  notReady,
  autoBlockedModel,
  missingTeam,
  refusal,
  onRetry,
  missingChipCount,
  chips,
  missing,
  onRemoveChip,
  draft,
  imageFiles,
  textFiles,
  busy,
  destinationId,
  destination,
}: {
  sessionId: string;
  intent: SessionIntent;
  /** The run numbers, while the page shows a run other than the one going. */
  viewingOtherRun: { viewed: number; active: number; activeRunId: string } | null;
  onViewRun: ((runId: string) => void) | undefined;
  blocked: Blocked;
  onChooseIntent: (value: SendChoice) => void;
  notReady: RoleModel[];
  /** The auto model that is not connected; null when it is. */
  autoBlockedModel: string | null;
  missingTeam: boolean;
  refusal: Refusal | null;
  onRetry: () => void;
  missingChipCount: number;
  /** The references the text names; a gone one is struck through. */
  chips: MentionItem[];
  missing: Set<string>;
  onRemoveChip: (item: MentionItem) => void;
  /** The draft's images and text attachments. */
  draft: Pick<
    ComposerDraftState,
    | 'attachmentEpoch'
    | 'images'
    | 'setImages'
    | 'setImagesBusy'
    | 'attachments'
    | 'setAttachments'
    | 'setAttachmentsBusy'
    | 'attachmentsBusy'
  >;
  imageFiles: RefObject<HTMLInputElement | null>;
  textFiles: RefObject<HTMLInputElement | null>;
  busy: boolean;
  destinationId: string;
  destination: string;
}) {
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const { attachmentEpoch, images, attachments, attachmentsBusy } = draft;
  return (
    <>
      {intent !== 'steer' ? <TerminalWriterNotice sessionId={sessionId} /> : null}
      {viewingOtherRun ? (
        <Banner data-testid="viewed-run-warning" status="warning">
          <BannerTitle>
            {tc('viewingOtherRun', {
              viewed: viewingOtherRun.viewed,
              active: viewingOtherRun.active,
            })}
          </BannerTitle>
          {onViewRun ? (
            <BannerActions>
              <Button variant="secondary" onClick={() => onViewRun(viewingOtherRun.activeRunId)}>
                {tc('viewActiveRun')}
              </Button>
            </BannerActions>
          ) : null}
        </Banner>
      ) : null}
      {blocked ? (
        // A fixed target that cannot take its instruction: the person picks another target in
        // the tool line, or sends this as a next request; it never goes elsewhere by itself.
        <Banner data-testid="intent-blocked" status="warning" contrast="high">
          <BannerTitle>{tc(`blocked.${blocked}`)}</BannerTitle>
          <BannerActions>
            <Button variant="secondary" onClick={() => onChooseIntent('queue')}>
              {tc('switchTo.next')}
            </Button>
          </BannerActions>
        </Banner>
      ) : null}
      {notReady.length ? (
        <ConnectModels
          testId="models-not-ready"
          title={tc('models.notReady', {
            roles: notReady.map((r) => `${r.name} (${r.profileId})`).join(', '),
          })}
        />
      ) : null}
      {autoBlockedModel !== null ? (
        <ConnectModels
          testId="models-not-ready"
          title={t('autoNotReady', { model: autoBlockedModel })}
        />
      ) : null}
      {missingTeam && (intent === 'next' || intent === 'explain') ? (
        <p role="alert" data-testid="selected-team-missing" className="text-caption text-warning">
          {t('selectedTeamMissing')}
        </p>
      ) : null}
      {refusal ? (
        <RefusalHelp
          sessionId={sessionId}
          message={refusal.message}
          code={refusal.code}
          owner={refusal.owner}
          network={refusal.network}
          onRetry={onRetry}
        />
      ) : null}
      {missingChipCount ? (
        <p role="alert" className="text-caption text-danger">
          {tc('missingReferences', { count: missingChipCount })}
        </p>
      ) : null}
      {refusal?.code === 'RUN_ALREADY_ACTIVE' ? (
        <DevelopmentMode sessionId={sessionId} onlyActive />
      ) : null}
      {chips.length ? (
        <ul aria-label={tc('references')} className="flex flex-wrap gap-1">
          {chips.map((item) => (
            <li
              key={item.id}
              data-missing={missing.has(item.id) || undefined}
              className={`flex max-w-full items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 text-caption ${missing.has(item.id) ? 'bg-danger/10 text-danger line-through' : 'bg-subtle'}`}
            >
              <span className="truncate font-mono" title={mentionLabel(item)}>
                {mentionLabel(item)}
              </span>
              {missing.has(item.id) ? <span className="sr-only">{tc('referenceGone')}</span> : null}
              <Button
                variant="ghost"
                size="icon-tiny"
                aria-label={tc('removeReference', { label: mentionLabel(item) })}
                onClick={() => onRemoveChip(item)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <ImageAttachmentPicker
        key={`images:${attachmentEpoch}`}
        inputRef={imageFiles}
        enabled={intent === 'next'}
        sessionId={sessionId}
        value={images}
        onChange={draft.setImages}
        onBusyChange={draft.setImagesBusy}
        disabled={busy}
      />
      <TextAttachmentPicker
        key={`text:${attachmentEpoch}`}
        inputRef={textFiles}
        value={attachments}
        onChange={draft.setAttachments}
        onLoading={draft.setAttachmentsBusy}
        disabled={busy}
        // Text attachments ride every send (features/composer-flow.md "합류 대상").
        enabled
        hideList
      />
      <SourceAttachments
        value={attachments}
        onChange={draft.setAttachments}
        disabled={busy || attachmentsBusy}
      />
      {/* Where Send goes, for assistive tech: the tool line's target and keys show it. */}
      <p id={destinationId} data-testid="composer-destination" className="sr-only">
        {destination}
      </p>
    </>
  );
}
