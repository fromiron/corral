import type { HarnessApi } from '@corral/client';
import {
  type ProjectToolConfigRevision,
  RegisteredDebugAdapter,
  RegisteredDebugConfiguration,
} from '@corral/contracts';
import { Button, Select } from '@corral/react/ui';
import { useState } from 'react';
import { useTranslations } from 'use-intl';
import { useSettingsForm, useSettingsTask } from '../workbench/SettingsLifecycle.tsx';
import { projectToolValues } from './projectToolValues.ts';

const emptyAdapter = { id: '', name: '', argv: '', seconds: '30' };
const emptyConfiguration = {
  id: '',
  name: '',
  adapterId: '',
  runtime: 'node',
  request: 'launch',
  cwd: '.',
  program: '',
  args: '',
  executable: '',
  envRefs: '',
  outFiles: '',
  sourceMaps: true,
};
const lines = (value: string) =>
  value
    .split('\n')
    .map((item) => item.trim())
    .filter(Boolean);
type Props = {
  api: HarnessApi;
  projectId: string;
  config: ProjectToolConfigRevision | null;
  onChange(value: ProjectToolConfigRevision): void;
};

export function DebuggerSettings({ api, projectId, config, onChange }: Props) {
  const t = useTranslations('DebuggerSettings');
  const [adapter, setAdapter] = useState(emptyAdapter),
    [configuration, setConfiguration] = useState(emptyConfiguration);
  const [editingAdapter, setEditingAdapter] = useState<string | null>(null),
    [editingConfiguration, setEditingConfiguration] = useState<string | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const run = useSettingsTask(`debug-settings:${projectId}`);
  const adapterDirty = JSON.stringify(adapter) !== JSON.stringify(emptyAdapter);
  const configurationDirty = JSON.stringify(configuration) !== JSON.stringify(emptyConfiguration);
  useSettingsForm({ dirty: adapterDirty || configurationDirty, pending: busy, save: saveDraft });
  async function work(task: () => Promise<void>) {
    if (busy) return false;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await run(task);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('invalid'));
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function save(values: ReturnType<typeof projectToolValues>) {
    const result = await api.saveProjectTools(projectId, config?.revision ?? 0, values);
    onChange(result);
    setNotice(t('saved'));
  }
  async function saveDraft() {
    return work(async () => {
      const values = projectToolValues(config);
      if (adapterDirty) {
        const result = RegisteredDebugAdapter.safeParse({
          id: adapter.id.trim(),
          name: adapter.name,
          argv: lines(adapter.argv),
          timeoutMs: Number(adapter.seconds) * 1000,
        });
        if (
          !result.success ||
          (!editingAdapter && values.debugAdapters?.some((item) => item.id === result.data.id))
        )
          throw new Error(t('invalidAdapter'));
        values.debugAdapters = [
          ...(values.debugAdapters ?? []).filter((item) => item.id !== editingAdapter),
          result.data,
        ];
      }
      if (configurationDirty) {
        const input = {
          id: configuration.id.trim(),
          name: configuration.name,
          adapterId: configuration.adapterId || values.debugAdapters?.[0]?.id,
          cwd: configuration.cwd,
          runtime: configuration.runtime,
          request: configuration.request,
          sourceMaps: configuration.sourceMaps,
          ...(configuration.outFiles.trim() ? { outFiles: lines(configuration.outFiles) } : {}),
          ...(configuration.request === 'launch'
            ? {
                envRefs: configuration.envRefs.split(/[\s,]+/).filter(Boolean),
                ...(configuration.runtime === 'node'
                  ? {
                      program: configuration.program,
                      args: lines(configuration.args),
                      ...(configuration.executable.trim()
                        ? { runtimeExecutable: configuration.executable.trim() }
                        : {}),
                    }
                  : { executablePath: configuration.executable.trim() }),
              }
            : {}),
        };
        const result = RegisteredDebugConfiguration.safeParse(input);
        if (
          !result.success ||
          !values.debugAdapters?.some((item) => item.id === result.data.adapterId) ||
          (!editingConfiguration &&
            values.debugConfigurations?.some((item) => item.id === result.data.id))
        )
          throw new Error(t('invalidConfiguration'));
        values.debugConfigurations = [
          ...(values.debugConfigurations ?? []).filter((item) => item.id !== editingConfiguration),
          result.data,
        ];
      }
      await save(values);
      setAdapter(emptyAdapter);
      setConfiguration(emptyConfiguration);
      setEditingAdapter(null);
      setEditingConfiguration(null);
    });
  }
  const field = (
    label: string,
    value: string,
    change: (value: string) => void,
    disabled = false,
    multiline = false,
    group = 'configuration',
  ) => (
    <label
      className="flex min-w-0 flex-col gap-1 text-sm"
      htmlFor={`debug-settings-${projectId}-${group}-${label}`}
    >
      {t(label)}
      {multiline ? (
        <textarea
          id={`debug-settings-${projectId}-${group}-${label}`}
          className="settings-field"
          rows={3}
          value={value}
          onChange={(event) => change(event.target.value)}
          disabled={disabled}
        />
      ) : (
        <input
          id={`debug-settings-${projectId}-${group}-${label}`}
          className="settings-field"
          value={value}
          onChange={(event) => change(event.target.value)}
          disabled={disabled}
        />
      )}
    </label>
  );
  return (
    <section className="flex flex-col gap-3" aria-label={t('title')}>
      <h3 className="text-lg font-semibold">{t('title')}</h3>
      <p className="text-xs text-muted">{t('hint')}</p>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="text-xs text-muted">
          {notice}
        </p>
      ) : null}
      <details className="settings-surface" open={editingAdapter !== null || undefined}>
        <summary className="cursor-pointer font-medium">{t('adapters')}</summary>
        <div className="flex flex-col gap-3 pt-3">
          {(config?.debugAdapters ?? []).map((item) => (
            <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
              <span>{item.name}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  setEditingAdapter(item.id);
                  setAdapter({
                    id: item.id,
                    name: item.name,
                    argv: item.argv.join('\n'),
                    seconds: String(item.timeoutMs / 1000),
                  });
                }}
              >
                {t('edit')}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={
                  busy || config?.debugConfigurations?.some((value) => value.adapterId === item.id)
                }
                onClick={() =>
                  void work(() =>
                    save({
                      ...projectToolValues(config),
                      debugAdapters: config?.debugAdapters?.filter((value) => value.id !== item.id),
                    }),
                  )
                }
              >
                {t('remove')}
              </Button>
            </div>
          ))}
          <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3">
            <legend className="mb-2 text-sm font-medium">
              {t(editingAdapter ? 'editAdapter' : 'addAdapter')}
            </legend>
            {field(
              'id',
              adapter.id,
              (value) => setAdapter({ ...adapter, id: value }),
              editingAdapter !== null,
              false,
              'adapter',
            )}
            {field(
              'name',
              adapter.name,
              (value) => setAdapter({ ...adapter, name: value }),
              false,
              false,
              'adapter',
            )}
            {field(
              'argv',
              adapter.argv,
              (value) => setAdapter({ ...adapter, argv: value }),
              false,
              true,
              'adapter',
            )}
            <p className="text-xs text-muted">{t('argvHint')}</p>
            {field(
              'timeout',
              adapter.seconds,
              (value) => setAdapter({ ...adapter, seconds: value }),
              false,
              false,
              'adapter',
            )}
          </fieldset>
        </div>
      </details>
      <div className="flex flex-col gap-2">
        <h4 className="font-medium">{t('configurations')}</h4>
        {(config?.debugConfigurations ?? []).map((item) => (
          <div key={item.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              {item.name} · {item.runtime} · {t(item.request)}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => {
                setEditingConfiguration(item.id);
                setConfiguration({
                  id: item.id,
                  name: item.name,
                  adapterId: item.adapterId,
                  runtime: item.runtime,
                  request: item.request,
                  cwd: item.cwd,
                  program: 'program' in item ? item.program : '',
                  args: 'args' in item ? (item.args ?? []).join('\n') : '',
                  executable:
                    'executablePath' in item
                      ? item.executablePath
                      : 'runtimeExecutable' in item
                        ? (item.runtimeExecutable ?? '')
                        : '',
                  envRefs: 'envRefs' in item ? (item.envRefs ?? []).join('\n') : '',
                  outFiles: (item.outFiles ?? []).join('\n'),
                  sourceMaps: item.sourceMaps ?? true,
                });
              }}
            >
              {t('edit')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void work(() =>
                  save({
                    ...projectToolValues(config),
                    debugConfigurations: config?.debugConfigurations?.filter(
                      (value) => value.id !== item.id,
                    ),
                  }),
                )
              }
            >
              {t('remove')}
            </Button>
          </div>
        ))}
      </div>
      <details className="settings-surface" open={editingConfiguration !== null || undefined}>
        <summary className="cursor-pointer font-medium">
          {t(editingConfiguration ? 'editConfiguration' : 'addConfiguration')}
        </summary>
        <fieldset disabled={busy} className="flex min-w-0 flex-col gap-3 pt-3">
          {field(
            'id',
            configuration.id,
            (value) => setConfiguration({ ...configuration, id: value }),
            editingConfiguration !== null,
          )}
          {field('name', configuration.name, (value) =>
            setConfiguration({ ...configuration, name: value }),
          )}
          <Select
            label={t('adapter')}
            value={configuration.adapterId || config?.debugAdapters?.[0]?.id || ''}
            onValueChange={(value) => setConfiguration({ ...configuration, adapterId: value })}
            options={(config?.debugAdapters ?? []).map((item) => ({
              value: item.id,
              label: item.name,
            }))}
          />
          <div className="flex flex-wrap gap-3">
            <Select
              label={t('runtime')}
              value={configuration.runtime}
              onValueChange={(value) =>
                setConfiguration({ ...configuration, runtime: value, executable: '' })
              }
              options={[
                { value: 'node', label: 'Node / TypeScript' },
                { value: 'chromium', label: 'Chromium' },
              ]}
            />
            <Select
              label={t('request')}
              value={configuration.request}
              onValueChange={(value) => setConfiguration({ ...configuration, request: value })}
              options={[
                { value: 'launch', label: t('launch') },
                { value: 'attach', label: t('attach') },
              ]}
            />
          </div>
          {field('cwd', configuration.cwd, (value) =>
            setConfiguration({ ...configuration, cwd: value }),
          )}
          <p className="text-xs text-muted">{t('relativeHint')}</p>
          {configuration.request === 'launch' ? (
            <>
              {configuration.runtime === 'node' ? (
                <>
                  {field('program', configuration.program, (value) =>
                    setConfiguration({ ...configuration, program: value }),
                  )}
                  {field(
                    'args',
                    configuration.args,
                    (value) => setConfiguration({ ...configuration, args: value }),
                    false,
                    true,
                  )}
                </>
              ) : null}
              {field(
                configuration.runtime === 'chromium' ? 'browserExecutable' : 'nodeExecutable',
                configuration.executable,
                (value) => setConfiguration({ ...configuration, executable: value }),
              )}
              {field(
                'envRefs',
                configuration.envRefs,
                (value) => setConfiguration({ ...configuration, envRefs: value }),
                false,
                true,
              )}
              <p className="text-xs text-muted">{t('envHint')}</p>
            </>
          ) : (
            <p className="text-xs text-muted">{t('attachHint')}</p>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={configuration.sourceMaps}
              onChange={(event) =>
                setConfiguration({ ...configuration, sourceMaps: event.target.checked })
              }
            />
            {t('sourceMaps')}
          </label>
          {field(
            'outFiles',
            configuration.outFiles,
            (value) => setConfiguration({ ...configuration, outFiles: value }),
            false,
            true,
          )}
        </fieldset>
      </details>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={busy || (!adapterDirty && !configurationDirty)}
          onClick={() => void saveDraft()}
        >
          {t('save')}
        </Button>
        <Button
          variant="ghost"
          disabled={busy || (!adapterDirty && !configurationDirty)}
          onClick={() => {
            setAdapter(emptyAdapter);
            setConfiguration(emptyConfiguration);
            setEditingAdapter(null);
            setEditingConfiguration(null);
          }}
        >
          {t('cancel')}
        </Button>
      </div>
    </section>
  );
}
