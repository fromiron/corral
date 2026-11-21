import { DEFAULT_ADVISOR_REVIEW, SharedOutrider } from '@corral/contracts';
import type { SharedOutriderTarget } from '@corral/core';
import { useId, useState } from 'react';
import { useTranslations } from 'use-intl';
import { ModelSelect, profileChoices } from '../components/ModelSelect.tsx';
import {
  Button,
  Checkbox,
  Input,
  KitRadioGroup,
  KitRadioItem,
  KitSwitch,
  Textarea,
} from '../design-kit/index.ts';
import type { EditorStore } from '../editor/store.ts';
import { setSharedOutrider } from './commands.ts';
import type { ProfileOption } from './NodeSettings.tsx';

/** The whole form is applied in one edit. Closing or cancelling discards its local input. */
export function SharedOutriderSettings({
  editor,
  targets,
  profiles,
  onClose,
}: {
  editor: EditorStore;
  targets: readonly SharedOutriderTarget[];
  profiles: ProfileOption[] | null;
  onClose: () => void;
}) {
  const t = useTranslations('TeamEditor.sharedOutrider');
  const rejected = useTranslations('TeamEditor.rejected');
  const tm = useTranslations('ModelSelect');
  const inspector = useTranslations('Inspector');
  const id = useId();
  const definition = editor.getState().draft.definition;
  const [value, setValue] = useState<SharedOutrider>(() => {
    const teamModel = definition.roles[0]?.modelProfile ?? '';
    const available = profiles?.filter((profile) => profile.available);
    return (
      definition.sharedOutrider ?? {
        modelProfile: profiles?.length
          ? (available?.find((p) => p.profileId === teamModel)?.profileId ??
            available?.[0]?.profileId ??
            '')
          : teamModel,
        principles: t('defaultPrinciples'),
        targets: { kind: 'all' },
      }
    );
  });
  const labelCounts = new Map<string, number>();
  for (const { label } of targets) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  const valid = SharedOutrider.safeParse(value).success;
  const apply = (settings: SharedOutrider | null) => {
    const result = setSharedOutrider(editor.getState().draft, settings);
    if (!result.ok) return;
    editor.getState().applyDraft(result.draft);
    onClose();
  };

  const observation = value.observation;
  const invalidInterval =
    observation &&
    (!Number.isSafeInteger(observation.review.interval) || observation.review.interval < 1);
  const scopeField = (
    scope: SharedOutrider['targets'],
    ask: boolean,
    change: (next: SharedOutrider['targets']) => void,
  ) => {
    const selected = scope.kind === 'selected' ? scope.nodeIds : null;
    return (
      <fieldset className="grid gap-2">
        <legend className="text-caption">{t(ask ? 'scope' : 'watches')}</legend>
        <KitRadioGroup
          className="w-full"
          aria-label={t(ask ? 'scope' : 'watches')}
          value={scope.kind}
          onValueChange={(kind) => {
            if (kind !== scope.kind) {
              change(kind === 'all' ? { kind } : { kind: 'selected', nodeIds: [] });
            }
          }}
        >
          <KitRadioItem index={0} value="all" label={t('all')} />
          <KitRadioItem index={1} value="selected" label={t('selected')} />
        </KitRadioGroup>
        <ul aria-label={t('workers')} className="grid gap-1 text-caption">
          {targets.map((target) => {
            const checked = selected?.includes(target.nodeId) ?? false;
            const label =
              labelCounts.get(target.label) === 1
                ? target.label
                : `${target.label} (${target.nodeId})`;
            return (
              <li key={target.nodeId}>
                {selected ? (
                  <Checkbox
                    label={label}
                    checked={checked}
                    disabled={ask && Boolean(target.unavailable) && !checked}
                    onToggle={() =>
                      change({
                        kind: 'selected',
                        nodeIds: checked
                          ? selected.filter((item) => item !== target.nodeId)
                          : [...selected, target.nodeId],
                      })
                    }
                  />
                ) : (
                  label
                )}
                {ask && target.unavailable ? (
                  <p className="text-muted-foreground">{t(`limits.${target.unavailable}`)}</p>
                ) : ask && target.permissionPending ? (
                  <p className="text-muted-foreground">{t('permissionUnconfirmed')}</p>
                ) : null}
              </li>
            );
          })}
        </ul>
        {targets.length ? null : (
          <p className="text-caption text-muted-foreground">
            {t(ask ? 'noWorkers' : 'noWatchedWorkers')}
          </p>
        )}
      </fieldset>
    );
  };

  return (
    <>
      <div className="grid gap-1">
        <label className="text-caption" htmlFor={`${id}-model`}>
          {t('model')}
        </label>
        {profiles?.length ? (
          <ModelSelect
            id={`${id}-model`}
            label={t('model')}
            value={value.modelProfile}
            options={profileChoices(profiles, {
              profiles: tm('profiles'),
              unavailable: inspector('profileSignIn'),
            })}
            onValueChange={(modelProfile) => setValue({ ...value, modelProfile })}
          />
        ) : (
          <Input
            id={`${id}-model`}
            value={value.modelProfile}
            onChange={(event) => setValue({ ...value, modelProfile: event.target.value })}
          />
        )}
      </div>
      <label className="grid gap-1 text-caption" htmlFor={`${id}-principles`}>
        {t('principles')}
        <Textarea
          id={`${id}-principles`}
          rows={4}
          className="resize-y"
          value={value.principles}
          onChange={(event) => setValue({ ...value, principles: event.target.value })}
        />
      </label>
      {scopeField(value.targets, true, (targets) => setValue({ ...value, targets }))}
      <div className="grid gap-1">
        <KitSwitch
          label={t('artifactReview')}
          checked={value.artifactReview === true}
          onToggle={() => {
            const { artifactReview, ...settings } = value;
            setValue(artifactReview ? settings : { ...settings, artifactReview: true });
          }}
        />
        {value.artifactReview ? (
          <p className="text-caption text-muted-foreground">{t('onRequest')}</p>
        ) : null}
      </div>
      <Checkbox
        label={t('observe')}
        checked={Boolean(observation)}
        onToggle={() => {
          if (observation) {
            const { observation: _removed, ...remaining } = value;
            setValue(remaining);
          } else {
            setValue({
              ...value,
              observation: { targets: value.targets, review: { ...DEFAULT_ADVISOR_REVIEW } },
            });
          }
        }}
      />
      {observation ? (
        <>
          {scopeField(observation.targets, false, (targets) =>
            setValue({ ...value, observation: { ...observation, targets } }),
          )}
          <label className="grid gap-1 text-caption" htmlFor={`${id}-interval`}>
            {t('interval')}
            <Input
              id={`${id}-interval`}
              type="number"
              min={1}
              step={1}
              aria-invalid={invalidInterval || undefined}
              aria-describedby={invalidInterval ? `${id}-interval-error` : undefined}
              value={observation.review.interval || ''}
              onChange={(event) =>
                setValue({
                  ...value,
                  observation: {
                    ...observation,
                    review: { ...observation.review, interval: Number(event.target.value) },
                  },
                })
              }
            />
          </label>
          {invalidInterval ? (
            <p id={`${id}-interval-error`} role="status" className="text-caption text-destructive">
              {t('intervalError')}
            </p>
          ) : null}
          <p className="text-caption text-muted-foreground">
            {t('observationCost', {
              model: value.modelProfile,
              cap: observation.review.maxRequestsPerReview,
            })}
          </p>
        </>
      ) : null}
      {!valid && !invalidInterval ? (
        <p role="status" className="text-caption text-muted-foreground">
          {rejected('invalidSharedOutrider')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button size="compact" disabled={!valid} onClick={() => apply(value)}>
          {t('apply')}
        </Button>
        <Button size="compact" variant="secondary" onClick={onClose}>
          {t('cancel')}
        </Button>
        {definition.sharedOutrider ? (
          <Button size="compact" variant="tertiary" onClick={() => apply(null)}>
            {t('remove')}
          </Button>
        ) : null}
      </div>
    </>
  );
}
