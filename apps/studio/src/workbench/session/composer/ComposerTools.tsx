import type { VoiceTranscript, VoiceTranscriptReceipt } from '@corral/client';
import type { AutoModelChoice, PermissionMode } from '@corral/contracts';
import type { CorralSummary, SessionIntent } from '@corral/core';
import { TermTooltip } from '@corral/react';
import {
  Button,
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
  ModelPicker,
  Select,
  Tooltip,
} from '@corral/react/design-kit';
import { AtSign, FolderOpen, Plus } from '@corral/react/icons';
import { useNavigate, useRouter } from '@tanstack/react-router';
import { useTranslations } from 'use-intl';
import { AutoModelMenu } from '../../AutoModelMenu.tsx';
import { LiveVoice } from '../../LiveVoice.tsx';
import { PermissionModePicker } from '../../PermissionModePicker.tsx';
import type { ProfileInfo } from '../../useModels.ts';
import { type FolderAccess, FolderAccessNotice } from '../../WorkFolderNotice.tsx';

// The composer's tool row choices: the team, the model and reasoning, the permission mode and
// live voice.

/** The kit home's start suggestions: a saved team picks the team chip, never a prompt. */
export function StartSuggestions({
  corrals,
  disabled,
  onTeam,
}: {
  corrals: CorralSummary[];
  disabled: boolean;
  onTeam: (corralId: string) => void;
}) {
  const t = useTranslations('Sessions');
  return (
    <ul aria-label={t('startSuggestions')} className="mt-4 flex flex-wrap justify-center gap-2">
      {corrals.slice(0, 4).map((corral) => (
        <li key={corral.corralId}>
          <Button variant="tertiary" disabled={disabled} onClick={() => onTeam(corral.corralId)}>
            {t('startWithTeam', { team: corral.name })}
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** Puts an `@` at the caret, which opens the reference list. */
export function insertMentionTrigger(
  box: HTMLTextAreaElement | null,
  text: string,
  write: (value: string) => void,
) {
  const at = box?.selectionStart ?? text.length;
  const before = text.slice(0, at);
  const head = `${before}${before && !/\s$/.test(before) ? ' ' : ''}@`;
  write(`${head}${text.slice(at)}`);
  requestAnimationFrame(() => {
    box?.focus();
    box?.setSelectionRange(head.length, head.length);
  });
}

/** The "+" menu: a reference, images, text files and project materials. */
export function AttachMenu({
  onAddReference,
  serverMode,
  imagesDisabled,
  textDisabled,
  onAttachImages,
  onAttachText,
  onAttachMaterials,
}: {
  onAddReference: () => void;
  serverMode: boolean;
  imagesDisabled: boolean;
  textDisabled: boolean;
  onAttachImages: () => void;
  onAttachText: () => void;
  onAttachMaterials: () => void;
}) {
  const tc = useTranslations('Composer');
  const materialMessages = useTranslations('Materials');
  return (
    <Menu>
      <Tooltip content={tc('attachmentActions')}>
        <MenuTrigger
          render={
            <Button variant="ghost" size="icon-compact" aria-label={tc('attachmentActions')} />
          }
        >
          <Plus />
        </MenuTrigger>
      </Tooltip>
      <MenuPopup align="start">
        <MenuItem onClick={onAddReference}>
          <AtSign />
          {tc('addReference')}
        </MenuItem>
        <MenuSeparator />
        {serverMode ? (
          <MenuItem disabled={imagesDisabled} onClick={onAttachImages}>
            {tc('attachImages')}
          </MenuItem>
        ) : null}
        <MenuItem disabled={textDisabled} onClick={onAttachText}>
          {tc('attachText')}
        </MenuItem>
        {serverMode ? (
          <MenuItem disabled={textDisabled} onClick={onAttachMaterials}>
            {materialMessages('attachPlaceholder')}
          </MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** Whether the agent can work with files, or the entry to set up a work folder. */
export function WorkFolderEntry({
  access,
  onAction,
  onWorkFolder,
}: {
  access: FolderAccess;
  onAction: (() => void) | undefined;
  onWorkFolder: (() => void) | undefined;
}) {
  const td = useTranslations('Desktop');
  if (access !== 'unknown') return <FolderAccessNotice access={access} onAction={onAction} />;
  if (!onWorkFolder) return null;
  // The kit home's "work in a folder" entry, while the project has none.
  return (
    <Tooltip content={td('workFolder')}>
      <Button
        variant="ghost"
        size="icon-compact"
        aria-label={td('workFolder')}
        onClick={onWorkFolder}
      >
        <FolderOpen />
      </Button>
    </Tooltip>
  );
}

/** No team, the automatic team, or a saved Corral; "manage" opens the library. */
export function TeamChoice({
  projectId,
  team,
  teamMode,
  corrals,
  isAuto,
  disabled,
  open,
  onOpenChange,
  onTeamMode,
  onTeam,
}: {
  projectId: string;
  team: CorralSummary | null;
  teamMode: 'none' | 'auto';
  corrals: CorralSummary[];
  isAuto: boolean;
  disabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTeamMode: (mode: 'none' | 'auto') => void;
  onTeam: (corralId: string) => void;
}) {
  const tc = useTranslations('Composer');
  const router = useRouter();
  const navigate = useNavigate();
  return (
    <Select
      variant="chip"
      label={tc('teamLabel')}
      value={team ? `corral:${team.corralId}` : teamMode}
      disabled={disabled}
      open={open}
      onOpenChange={onOpenChange}
      // The choice explains Corral in its tooltip (glossary.md); its open menu speaks for itself.
      trigger={(control) => (
        <TermTooltip term="corral" closed={open}>
          {control}
        </TermTooltip>
      )}
      onValueChange={(value) => {
        const choice = String(value);
        if (choice === 'manage')
          // The library's teams for this project, coming back to this session.
          void navigate({
            to: '/library/teams',
            search: {
              project: projectId,
              returnTo: router.state.location.href,
            },
          });
        else if (choice.startsWith('corral:')) onTeam(choice.slice(7));
        else {
          onTeamMode(choice === 'auto' ? 'auto' : 'none');
          if (!isAuto) onTeam('');
        }
      }}
      options={[
        { value: 'none', label: tc('teamNone'), hint: tc('teamNoneHint') },
        // Corral: the automatic team first, then each saved Corral.
        {
          value: 'auto',
          label: tc('teamAuto'),
          hint: tc('teamAutoHint'),
          group: tc('teamCorralGroup'),
        },
        // Each saved team names its revision, so the selected one says which it runs.
        ...corrals.map((corral) => ({
          value: `corral:${corral.corralId}`,
          label: corral.name,
          hint: `r${corral.definitionRevision} · ${tc('teamCorralHint')}`,
          group: tc('teamCorralGroup'),
        })),
        // Creating or editing a Corral happens in the library.
        { value: 'manage', label: tc('manageCorrals'), group: tc('teamCorralGroup') },
      ]}
    />
  );
}

/**
 * The model chip, the permission mode and live voice. `only` renders the request's settings
 * (model and permission) or the voice alone, so the key hint can sit between them.
 */
export function RequestTools({
  only,
  intent,
  showModel,
  browserMode,
  autoChoice,
  profiles,
  busy,
  modelOpen,
  onModelOpenChange,
  onAutoChange,
  permissionMode,
  onPermissionMode,
  voice,
  voiceTarget,
  voiceLabel,
  onTranscript,
}: {
  only?: 'settings' | 'voice';
  intent: SessionIntent;
  /** The session runs auto or with a saved team. */
  showModel: boolean;
  browserMode: boolean;
  autoChoice: AutoModelChoice;
  profiles: ProfileInfo[] | null;
  busy: boolean;
  modelOpen: boolean;
  onModelOpenChange: (open: boolean) => void;
  onAutoChange: (value: AutoModelChoice) => void;
  permissionMode: PermissionMode | undefined;
  onPermissionMode: (value: PermissionMode | undefined) => void;
  voice: Parameters<typeof LiveVoice>[0]['api'];
  voiceTarget: Parameters<typeof LiveVoice>[0]['target'];
  voiceLabel: string;
  onTranscript: (utterance: VoiceTranscript) => Promise<VoiceTranscriptReceipt>;
}) {
  const t = useTranslations('Sessions');
  const tc = useTranslations('Composer');
  const settings = only !== 'voice';
  return (
    <>
      {settings &&
      showModel &&
      (intent === 'next' || intent === 'queue') &&
      (profiles || browserMode) ? (
        profiles ? (
          <AutoModelMenu
            value={autoChoice}
            profiles={profiles}
            showReasoning={intent === 'next' || intent === 'queue'}
            disabled={busy}
            open={modelOpen}
            onOpenChange={onModelOpenChange}
            onChange={onAutoChange}
          />
        ) : (
          <ModelPicker
            models={[]}
            value=""
            placeholder={tc('modelPicker.demo')}
            reasoning={null}
            disabled={busy}
            open={modelOpen}
            onOpenChange={onModelOpenChange}
            side="top"
            align="end"
            labels={{
              model: t('autoModel'),
              settings: tc('modelPicker.settings'),
              trigger: () => t('autoModel'),
              empty: tc('modelPicker.demoEmpty'),
            }}
          />
        )
      ) : null}
      {settings && (intent === 'next' || intent === 'queue') ? (
        <PermissionModePicker value={permissionMode} onChange={onPermissionMode} disabled={busy} />
      ) : null}
      {only !== 'settings' ? (
        <LiveVoice
          api={voice}
          target={voiceTarget}
          targetLabel={voiceLabel}
          onTranscript={onTranscript}
        />
      ) : null}
    </>
  );
}
