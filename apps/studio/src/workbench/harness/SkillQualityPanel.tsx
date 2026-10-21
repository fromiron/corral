import type { HarnessApi, ModelProfileView } from '@corral/client';
import type {
  HarnessDefault,
  HarnessEntryView,
  SkillAdoption,
  SkillEvaluationRequest,
  SkillEvaluationView,
  SkillFileComparison,
  SkillKey,
  SkillUpdatePreview,
} from '@corral/contracts';
import { Button, Select } from '@corral/react/ui';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../../services.tsx';
import { useSettingsNavigation } from '../navigation.ts';
import { operationId } from './Target.tsx';

const keyOf = (entry: { resourceHash: string; entry: string }) =>
  `${entry.resourceHash}:${entry.entry}`;
const skillKey = (entry: HarnessEntryView): SkillKey => ({
  resourceHash: entry.resourceHash,
  entry: entry.entry,
  kind: 'skill',
});
type Fixture = SkillEvaluationRequest['fixtures'][number];
const emptyFixture = (positive: boolean): Fixture => ({
  id: operationId(),
  brief: '',
  expected: { kind: 'exact', text: '' },
  shouldActivate: positive,
  phase: positive ? 'calibration' : 'holdout',
});

export function SkillQualityPanel({
  api,
  entry,
  entries,
  onChanged,
}: {
  api: HarnessApi;
  entry: HarnessEntryView;
  entries: HarnessEntryView[];
  onChanged(): void;
}) {
  const t = useTranslations('SkillQuality');
  const { models, live } = useServices();
  const navigation = useSettingsNavigation();
  const [profiles, setProfiles] = useState<ModelProfileView[]>([]);
  const [model, setModel] = useState('model-a');
  const [mode, setMode] = useState<'mock' | 'live'>('mock');
  const [baseline, setBaseline] = useState(() => {
    const previous = entries.find(
      (item) => item.successor && keyOf(item.successor) === keyOf(entry),
    );
    return previous ? keyOf(previous) : 'none';
  });
  const [fixtures, setFixtures] = useState<Fixture[]>(() => [
    emptyFixture(true),
    emptyFixture(false),
  ]);
  const [history, setHistory] = useState<SkillEvaluationView[]>([]);
  const [view, setView] = useState<SkillEvaluationView | null>(null);
  const [preview, setPreview] = useState<SkillUpdatePreview | null>(null);
  const [scope, setScope] = useState(
    navigation.projectId ? `project:${navigation.projectId}` : 'personal:default',
  );
  const [target, setTarget] = useState<HarnessDefault | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const [adoptions, setAdoptions] = useState<SkillAdoption[]>([]);
  const adoption = adoptions.find(
    (item) => item.target.scope === target?.scope && item.target.scopeId === target.scopeId,
  );
  const rollbackCurrent =
    adoption &&
    target?.revision === adoption.defaultRevision &&
    target.binding?.profileId === adoption.binding.profileId &&
    target.binding?.revision === adoption.binding.revision;
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const active = useRef(true);
  const operation = useRef<{ kind: string; signature: string; id: string } | null>(null);
  const previous = entries.find((item) => keyOf(item) === baseline);
  const running = view?.status === 'running';
  const runningId = running ? view.id : null;
  const candidateHash = entry.resourceHash,
    candidateEntry = entry.entry,
    trustedAt = entry.resource.trustedAt;
  const baseHash = previous?.resourceHash,
    baseEntry = previous?.entry;
  function idFor(kind: string, input: unknown) {
    const signature = JSON.stringify(input);
    if (operation.current?.kind !== kind || operation.current.signature !== signature)
      operation.current = { kind, signature, id: operationId() };
    return operation.current.id;
  }
  async function work(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      if (active.current) setError(failure instanceof Error ? failure.message : t('failed'));
    } finally {
      if (active.current) setBusy(false);
    }
  }
  function edit(action: () => void) {
    setView(null);
    setReviewed(false);
    setError('');
    action();
  }
  const restore = useCallback((value: SkillEvaluationView) => {
    setView(value);
    setMode(value.request.mode);
    setModel(value.request.modelProfile);
    setBaseline(value.request.baseline ? keyOf(value.request.baseline) : 'none');
    setFixtures(value.request.fixtures);
    setReviewed(false);
  }, []);
  useEffect(() => {
    active.current = true;
    let current = true;
    void api
      .skillEvaluations({ resourceHash: candidateHash, entry: candidateEntry, kind: 'skill' })
      .then((values) => {
        if (current) {
          setHistory(values);
          if (values[0]) restore(values[0]);
        }
      })
      .catch((failure) => current && setError(failure.message));
    void api
      .skillAdoptions({ resourceHash: candidateHash, entry: candidateEntry, kind: 'skill' })
      .then((values) => {
        if (current) setAdoptions(values);
      })
      .catch((failure) => current && setError(failure.message));
    void models
      ?.profiles()
      .then((values) => current && setProfiles(values))
      .catch(() => {});
    return () => {
      current = false;
      active.current = false;
    };
  }, [api, candidateHash, candidateEntry, models, restore]);
  useEffect(() => {
    let current = true;
    setTarget(null);
    setReviewed(false);
    const [kind, ...parts] = scope.split(':');
    void api
      .default(kind as 'personal' | 'project', parts.join(':'))
      .then((value) => current && setTarget(value))
      .catch((failure) => current && setError(failure.message));
    return () => {
      current = false;
    };
  }, [api, scope]);
  useEffect(() => {
    let current = true;
    setPreview(null);
    if (trustedAt)
      void api
        .skillPreview(
          { resourceHash: candidateHash, entry: candidateEntry, kind: 'skill' },
          baseHash && baseEntry
            ? { resourceHash: baseHash, entry: baseEntry, kind: 'skill' }
            : undefined,
        )
        .then((value) => current && setPreview(value))
        .catch((failure) => current && setError(failure.message));
    return () => {
      current = false;
    };
  }, [api, candidateHash, candidateEntry, trustedAt, baseHash, baseEntry]);
  useEffect(() => {
    if (!runningId) return;
    let current = true;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void api
        .skillEvaluation(runningId)
        .then((next) => {
          if (!current) return;
          setView(next);
          if (next.status !== 'running')
            setHistory((prior) => [next, ...prior.filter((item) => item.id !== next.id)]);
        })
        .catch((failure) => current && setError(failure.message))
        .finally(() => {
          pending = false;
        });
    }, 700);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [api, runningId]);
  const skillName = entry.resource.skills.find((skill) => skill.entry === entry.entry)?.name;
  const candidates = entries.filter(
    (item) =>
      keyOf(item) !== keyOf(entry) &&
      item.kind === 'skill' &&
      item.resource.skills.some((skill) => skill.entry === item.entry && skill.name === skillName),
  );
  return (
    <details className="settings-surface" data-testid="skill-quality">
      <summary className="cursor-pointer font-semibold">{t('title')}</summary>
      <div className="mt-4 flex flex-col gap-4">
        <p className="text-sm text-muted">{t('intro')}</p>
        {!entry.resource.trustedAt ? <p className="text-sm">{t('trustFirst')}</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
        <fieldset disabled={busy || running} className="flex flex-col gap-4">
          <Select
            label={t('baseline')}
            value={baseline}
            onValueChange={(value) => edit(() => setBaseline(value))}
            options={[
              { value: 'none', label: t('noSkill') },
              ...candidates.map((item) => ({
                value: keyOf(item),
                label: `${item.name} · ${item.resource.version} · ${item.resourceHash.slice(0, 7)}`,
              })),
            ]}
          />
          {preview ? (
            <details>
              <summary>{t('changes', { count: preview.changes.length })}</summary>
              <p className="text-sm">
                {preview.sourceChanged ? t('sourceChanged') : t('sourceSame')} ·{' '}
                {preview.licenseChanged ? t('licenseChanged') : t('licenseSame')}
              </p>
              <ul className="mt-2 max-h-48 overflow-auto text-xs">
                {preview.changes.map((change) => (
                  <li key={change.path} className="break-all">
                    <SkillFileReview
                      key={`${candidateHash}:${baseHash}:${change.path}`}
                      api={api}
                      preview={preview}
                      change={change}
                    />
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          {fixtures.map((fixture, index) => (
            <fieldset key={fixture.id} className="flex flex-col gap-2 border-t border-line pt-3">
              <legend className="text-sm font-medium">{t('fixture', { number: index + 1 })}</legend>
              <label className="text-sm">
                {t('request')}
                <textarea
                  className="settings-field mt-1 w-full"
                  rows={2}
                  value={fixture.brief}
                  onChange={(event) =>
                    edit(() =>
                      setFixtures(
                        fixtures.map((row) =>
                          row.id === fixture.id ? { ...row, brief: event.target.value } : row,
                        ),
                      ),
                    )
                  }
                />
              </label>
              <label className="text-sm">
                {t('expected')}
                <textarea
                  className="settings-field mt-1 w-full"
                  rows={2}
                  value={
                    fixture.expected.kind === 'exact'
                      ? fixture.expected.text
                      : JSON.stringify(fixture.expected)
                  }
                  onChange={(event) =>
                    edit(() =>
                      setFixtures(
                        fixtures.map((row) =>
                          row.id === fixture.id
                            ? { ...row, expected: { kind: 'exact', text: event.target.value } }
                            : row,
                        ),
                      ),
                    )
                  }
                />
              </label>
              <Select
                label={t('activation')}
                value={String(fixture.shouldActivate)}
                options={[
                  { value: 'true', label: t('positive') },
                  { value: 'false', label: t('negative') },
                ]}
                onValueChange={(value) =>
                  edit(() =>
                    setFixtures(
                      fixtures.map((row) =>
                        row.id === fixture.id ? { ...row, shouldActivate: value === 'true' } : row,
                      ),
                    ),
                  )
                }
              />
              <Select
                label={t('phase')}
                value={fixture.phase}
                options={[
                  { value: 'calibration', label: t('calibration') },
                  { value: 'holdout', label: t('holdout') },
                ]}
                onValueChange={(value) =>
                  edit(() =>
                    setFixtures(
                      fixtures.map((row) =>
                        row.id === fixture.id ? { ...row, phase: value as Fixture['phase'] } : row,
                      ),
                    ),
                  )
                }
              />
              {fixtures.length > 2 ? (
                <Button
                  variant="ghost"
                  onClick={() =>
                    edit(() => setFixtures(fixtures.filter((row) => row.id !== fixture.id)))
                  }
                >
                  {t('remove')}
                </Button>
              ) : null}
            </fieldset>
          ))}
          {fixtures.length < 10 ? (
            <Button
              variant="outline"
              onClick={() => edit(() => setFixtures([...fixtures, emptyFixture(true)]))}
            >
              {t('addFixture')}
            </Button>
          ) : null}
          <Select
            label={t('mode')}
            value={mode}
            options={[
              { value: 'mock', label: t('mock') },
              ...(live ? [{ value: 'live', label: t('live') }] : []),
            ]}
            onValueChange={(value) => edit(() => setMode(value as 'mock' | 'live'))}
          />
          <Select
            label={t('model')}
            value={model}
            options={
              profiles.length
                ? profiles
                    .filter((profile) => mode === 'mock' || profile.available)
                    .map((profile) => ({
                      value: profile.profileId,
                      label: `${profile.modelName ?? profile.modelId} · ${profile.profileId}`,
                    }))
                : [{ value: 'model-a', label: 'model-a' }]
            }
            onValueChange={(value) => edit(() => setModel(value))}
          />
          <p className="text-xs text-muted">
            {mode === 'mock' ? t('mockHint') : t('liveHint', { calls: fixtures.length * 8 })}
          </p>
          <Button
            disabled={!preview || !fixtures.every((fixture) => fixture.brief.trim())}
            onClick={() =>
              void work(async () => {
                const input = {
                  candidate: skillKey(entry),
                  ...(previous ? { baseline: skillKey(previous) } : {}),
                  modelProfile: model,
                  mode,
                  fixtures,
                };
                const next = await api.evaluateSkill({
                  ...input,
                  operationId: idFor('evaluate', input),
                });
                if (active.current) {
                  setView(next);
                  setReviewed(false);
                  operation.current = null;
                }
              })
            }
          >
            {t('evaluate')}
          </Button>
        </fieldset>
        {running ? (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              void work(async () => {
                const next = await api.cancelSkillEvaluation(view.id);
                if (active.current) setView(next);
              })
            }
          >
            {t('cancel')}
          </Button>
        ) : null}
        {history.length ? (
          <Select
            label={t('history')}
            value={view?.id ?? ''}
            options={[
              { value: '', label: t('chooseEvaluation') },
              ...history.map((item) => ({
                value: item.id,
                label: `${item.createdAt} · ${t(item.request.mode)} · ${t(`status.${item.status}`)}`,
              })),
            ]}
            onValueChange={(id) => {
              const found = history.find((item) => item.id === id);
              if (found) restore(found);
            }}
            disabled={busy || running}
          />
        ) : null}
        {view ? (
          <section aria-label={t('results')} className="flex flex-col gap-3">
            <p role="status">
              {t(`status.${view.status}`)} · {t(view.request.mode)} · {view.results.length}/
              {view.request.fixtures.length * 2}
            </p>
            {view.request.mode === 'mock' ? (
              <p className="text-xs text-muted">{t('mockHint')}</p>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr>
                    <th>{t('variant')}</th>
                    <th>{t('quality')}</th>
                    <th>{t('activation')}</th>
                    <th>{t('calls')}</th>
                  </tr>
                </thead>
                <tbody>
                  {view.results.map((result) => (
                    <tr key={result.runId}>
                      <td>
                        {t(result.variant)} ·{' '}
                        {view.request.fixtures.findIndex(
                          (fixture) => fixture.id === result.fixtureId,
                        ) + 1}
                        <details>
                          <summary>{t('output')}</summary>
                          <pre className="max-w-md whitespace-pre-wrap break-words text-xs">
                            {result.output ?? t('unknown')}
                            {result.outputTruncated ? '…' : ''}
                          </pre>
                        </details>
                      </td>
                      <td>
                        {result.correct === null
                          ? t('unknown')
                          : result.correct
                            ? t('pass')
                            : t('fail')}
                      </td>
                      <td>
                        {result.activationPassed === null
                          ? t('unknown')
                          : result.activationPassed
                            ? t('pass')
                            : t('fail')}
                      </td>
                      <td>{result.modelCalls}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}
        <Select
          label={t('target')}
          value={scope}
          options={[
            { value: 'personal:default', label: t('personal') },
            ...navigation.projects.map((project) => ({
              value: `project:${project.projectId}`,
              label: project.name,
            })),
          ]}
          onValueChange={(value) => {
            setScope(value);
            setReviewed(false);
          }}
          disabled={busy || running}
        />
        {!target?.binding ? (
          <Link className="text-sm underline" to="/settings/harness" search={navigation.search}>
            {t('configureDefaults')}
          </Link>
        ) : (
          <p className="text-xs text-muted">
            {t('targetVersion', { revision: target.binding.revision })}
          </p>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={reviewed}
            disabled={busy || running || view?.status !== 'completed'}
            onChange={(event) => setReviewed(event.target.checked)}
          />
          {t('reviewed')}
        </label>
        <Button
          disabled={
            busy || running || !reviewed || !target?.binding || view?.status !== 'completed'
          }
          onClick={() =>
            void work(async () => {
              if (!view || !target?.binding) return;
              const input = {
                evaluationId: view.id,
                reviewed: true as const,
                target: {
                  scope: target.scope,
                  scopeId: target.scopeId,
                  expectedRevision: target.revision,
                  binding: target.binding,
                },
              };
              const adopted = await api.adoptSkill({
                ...input,
                operationId: idFor('adopt', input),
              });
              if (active.current) {
                setAdoptions((prior) => [adopted, ...prior]);
                setTarget({
                  ...target,
                  revision: adopted.defaultRevision,
                  binding: adopted.binding,
                });
                setReviewed(false);
                operation.current = null;
                onChanged();
              }
            })
          }
        >
          {t('adopt')}
        </Button>
        {adoption ? (
          <div className="flex flex-col gap-2">
            <p role="status">{t(rollbackCurrent ? 'adopted' : 'defaultChanged')}</p>
            <Button
              variant="outline"
              disabled={busy || !rollbackCurrent}
              onClick={() =>
                void work(async () => {
                  const input = {
                    adoptionId: adoption.id,
                    expectedRevision: adoption.defaultRevision,
                  };
                  const restored = await api.rollbackSkill({
                    ...input,
                    operationId: idFor('rollback', input),
                  });
                  if (active.current) {
                    setTarget(restored);
                    setAdoptions((prior) => prior.filter((item) => item.id !== adoption.id));
                    setReviewed(false);
                    operation.current = null;
                    onChanged();
                  }
                })
              }
            >
              {t('rollback')}
            </Button>
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SkillFileReview({
  api,
  preview,
  change,
}: {
  api: HarnessApi;
  preview: SkillUpdatePreview;
  change: SkillUpdatePreview['changes'][number];
}) {
  const t = useTranslations('SkillQuality');
  const [comparison, setComparison] = useState<SkillFileComparison | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  return (
    <details
      onToggle={(event) => {
        if (!event.currentTarget.open || comparison || loading) return;
        setLoading(true);
        setError('');
        void api
          .skillFile(preview.candidate, preview.baseline ?? undefined, change.path)
          .then(setComparison)
          .catch(() => setError(t('failed')))
          .finally(() => setLoading(false));
      }}
    >
      <summary>
        {t(`categories.${change.category}`)} · {t(`changesKind.${change.change}`)} · {change.path}
      </summary>
      {error ? <p role="alert">{error}</p> : null}
      {loading ? <p role="status">{t('loadingFile')}</p> : null}
      {comparison ? (
        <div className="grid gap-3 py-2 lg:grid-cols-2">
          {(['before', 'after'] as const).map((side) => (
            <section key={side} aria-label={t(side)}>
              <h4 className="font-semibold">{t(side)}</h4>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {comparison[side]?.text ?? t(comparison[side] ? 'binaryFile' : 'absentFile')}
              </pre>
              {comparison[side] ? (
                <p className="mt-1 text-muted">
                  {comparison[side].bytes} B · SHA-256 {comparison[side].hash}
                </p>
              ) : null}
            </section>
          ))}
        </div>
      ) : null}
    </details>
  );
}
