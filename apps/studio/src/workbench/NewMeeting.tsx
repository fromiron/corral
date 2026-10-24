import type { MeetingConfig } from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Input,
  Select,
  Textarea,
} from '@corral/react/design-kit';
import { Users } from '@corral/react/icons';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';
import { projectsChanged } from '../projects.ts';
import { useServices } from '../services.tsx';
import { sessionRunMode } from './autoChoice.ts';
import { useModelProfiles } from './useModels.ts';

const TEMPLATE = ['architect', 'builder', 'tester'] as const;

interface Draft {
  key: string;
  name: string | null;
  prompt: string;
  modelProfile: string;
}

/** CR-049: opens a group chat; nothing runs until the person sends a message. */
export function StartMeeting({ projectId }: { projectId: string }) {
  const t = useTranslations('Meetings');
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="tertiary" size="compact" onClick={() => setOpen(true)}>
        <Users size={14} aria-hidden />
        {t('new')}
      </Button>
      {open ? <NewMeetingDialog projectId={projectId} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function NewMeetingDialog({ projectId, onClose }: { projectId: string; onClose(): void }) {
  const t = useTranslations('Meetings');
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
    const base = (label || modelProfile || t('participantName', { number: index + 1 })).trim();
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
      participants: participants.map((item, index) => ({
        participantId: `p${index + 1}`,
        name: item.name.trim(),
        prompt: item.prompt.trim(),
        modelProfile: item.modelProfile,
      })),
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
      <DialogPopup className="flex max-h-[90dvh] w-[min(95vw,720px)] flex-col gap-4 overflow-auto p-6">
        <DialogTitle>{t('newTitle')}</DialogTitle>
        <DialogDescription>{t('newHint')}</DialogDescription>
        <form id={formId} className="flex flex-col gap-4 text-sm" onSubmit={create}>
          <label className="flex flex-col gap-1">
            {t('title')}
            <Input
              value={title}
              maxLength={120}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 font-medium">{t('participants')}</legend>
            <div>
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
            {participants.map((item, index) => (
              <div key={item.key} className="flex flex-col gap-2 rounded fill-group p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <label className="flex min-w-40 flex-1 flex-col gap-1">
                    {t('participantName', { number: index + 1 })}
                    <Input
                      value={item.name}
                      maxLength={40}
                      required
                      onChange={(event) => change(item.key, { name: event.target.value })}
                    />
                  </label>
                  <div className="flex min-w-0 flex-col gap-1">
                    <span>{t('participantModel', { number: index + 1 })}</span>
                    <Select
                      label={t('participantModel', { number: index + 1 })}
                      value={item.modelProfile}
                      options={options}
                      onValueChange={(modelProfile) => change(item.key, { modelProfile })}
                    />
                  </div>
                  {participants.length > 2 ? (
                    <Button
                      type="button"
                      size="compact"
                      variant="ghost-destructive"
                      onClick={() =>
                        setParticipants((current) => current.filter((x) => x.key !== item.key))
                      }
                    >
                      {t('removeParticipant', { number: index + 1 })}
                    </Button>
                  ) : null}
                </div>
                <label className="flex flex-col gap-1">
                  {t('participantRole', { number: index + 1 })}
                  <Textarea
                    size="sm"
                    value={item.prompt}
                    maxLength={4000}
                    rows={2}
                    onChange={(event) => change(item.key, { prompt: event.target.value })}
                  />
                </label>
              </div>
            ))}
            {participants.length < 6 ? (
              <div>
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
                        prompt: '',
                        modelProfile: pick(current.length),
                      },
                    ])
                  }
                >
                  {t('addParticipant')}
                </Button>
              </div>
            ) : null}
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
            <span>{t('secretaryModel')}</span>
            <Select
              label={t('secretaryModel')}
              value={secretary}
              options={options}
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
