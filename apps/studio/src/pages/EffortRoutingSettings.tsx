import { ApiError, type EffortRoutingView } from '@corral/client';
import {
  API_ROUTING_TIMEOUT_MS,
  EFFORT_LEVELS,
  type EffortLevel,
  LOCAL_ROUTING_MAX_THREADS,
  LOCAL_ROUTING_TIMEOUT_MS,
  ROUTING_TIMEOUT_MAX_MS,
  ROUTING_TIMEOUT_MIN_MS,
  type EffortRoutingSettings as Settings,
} from '@corral/contracts';
import {
  Banner,
  BannerTitle,
  Button,
  Checkbox,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  fontWeights,
  Input,
  RadioGroup,
  RadioItem,
  Select,
} from '@corral/react/design-kit';
import { type ReactNode, useEffect, useId, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { formatDownload } from './download-size.ts';

const MB = 1_000_000;

type ApiId = EffortRoutingView['apis'][number]['id'];
type Fallback = 'provider-default' | EffortLevel;

/** What the person is editing; numbers stay text until they are valid. */
type LocalDevice = 'cpu' | 'vulkan' | 'cuda';

interface Form {
  mode: Settings['mode'];
  engine: 'local' | 'api';
  device: LocalDevice;
  threads: string;
  localTimeout: string;
  apiId: ApiId | null;
  apiTimeout: string;
  consent: string | null;
  fallback: Fallback;
}

function formOf(view: EffortRoutingView): Form {
  const saved = view.settings;
  const engine = saved.mode === 'manual' ? saved.engine : null;
  return {
    mode: saved.mode,
    engine: engine?.kind ?? 'local',
    device: localDevice(view, engine?.kind === 'local' ? engine.device.kind : 'cpu'),
    threads: String(engine?.kind === 'local' ? engine.device.threads : view.local.defaultThreads),
    localTimeout: String(
      engine?.kind === 'local' ? engine.callerTimeoutMs : LOCAL_ROUTING_TIMEOUT_MS,
    ),
    apiId:
      engine?.kind === 'api' ? engine.id : (view.apis.find((api) => api.keyConfigured)?.id ?? null),
    apiTimeout: String(engine?.kind === 'api' ? engine.callerTimeoutMs : API_ROUTING_TIMEOUT_MS),
    consent: engine?.kind === 'api' ? engine.consentRevision : null,
    fallback:
      saved.mode === 'manual' && saved.fallback.kind === 'fixed'
        ? saved.fallback.effort
        : 'provider-default',
  };
}

function localDevice(view: EffortRoutingView, saved: LocalDevice): LocalDevice {
  const offered = view.local.devices;
  if (!offered || offered.some((entry) => entry.kind === saved)) return saved;
  return 'cpu';
}

const whole = (text: string, min: number, max: number) => {
  const value = Number(text);
  return /^\d+$/.test(text.trim()) && value >= min && value <= max ? value : null;
};

/** The setting the form describes, or null while something in it cannot be saved. */
function settingsOf(form: Form, view: EffortRoutingView): Settings | null {
  if (form.mode === 'off') return { mode: 'off' };
  const fallback: Extract<Settings, { mode: 'manual' }>['fallback'] =
    form.fallback === 'provider-default'
      ? { kind: 'provider-default' }
      : { kind: 'fixed', effort: form.fallback };
  // The diagnostic Shadow flag has no control here; a save keeps it.
  const application =
    view.settings.mode === 'manual' && view.settings.application
      ? { application: view.settings.application }
      : {};
  if (form.engine === 'local') {
    const threads = whole(form.threads, 1, LOCAL_ROUTING_MAX_THREADS);
    const callerTimeoutMs = whole(
      form.localTimeout,
      ROUTING_TIMEOUT_MIN_MS,
      ROUTING_TIMEOUT_MAX_MS,
    );
    if (!view.local.supported || threads === null || callerTimeoutMs === null) return null;
    if (view.local.devices && !view.local.devices.some((entry) => entry.kind === form.device))
      return null;
    return {
      mode: 'manual',
      engine: { kind: 'local', device: { kind: form.device, threads }, callerTimeoutMs },
      fallback,
      ...application,
    };
  }
  const api = view.apis.find((entry) => entry.id === form.apiId);
  const callerTimeoutMs = whole(form.apiTimeout, ROUTING_TIMEOUT_MIN_MS, ROUTING_TIMEOUT_MAX_MS);
  if (!api?.keyConfigured || form.consent !== api.noticeRevision || callerTimeoutMs === null)
    return null;
  return {
    mode: 'manual',
    engine: { kind: 'api', id: api.id, callerTimeoutMs, consentRevision: api.noticeRevision },
    fallback,
    ...application,
  };
}

const following = (local: EffortRoutingView['local']) =>
  local.install === 'downloading' || local.install === 'verifying' || local.runtime === 'starting';

/**
 * Effort Mode and the one engine `auto` reasoning asks. Saving never downloads: the Local engine
 * installs only from its own button, on the computer that runs the Corral server.
 */
export function EffortRoutingSettings({
  pollMs = 1000,
  reloadKey = 0,
}: {
  pollMs?: number;
  /** Read again when it changes, as after a decision API key is saved or removed. */
  reloadKey?: number;
}) {
  const t = useTranslations('EffortRouting');
  const tr = useTranslations('Reasoning');
  const { models } = useServices();
  const heading = useId();
  const [view, setView] = useState<EffortRoutingView | null>(null);
  const [edit, setEdit] = useState<Form | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<'saved' | null>(null);
  const [problem, setProblem] = useState<
    | 'loadFailed'
    | 'saveFailed'
    | 'conflict'
    | 'actionFailed'
    | 'removeInstalling'
    | 'removeJudging'
    | 'removeFailed'
    | null
  >(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reloadKey asks for a fresh read.
  useEffect(() => {
    let mounted = true;
    void models?.effortRouting().then(
      (value) => {
        if (mounted) setView(value);
      },
      () => {
        if (mounted) setProblem('loadFailed');
      },
    );
    return () => {
      mounted = false;
    };
  }, [models, reloadKey]);

  // Follow an install or a start one request at a time; leaving that state stops following.
  const follow = view ? following(view.local) : false;
  useEffect(() => {
    if (!follow || !models) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = () => {
      timer = setTimeout(async () => {
        try {
          const next = await models.effortRouting();
          if (stopped) return;
          setView(next);
          if (following(next.local)) poll();
        } catch {
          if (!stopped) poll();
        }
      }, pollMs);
    };
    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [follow, models, pollMs]);

  const baseline = view ? formOf(view) : null;
  const form = edit ?? baseline;
  const settings = form && view ? settingsOf(form, view) : null;
  const dirty = !!edit && JSON.stringify(edit) !== JSON.stringify(baseline);
  const runSettingsTask = useSettingsTask('effort-routing');
  useSettingsForm({ dirty, pending: busy, ...(settings ? { save } : {}) });

  async function act(action: () => Promise<void>, failure: 'saveFailed' | 'actionFailed') {
    setBusy(true);
    setProblem(null);
    setNotice(null);
    try {
      await runSettingsTask(action);
      return true;
    } catch {
      setProblem(failure);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (!models || !view || !settings || busy) return false;
    return act(async () => {
      try {
        setView(await models.saveEffortRouting(settings, view.revision));
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'REVISION_CONFLICT')) throw error;
        // Another section saved the workspace setting; save again only if this one is unchanged.
        const fresh = await models.effortRouting();
        if (JSON.stringify(fresh.settings) !== JSON.stringify(view.settings)) {
          setView(fresh);
          setEdit(null);
          setProblem('conflict');
          return;
        }
        setView(await models.saveEffortRouting(settings, fresh.revision));
      }
      setEdit(null);
      setNotice('saved');
    }, 'saveFailed');
  }

  const change = (patch: Partial<Form>) => {
    if (!form) return;
    setNotice(null);
    setEdit({ ...form, ...patch });
  };
  const localAction = (action: () => Promise<EffortRoutingView>) =>
    void act(async () => setView(await action()), 'actionFailed');
  const removeLocal = () => {
    if (!models) return;
    const api = models;
    void act(async () => {
      try {
        setView(await api.removeLocalRouting());
      } catch (error) {
        if (error instanceof ApiError && error.message === 'an install is in progress') {
          setProblem('removeInstalling');
          return;
        }
        if (error instanceof ApiError && error.message === 'a judgment is running') {
          setProblem('removeJudging');
          return;
        }
        setProblem('removeFailed');
      }
    }, 'actionFailed');
  };

  if (!models) return null;
  return (
    <section aria-labelledby={heading} className="settings-surface flex flex-col gap-4">
      <h3
        id={heading}
        className="text-subtitle"
        style={{ fontVariationSettings: fontWeights.semibold }}
      >
        {t('heading')}
      </h3>
      {problem === 'loadFailed' ? (
        <p role="alert" className="text-body text-danger">
          {t('loadFailed')}
        </p>
      ) : null}
      {view && form ? (
        <>
          <Labeled label={t('mode')}>
            <RadioGroup
              aria-label={t('mode')}
              value={form.mode}
              onValueChange={(mode) => change({ mode: mode as Form['mode'] })}
              className="w-fit"
            >
              <RadioItem value="off" index={0} label={t('modes.off')} />
              <RadioItem value="manual" index={1} label={t('modes.manual')} />
            </RadioGroup>
          </Labeled>
          {form.mode === 'manual' ? (
            <>
              <Labeled label={t('engine')}>
                <RadioGroup
                  aria-label={t('engine')}
                  value={form.engine}
                  onValueChange={(engine) => change({ engine: engine as Form['engine'] })}
                  className="w-fit"
                >
                  <RadioItem value="local" index={0} label={t('engines.local')} />
                  <RadioItem value="api" index={1} label={t('engines.api')} />
                </RadioGroup>
              </Labeled>
              {form.engine === 'local' ? (
                <LocalEngine
                  view={view}
                  form={form}
                  busy={busy}
                  change={change}
                  install={() => localAction(() => models.installLocalRouting(form.device))}
                  cancel={() => localAction(() => models.cancelLocalRoutingInstall())}
                  start={() => localAction(() => models.startLocalRouting())}
                  remove={removeLocal}
                />
              ) : (
                <ApiEngine view={view} form={form} change={change} />
              )}
              <Labeled label={t('fallback')}>
                <Select<Fallback>
                  label={t('fallback')}
                  value={form.fallback}
                  onValueChange={(fallback) => change({ fallback })}
                  options={[
                    { value: 'provider-default', label: tr('provider_default') },
                    ...EFFORT_LEVELS.map((level) => ({
                      value: level,
                      label: tr(`level.${level}`),
                    })),
                  ]}
                  className="w-fit min-w-48"
                />
              </Labeled>
            </>
          ) : null}
          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="primary"
              type="button"
              disabled={busy || !dirty || !settings}
              onClick={() => void save()}
            >
              {t('save')}
            </Button>
            {notice === 'saved' ? (
              <p role="status" className="text-body">
                {t('saved')}
              </p>
            ) : null}
          </div>
          {problem && problem !== 'loadFailed' ? (
            <p role="alert" className="text-body text-danger">
              {t(problem)}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function LocalEngine({
  view,
  form,
  busy,
  change,
  install,
  cancel,
  start,
  remove,
}: {
  view: EffortRoutingView;
  form: Form;
  busy: boolean;
  change(patch: Partial<Form>): void;
  install(): void;
  cancel(): void;
  start(): void;
  remove(): void;
}) {
  const t = useTranslations('EffortRouting');
  const format = useFormatter();
  const downloadHint = useId();
  const prepareHint = useId();
  const [confirming, setConfirming] = useState(false);
  const local = view.local;
  const catalog = local.devices ?? [
    {
      kind: 'cpu' as const,
      installed: local.install === 'installed',
      downloadBytes: local.downloadBytes ?? 0,
      requirement: null,
    },
  ];
  const picked = catalog.find((entry) => entry.kind === form.device) ?? catalog[0]!;
  const mb = (bytes: number) => format.number(Math.round(bytes / MB));
  const downloadBytes = local.devices ? picked.downloadBytes : local.downloadBytes;
  const removeBytes = local.installedBytes ?? local.downloadBytes;
  const download =
    downloadBytes === null
      ? null
      : formatDownload(downloadBytes, (value, options) => format.number(value, options));
  const removal =
    removeBytes === null
      ? null
      : formatDownload(removeBytes, (value, options) => format.number(value, options));
  const pickedInstalled = local.devices ? picked.installed : local.install === 'installed';
  const status = !local.supported
    ? t('unsupported')
    : local.install === 'downloading'
      ? t('install.downloading', {
          percent: local.progress
            ? Math.floor((local.progress.received / local.progress.total) * 100)
            : 0,
          received: mb(local.progress?.received ?? 0),
          total: mb(local.progress?.total ?? downloadBytes ?? 0),
        })
      : local.install === 'verifying'
        ? t('install.verifying')
        : local.install === 'install-error' &&
            (!local.devices || form.device === local.device.requested)
          ? t('install.install-error')
          : !pickedInstalled
            ? t('install.absent', {
                size: download?.size ?? mb(downloadBytes ?? 0),
                unit: download?.unit ?? 'MB',
              })
            : t(`runtime.${local.runtime}`);
  const savedEngine =
    view.settings.mode === 'manual' && view.settings.engine.kind === 'local'
      ? view.settings.engine
      : null;
  const canPrepare =
    savedEngine !== null &&
    savedEngine.device.kind === form.device &&
    pickedInstalled &&
    (local.runtime === 'stopped' || local.runtime === 'error');
  const canInstall =
    local.supported &&
    !pickedInstalled &&
    local.install !== 'downloading' &&
    local.install !== 'verifying';
  const canRemove =
    local.supported &&
    (local.devices ? catalog.some((entry) => entry.installed) : local.install === 'installed');
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h4 style={{ fontVariationSettings: fontWeights.semibold }}>
            {local.model ?? t('engines.local')}
          </h4>
          <p className="text-caption text-muted-foreground">{t('host', { host: local.host })}</p>
          <p role="status" className="text-body">
            {status}
          </p>
          {local.supported && local.error ? (
            <p role="alert" className="text-body text-danger">
              {local.error}
            </p>
          ) : null}
        </div>
        {canInstall ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {download ? (
              <p id={downloadHint} className="text-caption text-muted-foreground">
                {t('download', download)}
              </p>
            ) : null}
            <Button
              variant="secondary"
              size="compact"
              disabled={busy}
              aria-describedby={download ? downloadHint : undefined}
              onClick={install}
            >
              {t('installAction')}
            </Button>
          </div>
        ) : local.install === 'downloading' || local.install === 'verifying' ? (
          <Button variant="tertiary" size="compact" disabled={busy} onClick={cancel}>
            {t('cancelInstall')}
          </Button>
        ) : canPrepare || canRemove ? (
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canPrepare ? (
              <>
                <p id={prepareHint} className="text-caption text-muted-foreground">
                  {t('prepareHint')}
                </p>
                <Button
                  variant="tertiary"
                  size="compact"
                  disabled={busy}
                  aria-describedby={prepareHint}
                  onClick={start}
                >
                  {local.runtime === 'error' ? t('prepareAgain') : t('prepare')}
                </Button>
              </>
            ) : null}
            {canRemove ? (
              <Button
                variant="tertiary"
                size="compact"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                {t('remove')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogPopup className="p-6" showCloseButton={false}>
          <DialogTitle>{t('removeTitle')}</DialogTitle>
          <DialogDescription className="my-4">
            {t('removeConfirm', {
              size: removal?.size ?? download?.size ?? '0',
              unit: removal?.unit ?? download?.unit ?? 'MB',
            })}
          </DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="tertiary" onClick={() => setConfirming(false)}>
              {t('removeDismiss')}
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                remove();
              }}
            >
              {t('remove')}
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
      <Labeled label={t('device')}>
        <Select<LocalDevice>
          label={t('device')}
          value={form.device}
          onValueChange={(device) => change({ device })}
          options={catalog.map((entry) => ({
            value: entry.kind,
            label: t(entry.kind),
            hint: entry.kind === 'cpu' ? undefined : t('notVerified'),
          }))}
          className="w-fit min-w-32"
        />
      </Labeled>
      {picked.kind !== 'cpu' ? (
        <p className="text-caption text-muted-foreground">
          {t('notVerified')}.{' '}
          {picked.kind === 'vulkan' ? t('vulkanRequirement') : t('cudaRequirement')}
        </p>
      ) : null}
      <details className="text-body">
        <summary>{t('advanced')}</summary>
        <div className="mt-2 flex flex-wrap gap-4">
          <NumberField
            label={t('timeout')}
            value={form.localTimeout}
            min={ROUTING_TIMEOUT_MIN_MS}
            max={ROUTING_TIMEOUT_MAX_MS}
            onChange={(localTimeout) => change({ localTimeout })}
          />
          <NumberField
            label={t('threads')}
            value={form.threads}
            min={1}
            max={LOCAL_ROUTING_MAX_THREADS}
            onChange={(threads) => change({ threads })}
          />
        </div>
      </details>
    </div>
  );
}

function ApiEngine({
  view,
  form,
  change,
}: {
  view: EffortRoutingView;
  form: Form;
  change(patch: Partial<Form>): void;
}) {
  const t = useTranslations('EffortRouting');
  const td = useTranslations('DecisionApis');
  const api = view.apis.find((entry) => entry.id === form.apiId && entry.keyConfigured);
  if (!view.apis.some((entry) => entry.keyConfigured))
    return (
      <div className="flex flex-col items-start gap-2 rounded-lg border border-line p-3 text-body">
        <p>{t('noApi')}</p>
        <Button variant="tertiary" size="compact" render={<a href="#models-decision-apis" />}>
          {t('connectApi')}
        </Button>
      </div>
    );
  const saved =
    view.settings.mode === 'manual' && view.settings.engine.kind === 'api'
      ? view.settings.engine
      : null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
      <Labeled label={t('api')}>
        <Select<ApiId>
          label={t('api')}
          value={api?.id ?? null}
          onValueChange={(apiId) => change({ apiId, consent: null })}
          options={view.apis.map((entry) => ({
            value: entry.id,
            label: td(`name.${entry.id}`),
            disabled: !entry.keyConfigured,
            ...(!entry.keyConfigured
              ? { hint: t('needsKey') }
              : !entry.verified
                ? { hint: t('unverified') }
                : {}),
          }))}
          className="w-fit min-w-48"
        />
      </Labeled>
      {api ? (
        <>
          {saved?.id === api.id && saved.consentRevision !== api.noticeRevision ? (
            <Banner role="note">
              <BannerTitle>{t('consentChanged')}</BannerTitle>
            </Banner>
          ) : null}
          <div className="flex flex-col gap-1 text-caption text-muted-foreground">
            <p>{t('sends')}</p>
            <p>{td(`data.${api.id}`)}</p>
          </div>
          <Checkbox
            label={t('consent')}
            checked={form.consent === api.noticeRevision}
            onToggle={() =>
              change({ consent: form.consent === api.noticeRevision ? null : api.noticeRevision })
            }
          />
          <details className="text-body">
            <summary>{t('advanced')}</summary>
            <div className="mt-2">
              <NumberField
                label={t('timeout')}
                value={form.apiTimeout}
                min={ROUTING_TIMEOUT_MIN_MS}
                max={ROUTING_TIMEOUT_MAX_MS}
                onChange={(apiTimeout) => change({ apiTimeout })}
              />
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}

function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 text-caption">
      <span aria-hidden="true" className="text-muted-foreground">
        {label}
      </span>
      {children}
    </div>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min: number;
  max: number;
  onChange(value: string): void;
}) {
  const t = useTranslations('EffortRouting');
  const error = useId();
  const invalid = whole(value, min, max) === null;
  return (
    <div className="flex flex-col gap-1">
      <label className="flex flex-col gap-1 text-caption">
        {label}
        <Input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          value={value}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? error : undefined}
          onChange={(event) => onChange(event.target.value)}
          className="w-32"
        />
      </label>
      {invalid ? (
        <p id={error} role="alert" className="text-caption text-danger">
          {t('range', { min, max })}
        </p>
      ) : null}
    </div>
  );
}
