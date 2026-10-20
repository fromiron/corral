import type { ModelProfileView } from '@corral/client';
import { ImageGenerationProfile } from '@corral/contracts';
import { Button } from '@corral/react/ui';
import { useEffect, useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { type ImageProfilesView, imageProfilesApi } from '../image-profiles-api.ts';

const field = 'min-w-0 rounded border border-line bg-surface px-2 py-1.5 text-sm';

/** Image operations have their own explicit provider model and spend limits. */
export function ImageProfileSettings({ modelProfiles }: { modelProfiles: ModelProfileView[] }) {
  const t = useTranslations('ImageProfiles');
  const heading = useId();
  const [data, setData] = useState<ImageProfilesView | null>(null);
  const [draft, setDraft] = useState<ImageGenerationProfile | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    void imageProfilesApi
      .list()
      .then((next) => {
        if (active) setData(next);
      })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : t('failed'));
      });
    return () => {
      active = false;
    };
  }, [t]);
  async function act(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await action();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby={heading} className="settings-surface flex flex-col gap-3">
      <h3 id={heading} className="text-sm font-semibold">
        {t('heading')}
      </h3>
      <p className="text-sm text-muted">{t('intro')}</p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p role="status" className="text-sm">
          {t('saved')}
        </p>
      ) : null}
      {!data && !error ? (
        <p role="status" className="text-sm text-muted">
          {t('loading')}
        </p>
      ) : null}
      {data && !data.profiles.length ? <p className="text-sm text-muted">{t('empty')}</p> : null}
      <ul className="flex flex-col gap-2">
        {data?.profiles.map((profile) => (
          <li
            key={profile.profileId}
            className="flex flex-wrap items-center gap-2 rounded border border-line p-2 text-sm"
          >
            <div className="min-w-0 flex-1">
              <p className="break-words font-medium">{profile.profileId}</p>
              <p className="break-words text-xs text-muted">
                {profile.modelId} · {profile.modelProfileId}
              </p>
              {data.statuses?.[profile.profileId]?.available === false ? (
                <p className="text-xs text-warning">
                  {data.statuses[profile.profileId]?.reason ?? t('unavailable')}
                </p>
              ) : null}
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDraft(profile);
                setEditingId(profile.profileId);
                setDeleteId(null);
                setSaved(false);
              }}
            >
              {t('edit')}
            </Button>
            {deleteId === profile.profileId ? (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await imageProfilesApi.remove(profile.profileId);
                      setData(await imageProfilesApi.list());
                      setDeleteId(null);
                      if (editingId === profile.profileId) {
                        setDraft(null);
                        setEditingId(null);
                      }
                    })
                  }
                >
                  {t('confirmDelete')}
                </Button>
                <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDeleteId(null)}>
                  {t('cancel')}
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setDeleteId(profile.profileId)}
              >
                {t('delete')}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {draft ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void act(async () => {
              const parsed = ImageGenerationProfile.safeParse(draft);
              if (!parsed.success) throw new Error(t('invalid'));
              if (
                !editingId &&
                data?.profiles.some((profile) => profile.profileId === draft.profileId)
              )
                throw new Error(t('duplicate'));
              await imageProfilesApi.save(parsed.data);
              setData(await imageProfilesApi.list());
              setDraft(null);
              setEditingId(null);
              setSaved(true);
            });
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs">
              {t('id')}
              <input
                className={field}
                value={draft.profileId}
                disabled={busy || editingId !== null}
                required
                pattern={'[A-Za-z][A-Za-z0-9_.:\\-]{0,119}'}
                onChange={(event) => setDraft({ ...draft, profileId: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t('providerProfile')}
              <select
                className={field}
                value={draft.modelProfileId}
                disabled={busy}
                required
                onChange={(event) => setDraft({ ...draft, modelProfileId: event.target.value })}
              >
                <option value="">{t('selectProfile')}</option>
                {draft.modelProfileId &&
                !modelProfiles.some((profile) => profile.profileId === draft.modelProfileId) ? (
                  <option value={draft.modelProfileId}>
                    {draft.modelProfileId} ({t('unavailable')})
                  </option>
                ) : null}
                {modelProfiles.map((profile) => (
                  <option key={profile.profileId} value={profile.profileId}>
                    {profile.profileId}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t('model')}
              <input
                className={field}
                value={draft.modelId}
                disabled={busy}
                required
                maxLength={200}
                onChange={(event) => setDraft({ ...draft, modelId: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t('timeout')}
              <input
                className={field}
                type="number"
                min={1}
                max={600}
                step={1}
                value={Number.isFinite(draft.timeoutMs) ? draft.timeoutMs / 1000 : ''}
                disabled={busy}
                required
                onChange={(event) =>
                  setDraft({ ...draft, timeoutMs: event.target.valueAsNumber * 1000 })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t('calls')}
              <input
                className={field}
                type="number"
                min={1}
                max={16}
                step={1}
                value={Number.isFinite(draft.maxCallsPerRun) ? draft.maxCallsPerRun : ''}
                disabled={busy}
                required
                onChange={(event) =>
                  setDraft({ ...draft, maxCallsPerRun: event.target.valueAsNumber })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-xs">
              {t('cost')}
              <input
                className={field}
                type="number"
                min={0.000001}
                max={100}
                step="any"
                value={draft.maxCostUsdPerCall || ''}
                disabled={busy}
                required
                onChange={(event) =>
                  setDraft({ ...draft, maxCostUsdPerCall: event.target.valueAsNumber })
                }
              />
            </label>
          </div>
          <p className="text-xs text-muted">{t('limitsHint')}</p>
          <div className="flex gap-2">
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              {busy ? t('saving') : t('save')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                setDraft(null);
                setEditingId(null);
              }}
            >
              {t('cancel')}
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          disabled={busy || !data}
          onClick={() => {
            setDraft({
              profileId: '',
              modelProfileId: '',
              modelId: '',
              api: 'openai-images',
              timeoutMs: 120000,
              maxCallsPerRun: 1,
              maxCostUsdPerCall: 0,
            });
            setEditingId(null);
            setDeleteId(null);
            setSaved(false);
          }}
        >
          {t('add')}
        </Button>
      )}
      <p className="text-xs text-muted">{t('roleHint')}</p>
    </section>
  );
}
