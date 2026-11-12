import type { MeetingConfig } from '@corral/contracts';
import { ModelSelect, profileChoices } from '@corral/react';
import {
  Button,
  Dialog,
  DialogPopup,
  DialogTitle,
  fontWeights,
  Input,
  type ModelOption,
  Textarea,
  Tooltip,
} from '@corral/react/design-kit';
import { Users, X } from '@corral/react/icons';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useEffect, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectsChanged } from '../projects.ts';
import { useServices } from '../services.tsx';
import { sessionRunMode } from './autoChoice.ts';
import { useModelProfiles } from './useModels.ts';

const TEMPLATE = ['architect', 'builder', 'tester'] as const;

/** A field's persistent label, set like the kit's InputField label above its control. */
const FIELD_LABEL = 'pl-2.5 text-muted-foreground';

interface Draft {
  key: string;
  name: string | null;
  aliases: string;
  role: string;
  prompt: string;
  modelProfile: string;
}

/** Comma-separated callings, without repeats or the participant's own name. */
function parseAliases(text: string, name: string) {
  const unique = new Map<string, string>();
  for (const alias of text.split(/[,，、]/)) {
    const value = alias.trim();
    const key = value.toLowerCase();
    if (value && key !== name.trim().toLowerCase() && !unique.has(key)) unique.set(key, value);
  }
  return [...unique.values()];
}

/** opens a group chat; nothing runs until the person sends a message. */
export function StartMeeting({ projectId }: { projectId: string }) {
  const t = useTranslations('Meetings');
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col items-start gap-2">
      <Button variant="tertiary" size="compact" onClick={() => setOpen(true)}>
        <Users size={14} aria-hidden />
        {t('new')}
      </Button>
      {open ? <NewMeetingDialog projectId={projectId} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

export const NEW_MEETING = 'corral:new-meeting';

/** Opens the same new-meeting dialog as the project page, from the sidebar or the palette. */
export function openNewMeeting(projectId: string) {
  window.dispatchEvent(new CustomEvent<string>(NEW_MEETING, { detail: projectId }));
}

/** Hosts the dialog `openNewMeeting` asks for, once for the whole frame. */
export function NewMeetingHost() {
  const [projectId, setProjectId] = useState<string | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<string>).detail;
      if (typeof target === 'string' && target) setProjectId(target);
    };
    window.addEventListener(NEW_MEETING, open);
    return () => window.removeEventListener(NEW_MEETING, open);
  }, []);
  return projectId ? (
    <NewMeetingDialog key={projectId} projectId={projectId} onClose={() => setProjectId(null)} />
  ) : null;
}

export function NewMeetingDialog({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const t = useTranslations('Meetings');
  const tm = useTranslations('ModelSelect');
  const { repository, mode, live } = useServices();
  const navigate = useNavigate();
  const profiles = useModelProfiles();
  const formId = useId();
  const liveModels = sessionRunMode(mode, live) === 'live';
  const options = useMemo(() => {
    if (!liveModels) return ['model-a', 'model-b'].map((id) => ({ value: id, label: id }));
    return (profiles ?? []).map((profile) => ({
      value: profile.profileId,
      label: profile.available ? profile.label : `${profile.label} · ${t('modelUnavailable')}`,
    }));
  }, [profiles, liveModels, t]);
  // The same rows as the composer's picker: named profiles, then each connected provider's models.
  const choices = useMemo<ModelOption[]>(
    () =>
      liveModels
        ? profileChoices(profiles ?? [], {
            profiles: tm('profiles'),
            unavailable: t('modelUnavailable'),
          })
        : options.map((option) => ({ id: option.value, name: option.label, description: '' })),
    [profiles, liveModels, options, t, tm],
  );
  const available = liveModels
    ? options.filter((option) =>
        profiles?.some((profile) => profile.profileId === option.value && profile.available),
      )
    : options;
  const pick = (index: number) =>
    available[index % available.length]?.value ?? options[0]?.value ?? '';
  const [title, setTitle] = useState(t('defaultTitle'));
  const [draftParticipants, setParticipants] = useState<Draft[]>(() =>
    TEMPLATE.map((id, index) => ({
      key: id,
      name: null,
      aliases: '',
      role: '',
      prompt: '',
      modelProfile: pick(index),
    })),
  );
  const usedNames = new Set([
    'secretary',
    '비서',
    ...draftParticipants.map((_, index) => `p${index + 1}`),
    ...draftParticipants.flatMap((item) =>
      item.name === null ? [] : [item.name.trim().toLowerCase()],
    ),
  ]);
  const participants = draftParticipants.map((item, index) => {
    const modelProfile = item.modelProfile || pick(index);
    const label = profiles?.find((profile) => profile.profileId === modelProfile)?.label;
    const base = (
      label && label !== modelProfile ? label : t('participantDefault', { number: index + 1 })
    ).trim();
    let name = item.name ?? base.slice(0, 40);
    if (item.name === null) {
      for (let duplicate = 2; usedNames.has(name.toLowerCase()); duplicate++) {
        const suffix = ` (${duplicate})`;
        name = `${base.slice(0, 40 - suffix.length)}${suffix}`;
      }
      usedNames.add(name.toLowerCase());
    }
    return { ...item, name, modelProfile };
  });
  const [secretaryChoice, setSecretary] = useState(() => pick(0));
  const secretary = secretaryChoice || pick(0);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isAvailable = (profileId: string) =>
    !liveModels ||
    profiles?.some((profile) => profile.profileId === profileId && profile.available);
  const unavailable = participants.filter((item) => !isAvailable(item.modelProfile));
  const ready = options.length > 0 && unavailable.length === 0 && isAvailable(secretary);
  const change = (key: string, patch: Partial<Draft>) =>
    setParticipants((current) =>
      current.map((item) => (item.key === key ? { ...item, ...patch } : item)),
    );
  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (saving || !ready) return;
    const meeting: MeetingConfig = {
      version: 1,
      participants: participants.map((item, index) => {
        const aliases = parseAliases(item.aliases, item.name);
        const role = item.role.trim();
        return {
          participantId: `p${index + 1}`,
          name: item.name.trim(),
          ...(aliases.length ? { aliases } : {}),
          ...(role ? { role } : {}),
          prompt: item.prompt.trim(),
          modelProfile: item.modelProfile,
        };
      }),
      secretary: { modelProfile: secretary },
    };
    setSaving(true);
    setError('');
    try {
      const result = await repository.createSession({
        projectId,
        title: title.trim() || t('defaultTitle'),
        meeting,
      });
      if (!result.ok) return setError(result.message);
      projectsChanged();
      onClose();
      await navigate({
        to: '/sessions/$sessionId',
        params: { sessionId: result.session.sessionId },
      });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !saving) onClose();
      }}
    >
      <DialogPopup size="lg" className="flex max-h-[90dvh] flex-col gap-4 overflow-auto">
        <DialogTitle>{t('newTitle')}</DialogTitle>
        <form id={formId} className="flex flex-col gap-4 text-body" onSubmit={create}>
          <label className="flex flex-col gap-1">
            <span className={FIELD_LABEL}>{t('title')}</span>
            <Input
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          {/* The numbered cards show this is the participant list; its name is for assistive technology. */}
          <fieldset className="flex min-w-0 flex-col gap-3">
            <legend className="sr-only">{t('participants')}</legend>
            {participants.map((item, index) => {
              const number = index + 1;
              const heading = `${formId}-participant-${item.key}`;
              return (
                // Named by its heading rather than a legend, so the heading shares a row with
                // the remove button without lending it its name.
                <fieldset
                  key={item.key}
                  aria-labelledby={heading}
                  className="@container flex min-w-0 flex-col gap-2 rounded fill-group p-3"
                >
                  <div className="flex min-h-7 items-center justify-between gap-2">
                    <h3
                      id={heading}
                      className="text-body"
                      style={{ fontVariationSettings: fontWeights.semibold }}
                    >
                      {t('participantDefault', { number })}
                    </h3>
                    {participants.length > 2 ? (
                      <Tooltip content={t('removeParticipant', { number })}>
                        <Button
                          type="button"
                          size="icon-compact"
                          variant="ghost"
                          aria-label={t('removeParticipant', { number })}
                          onClick={() =>
                            setParticipants((current) => current.filter((x) => x.key !== item.key))
                          }
                        >
                          <X aria-hidden />
                        </Button>
                      </Tooltip>
                    ) : null}
                  </div>
                  {/* The short visible labels read under the card's heading; each control's
                      own name still says whose field it is. */}
                  <div className="grid gap-2 @sm:grid-cols-2">
                    <label className="flex min-w-0 flex-col gap-1">
                      <span aria-hidden className={FIELD_LABEL}>
                        {t('nameLabel')}
                      </span>
                      <Input
                        aria-label={t('participantName', { number })}
                        value={item.name}
                        maxLength={40}
                        required
                        onChange={(event) => change(item.key, { name: event.target.value })}
                      />
                    </label>
                    <div className="flex min-w-0 flex-col gap-1">
                      <span aria-hidden className={FIELD_LABEL}>
                        {t('modelLabel')}
                      </span>
                      <ModelSelect
                        label={t('participantModel', { number })}
                        value={item.modelProfile}
                        options={choices}
                        onValueChange={(modelProfile) => change(item.key, { modelProfile })}
                      />
                    </div>
                  </div>
                  <label className="flex flex-col gap-1">
                    <span aria-hidden className={FIELD_LABEL}>
                      {t('aliasesLabel')}
                    </span>
                    <Input
                      aria-label={t('participantAliases', { number })}
                      placeholder={t('aliasesPlaceholder')}
                      value={item.aliases}
                      maxLength={340}
                      onChange={(event) => change(item.key, { aliases: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span aria-hidden className={FIELD_LABEL}>
                      {t('roleTagLabel')}
                    </span>
                    <Input
                      aria-label={t('participantRoleTag', { number })}
                      value={item.role}
                      maxLength={40}
                      onChange={(event) => change(item.key, { role: event.target.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span aria-hidden className={FIELD_LABEL}>
                      {t('roleDescriptionLabel')}
                    </span>
                    {/* Two lines to start; the field grows with what is written. */}
                    <Textarea
                      size="sm"
                      className="[&_textarea]:min-h-[calc(2lh+0.75rem)]"
                      aria-label={t('participantRoleDescription', { number })}
                      value={item.prompt}
                      maxLength={4000}
                      rows={2}
                      onChange={(event) => change(item.key, { prompt: event.target.value })}
                    />
                  </label>
                </fieldset>
              );
            })}
            <div className="flex flex-wrap gap-2">
              {participants.length < 6 ? (
                <Button
                  type="button"
                  size="compact"
                  variant="tertiary"
                  onClick={() =>
                    setParticipants((current) => [
                      ...current,
                      {
                        key: `extra_${globalThis.crypto.randomUUID()}`,
                        name: null,
                        aliases: '',
                        role: '',
                        prompt: '',
                        modelProfile: pick(current.length),
                      },
                    ])
                  }
                >
                  {t('addParticipant')}
                </Button>
              ) : null}
              <Button
                type="button"
                size="compact"
                variant="tertiary"
                onClick={() =>
                  setParticipants((current) =>
                    current.map((item, index) => {
                      const role = TEMPLATE[index];
                      return role
                        ? {
                            ...item,
                            name: t(`template.${role}.name`),
                            prompt: t(`template.${role}.role`),
                          }
                        : item;
                    }),
                  )
                }
              >
                {t('applyDevelopmentRoles')}
              </Button>
            </div>
          </fieldset>
          {liveModels && profiles === null ? (
            <p role="status" className="text-muted-foreground">
              {t('modelsLoading')}
            </p>
          ) : null}
          {liveModels && profiles !== null && !available.length ? (
            <p role="alert" className="text-danger">
              {t('noConnectedModels')}
            </p>
          ) : null}
          {liveModels && profiles !== null && unavailable.length ? (
            <div role="alert" className="flex flex-col gap-2">
              <p className="text-danger">
                {t('unavailableParticipants', {
                  names: unavailable.map((item) => item.name).join(', '),
                })}
              </p>
              {participants.length - unavailable.length >= 2 ? (
                <div>
                  <Button
                    type="button"
                    size="compact"
                    variant="tertiary"
                    onClick={() =>
                      setParticipants((current) =>
                        current.filter((item) => isAvailable(item.modelProfile)),
                      )
                    }
                  >
                    {t('removeUnavailable')}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <span aria-hidden className={FIELD_LABEL}>
              {t('secretaryModel')}
            </span>
            <ModelSelect
              label={t('secretaryModel')}
              value={secretary}
              options={choices}
              onValueChange={setSecretary}
            />
            {liveModels && profiles !== null && !isAvailable(secretary) ? (
              <p role="alert" className="text-danger">
                {t('secretaryUnavailable')}
              </p>
            ) : null}
          </div>
          {error ? (
            <p role="alert" className="text-danger wrap-anywhere">
              {error}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="tertiary" disabled={saving} onClick={onClose}>
              {t('cancel')}
            </Button>
            <Button type="submit" disabled={saving || !ready}>
              {saving ? t('creating') : t('create')}
            </Button>
          </div>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
