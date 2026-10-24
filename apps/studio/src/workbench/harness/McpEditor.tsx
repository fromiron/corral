import type { HarnessApi } from '@corral/client';
import {
  McpServerDraft,
  type ProjectToolConfigRevision,
  type RegisteredMcpServer,
} from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Input,
  Select,
  Switch,
  Textarea,
} from '@corral/react/design-kit';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useSettingsCommand, useSettingsForm, useSettingsTask } from '../SettingsLifecycle.tsx';
import { operationId } from './Target.tsx';

export function mcpDraft(server: RegisteredMcpServer): McpServerDraft {
  const common = {
    name: server.name,
    enabled: server.enabled !== false,
    exposure: server.exposure,
    timeoutMs: server.timeoutMs,
  };
  return server.transport === 'stdio'
    ? {
        ...common,
        transport: 'stdio',
        argv: server.argv,
        ...(server.browser ? { browser: server.browser } : {}),
      }
    : {
        ...common,
        transport: 'http',
        url: server.url,
        auth:
          server.auth.kind === 'oauth'
            ? {
                kind: 'oauth',
                scope: server.auth.scope,
                ...(server.auth.clientId ? { clientId: server.auth.clientId } : {}),
              }
            : { kind: server.auth.kind },
      };
}
export function McpEditor({
  api,
  projectId,
  revision,
  server,
  onClose,
  onSaved,
}: {
  api: HarnessApi;
  projectId: string;
  revision: number;
  server?: RegisteredMcpServer;
  onClose(): void;
  onSaved(config: ProjectToolConfigRevision): void;
}) {
  const t = useTranslations('Resources'),
    h = useTranslations('Harness');
  const [name, setName] = useState(server?.name ?? ''),
    [transport, setTransport] = useState(server?.transport ?? 'http');
  const [command, setCommand] = useState(server?.transport === 'stdio' ? server.argv[0]! : ''),
    [args, setArgs] = useState(
      server?.transport === 'stdio' ? server.argv.slice(1).join('\n') : '',
    );
  const [url, setUrl] = useState(server?.transport === 'http' ? server.url : ''),
    [auth, setAuth] = useState(server?.transport === 'http' ? server.auth.kind : 'none');
  const [scope, setScope] = useState(
      server?.transport === 'http' && server.auth.kind === 'oauth' ? server.auth.scope : '',
    ),
    [clientId, setClientId] = useState(
      server?.transport === 'http' && server.auth.kind === 'oauth'
        ? (server.auth.clientId ?? '')
        : '',
    );
  const [exposure, setExposure] = useState(server?.exposure ?? 'direct'),
    [seconds, setSeconds] = useState(String((server?.timeoutMs ?? 30000) / 1000));
  const initialBrowser = server?.transport === 'stdio' ? server.browser : undefined;
  const [localBrowser, setLocalBrowser] = useState(Boolean(initialBrowser));
  const [browserOrigin, setBrowserOrigin] = useState(
    initialBrowser?.origin ?? 'http://127.0.0.1:3000',
  );
  const [browserExecutable, setBrowserExecutable] = useState(initialBrowser?.executablePath ?? '');
  const [readyText, setReadyText] = useState(initialBrowser?.readyText ?? '');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [dirty, setDirty] = useState(false);
  const retry = useSettingsCommand<{ json: string; id: string }>(
      `mcp-edit:${projectId}:${server?.id ?? 'new'}`,
    ),
    dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const runSettingsTask = useSettingsTask(`project-tools:${projectId}`);
  const confirmLeave = useSettingsForm({ dirty, pending: busy, save });
  const close = async () => {
    if (await confirmLeave()) onClose();
  };
  async function save() {
    const parsed = McpServerDraft.safeParse({
      name,
      transport,
      enabled: server ? server.enabled !== false : false,
      exposure: transport === 'stdio' && localBrowser ? 'direct' : exposure,
      timeoutMs: Number(seconds) * 1000,
      ...(transport === 'stdio'
        ? {
            argv: [command, ...args.split('\n').filter(Boolean)],
            ...(localBrowser
              ? {
                  browser: {
                    fixtureOnly: true,
                    backendVersion: '0.0.83',
                    origin: browserOrigin,
                    executablePath: browserExecutable,
                    readyText,
                  },
                }
              : {}),
          }
        : {
            url,
            auth:
              auth === 'oauth'
                ? { kind: auth, scope, ...(clientId ? { clientId } : {}) }
                : { kind: auth },
          }),
    });
    if (!parsed.success) {
      setError(h('invalidMcp'));
      return false;
    }
    const json = JSON.stringify(parsed.data);
    if (retry.current?.json !== json) retry.current = { json, id: operationId() };
    const commandId = retry.current.id;
    setBusy(true);
    setError('');
    try {
      const config = await runSettingsTask(() =>
        api.saveMcp(projectId, revision, commandId, parsed.data, server?.id),
      );
      setDirty(false);
      dirtyRef.current = false;
      onSaved(config);
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPopup className="max-w-2xl p-6" showCloseButton={false}>
        <DialogTitle>{t(server ? 'editMcp' : 'addMcp')}</DialogTitle>
        <DialogDescription>{t('authChanged')}</DialogDescription>
        <form
          onKeyDown={(event) => {
            if (event.key === 'Enter' && event.nativeEvent.isComposing) event.preventDefault();
          }}
          className="mt-4 flex max-h-[70vh] flex-col gap-4 overflow-y-auto"
          onChange={() => setDirty(true)}
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) void save();
          }}
        >
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <label className="flex flex-col gap-1 text-sm">
              {t('serverName')}
              <Input
                required
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <div className="flex flex-col gap-1 text-sm">
              {h('mcpTransport')}
              <Select
                className="h-9 w-full justify-between"
                label={h('mcpTransport')}
                value={transport}
                onValueChange={(value) => {
                  setTransport(value as typeof transport);
                  setDirty(true);
                }}
                options={[
                  { value: 'http', label: 'Streamable HTTP' },
                  { value: 'stdio', label: h('mcpStdio') },
                ]}
              />
            </div>
            {transport === 'stdio' ? (
              <>
                <Switch
                  label={t('browserFixture')}
                  checked={localBrowser}
                  onToggle={() => setLocalBrowser(!localBrowser)}
                />
                {localBrowser ? (
                  <>
                    <p className="text-xs text-muted-foreground">{t('browserFixtureHint')}</p>
                    <label className="flex flex-col gap-1 text-sm">
                      {t('browserOrigin')}
                      <Input
                        value={browserOrigin}
                        onChange={(event) => setBrowserOrigin(event.target.value)}
                        required
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      {t('browserExecutable')}
                      <Input
                        value={browserExecutable}
                        onChange={(event) => setBrowserExecutable(event.target.value)}
                        required
                      />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      {t('browserReady')}
                      <Input
                        value={readyText}
                        onChange={(event) => setReadyText(event.target.value)}
                        required
                      />
                    </label>
                  </>
                ) : null}
                <label className="flex flex-col gap-1 text-sm">
                  {t(localBrowser ? 'browserDevCommand' : 'command')}
                  <Input required value={command} onChange={(e) => setCommand(e.target.value)} />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  {t('arguments')}
                  <Textarea
                    className="font-mono"
                    rows={4}
                    value={args}
                    onChange={(e) => setArgs(e.target.value)}
                  />
                </label>
                <p className="text-xs text-muted-foreground">{t('argsHint')}</p>
              </>
            ) : (
              <>
                <label className="flex flex-col gap-1 text-sm">
                  {h('mcpUrl')}
                  <Input type="url" required value={url} onChange={(e) => setUrl(e.target.value)} />
                </label>
                <div className="flex flex-col gap-1 text-sm">
                  {h('mcpAuth')}
                  <Select
                    className="h-9 w-full justify-between"
                    label={h('mcpAuth')}
                    value={auth}
                    onValueChange={(value) => {
                      setAuth(value as typeof auth);
                      setDirty(true);
                    }}
                    options={[
                      { value: 'none', label: h('mcpAuthNone') },
                      { value: 'bearer', label: h('mcpAuthBearer') },
                      { value: 'oauth', label: 'OAuth' },
                    ]}
                  />
                </div>
                {auth === 'oauth' ? (
                  <>
                    <label className="flex flex-col gap-1 text-sm">
                      {h('mcpScope')}
                      <Input required value={scope} onChange={(e) => setScope(e.target.value)} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm">
                      {h('mcpClientId')}
                      <Input value={clientId} onChange={(e) => setClientId(e.target.value)} />
                    </label>
                  </>
                ) : null}
              </>
            )}
            <details>
              <summary className="cursor-pointer text-sm">{t('connectionOptions')}</summary>
              <div className="mt-3 flex flex-col gap-3">
                {server ? <p className="font-mono text-xs">{server.id}</p> : null}
                <div className="flex flex-col gap-1 text-sm">
                  {h('mcpExposure')}
                  <Select
                    className="h-9 w-full justify-between"
                    label={h('mcpExposure')}
                    value={exposure}
                    onValueChange={(value) => {
                      setExposure(value as typeof exposure);
                      setDirty(true);
                    }}
                    options={[
                      { value: 'direct', label: h('mcpDirect') },
                      { value: 'codemode', label: h('mcpCodemode') },
                    ]}
                  />
                </div>
                <label className="flex flex-col gap-1 text-sm">
                  {h('mcpTimeout')}
                  <Input
                    type="number"
                    required
                    min={1}
                    max={300}
                    value={seconds}
                    onChange={(e) => setSeconds(e.target.value)}
                  />
                </label>
              </div>
            </details>
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" type="button" onClick={close}>
                {t('cancel')}
              </Button>
              <Button type="submit">{busy ? h('busy') : t('save')}</Button>
            </div>
          </fieldset>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
