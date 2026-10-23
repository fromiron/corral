import type { WorkspacePreview, WorkspacesApi } from '@corral/client';
import {
  canonicalJson,
  type DebugCommand,
  type DebugInspect,
  type DebugQueryResult,
  type UserTaskView,
  type WorkspaceTarget,
} from '@corral/contracts';
import {
  Button,
  Dialog,
  DialogDescription,
  DialogPopup,
  DialogTitle,
  Input,
  Select,
} from '@corral/react/design-kit';
import { Link } from '@tanstack/react-router';
import { useContext, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { SourceNavigationContext } from '../context/SourceAttachments.tsx';
import { useSettingsNavigation } from '../navigation.ts';
import type { DebugCopy, DebugStore } from './store.ts';

type Frame = NonNullable<DebugQueryResult['frames']>[number];
type Scope = NonNullable<DebugQueryResult['scopes']>[number];
type Variable = NonNullable<DebugQueryResult['variables']>[number];
interface Props {
  api: Pick<WorkspacesApi, 'tasks' | 'previews'>;
  target: WorkspaceTarget;
  copy: DebugCopy | undefined;
  store: DebugStore;
}
export function DebugControls({ api, target, copy, store }: Props) {
  const t = useTranslations('Debugger');
  const settings = useSettingsNavigation();
  const navigation = useContext(SourceNavigationContext);
  const state = copy?.state,
    session = state?.session;
  const [selected, setSelected] = useState(''),
    [taskId, setTaskId] = useState(''),
    [leaseId, setLeaseId] = useState(''),
    [port, setPort] = useState('9229');
  const [tasks, setTasks] = useState<UserTaskView[]>([]),
    [leases, setLeases] = useState<WorkspacePreview[]>([]),
    [targetRevision, setTargetRevision] = useState(0);
  const [review, setReview] = useState(false),
    [error, setError] = useState(''),
    [expression, setExpression] = useState('');
  const [stack, setStack] = useState<{ key: string; result: DebugQueryResult } | null>(null);
  const [frame, setFrame] = useState<{ key: string; value: Frame } | null>(null);
  const [scopes, setScopes] = useState<{ key: string; frameId: string; values: Scope[] } | null>(
    null,
  );
  const [variables, setVariables] = useState<{
    key: string;
    frameId: string;
    values: Variable[];
    name: string;
  } | null>(null);
  const [reading, setReading] = useState(false);
  const [ending, setEnding] = useState(false);
  const choices = state?.configurations ?? [];
  const configuration = choices.find((value) => value.id === selected) ?? choices[0];
  const scope = canonicalJson(target);
  const pauseKey = canonicalJson([
    scope,
    session?.generation ?? null,
    session?.revision ?? null,
    session?.pauseId ?? null,
    session?.state ?? null,
  ]);
  const current = useRef(pauseKey);
  current.current = pauseKey;
  const queryEpoch = useRef(0);
  useEffect(
    () => () => {
      ++queryEpoch.current;
      current.current = '';
    },
    [],
  );
  const paused = session?.state === 'paused';
  const currentFrame = frame?.key === pauseKey ? frame.value : null;
  const live = session && !['stopped', 'failed'].includes(session.state);
  const busy = Boolean(copy?.busy || copy?.pendingCommandId);
  const request: Pick<DebugInspect, 'attach' | 'preview'> =
    configuration?.request === 'attach'
      ? { attach: { operationId: taskId || tasks[0]?.operationId || '', port: Number(port) } }
      : configuration?.runtime === 'chromium'
        ? { preview: { leaseId: leaseId || leases[0]?.leaseId || '' } }
        : {};
  const inspectKey = canonicalJson({ target, configId: configuration?.id ?? null, ...request });
  const inspected =
    copy?.inspection && canonicalJson(copy.inspectionInput) === inspectKey ? copy.inspection : null;
  const needsTask = configuration?.request === 'attach';
  const needsPreview = configuration?.runtime === 'chromium' && configuration.request === 'launch';
  const targetsFailure = t('targetsFailed');
  const hasTarget =
    (!needsTask ||
      Boolean(
        request.attach?.operationId &&
          Number.isInteger(Number(port)) &&
          Number(port) >= 1024 &&
          Number(port) <= 65535,
      )) &&
    (!needsPreview || Boolean(request.preview?.leaseId));
  useEffect(() => {
    void targetRevision;
    let active = true;
    setTasks([]);
    setLeases([]);
    if (needsTask)
      void api.tasks(target.sessionId).then(
        (result) => {
          if (active) setTasks(result.tasks.filter((value) => value.state === 'running'));
        },
        () => {
          if (active) setError(targetsFailure);
        },
      );
    if (needsPreview)
      void api.previews(target.sessionId).then(
        (result) => {
          if (active)
            setLeases(
              result.filter(
                (value) =>
                  value.sessionId === target.sessionId &&
                  value.state === 'ready' &&
                  value.kind === 'service',
              ),
            );
        },
        () => {
          if (active) setError(targetsFailure);
        },
      );
    return () => {
      active = false;
    };
  }, [api, target.sessionId, needsTask, needsPreview, targetRevision, targetsFailure]);
  // A resumed thread invalidates frame and variable references, even inside the same session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pauseKey captures target and the complete stopped revision.
  useEffect(() => {
    if (!paused || !session) return;
    const key = pauseKey,
      epoch = ++queryEpoch.current;
    setReading(true);
    setError('');
    void (async () => {
      let threadId = session.pausedThreadId;
      if (!threadId) {
        const result = await store.query(target, {
          generation: session.generation,
          pauseId: session.pauseId,
          kind: 'threads',
        });
        if (current.current !== key || epoch !== queryEpoch.current) return;
        threadId = result?.threads?.[0]?.id ?? null;
      }
      if (!threadId) return;
      const result = await store.query(target, {
        generation: session.generation,
        pauseId: session.pauseId,
        kind: 'stack',
        threadId,
      });
      if (result && current.current === key && epoch === queryEpoch.current)
        setStack({ key, result });
    })()
      .catch(() => {
        if (current.current === key) setError(t('queryFailed'));
      })
      .finally(() => {
        if (current.current === key && epoch === queryEpoch.current) setReading(false);
      });
    return () => {
      ++queryEpoch.current;
    };
  }, [pauseKey, store]);
  const command = async (kind: DebugCommand['kind'], extra: Partial<DebugCommand> = {}) => {
    const cleanup = kind === 'stop' || kind === 'disconnect';
    if (!session || ending || (busy && !cleanup)) return;
    if (cleanup) setEnding(true);
    try {
      await store.command(target, {
        generation: session.generation,
        revision: session.revision,
        pauseId: session.pauseId,
        kind,
        ...(session.pausedThreadId ? { threadId: session.pausedThreadId } : {}),
        ...extra,
      });
    } finally {
      if (cleanup) setEnding(false);
    }
  };
  const chooseFrame = async (value: Frame) => {
    if (!paused || !session || stack?.key !== pauseKey) return;
    const key = pauseKey,
      epoch = ++queryEpoch.current;
    setFrame({ key, value });
    setScopes(null);
    setVariables(null);
    setError('');
    setReading(true);
    try {
      if (value.source.mapped && navigation)
        await store.openFrame(
          target,
          value,
          { generation: session.generation, pauseId: session.pauseId, revision: session.revision },
          navigation.openDocument,
        );
      if (current.current !== key || epoch !== queryEpoch.current) return;
      const result = await store.query(target, {
        generation: session.generation,
        pauseId: session.pauseId,
        kind: 'scopes',
        frameId: value.id,
      });
      if (result && current.current === key && epoch === queryEpoch.current)
        setScopes({ key, frameId: value.id, values: result.scopes ?? [] });
    } catch {
      if (current.current === key) setError(t('queryFailed'));
    } finally {
      if (current.current === key && epoch === queryEpoch.current) setReading(false);
    }
  };
  const readVariables = async (reference: string, name: string) => {
    if (!paused || !session || frame?.key !== pauseKey) return;
    const key = pauseKey,
      epoch = ++queryEpoch.current,
      frameId = frame.value.id;
    setReading(true);
    setError('');
    try {
      const result = await store.query(target, {
        generation: session.generation,
        pauseId: session.pauseId,
        kind: 'variables',
        variablesReference: reference,
      });
      if (result && current.current === key && epoch === queryEpoch.current)
        setVariables({ key, frameId, values: result.variables ?? [], name });
    } catch {
      if (current.current === key) setError(t('queryFailed'));
    } finally {
      if (current.current === key && epoch === queryEpoch.current) setReading(false);
    }
  };
  const reviewStart = async () => {
    if (!configuration || !hasTarget || busy) return;
    setError('');
    await store.inspect(target, configuration.id, request);
    setReview(true);
  };
  const result = copy?.commandResult;
  const visibleResult =
    result?.session.generation === session?.generation &&
    result?.session.pauseId === session?.pauseId
      ? result
      : null;
  return (
    <section className="flex min-w-0 flex-col gap-3" aria-label={t('title')}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">{t('title')}</h2>
        <Button
          size="compact"
          variant="ghost"
          disabled={copy?.busy}
          onClick={() => {
            setTargetRevision((value) => value + 1);
            void store.refresh(target);
          }}
        >
          {t('refresh')}
        </Button>
      </div>
      {!state ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('loading')}
        </p>
      ) : !state.available ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t(state.unavailableReason === 'platform' ? 'platform' : 'untrusted')}
        </p>
      ) : null}
      {session ? (
        <p role="status" className="text-xs">
          {choices.find((value) => value.id === session.configId)?.name ?? session.configId} ·{' '}
          {t(`state.${session.state}`)}
        </p>
      ) : null}
      {!live && state?.available ? (
        <>
          {choices.length ? (
            <>
              <Select
                label={t('configuration')}
                value={configuration?.id ?? ''}
                onValueChange={(value) => {
                  setSelected(value);
                  setReview(false);
                }}
                options={choices.map((value) => ({ value: value.id, label: value.name }))}
                disabled={busy}
              />
              {needsTask ? (
                <div className="flex flex-wrap items-end gap-2">
                  <Select
                    label={t('task')}
                    value={request.attach?.operationId ?? ''}
                    options={tasks.map((value) => ({
                      value: value.operationId,
                      label: value.script,
                    }))}
                    onValueChange={setTaskId}
                    disabled={busy}
                  />
                  <label
                    className="flex flex-col gap-1 text-xs"
                    htmlFor={`debug-port-${target.sessionId}`}
                  >
                    {t('port')}
                    <Input
                      id={`debug-port-${target.sessionId}`}
                      type="number"
                      min={1024}
                      max={65535}
                      value={port}
                      onChange={(event) => setPort(event.target.value)}
                      disabled={busy}
                    />
                  </label>
                </div>
              ) : null}
              {needsPreview ? (
                <Select
                  label={t('preview')}
                  value={request.preview?.leaseId ?? ''}
                  options={leases.map((value) => ({ value: value.leaseId, label: value.path }))}
                  onValueChange={setLeaseId}
                  disabled={busy}
                />
              ) : null}
              {!hasTarget ? (
                <p className="text-xs text-muted-foreground">
                  {t(needsTask ? 'needTask' : 'needPreview')}
                </p>
              ) : null}
              <Button
                size="compact"
                variant="tertiary"
                className="self-start"
                disabled={busy || !hasTarget}
                onClick={() => void reviewStart()}
              >
                {t('review')}
              </Button>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">{t('noConfigurations')}</p>
          )}
          <Link
            {...settings.link('workspace', target.projectId)}
            className="self-start text-xs text-primary underline"
          >
            {t('settings')}
          </Link>
        </>
      ) : null}
      {live ? (
        <>
          <div className="flex flex-wrap gap-2">
            {session.state === 'running' ? (
              <Button size="compact" disabled={busy} onClick={() => void command('pause')}>
                {t('pause')}
              </Button>
            ) : null}
            {paused
              ? (['continue', 'next', 'stepIn', 'stepOut'] as const).map((kind) => (
                  <Button
                    key={kind}
                    size="compact"
                    variant={kind === 'continue' ? 'default' : 'outline'}
                    disabled={busy}
                    onClick={() => void command(kind)}
                  >
                    {t(kind)}
                  </Button>
                ))
              : null}
            {session.canDisconnect ? (
              <Button
                size="compact"
                variant="tertiary"
                disabled={ending}
                onClick={() => void command('disconnect')}
              >
                {t('disconnect')}
              </Button>
            ) : null}
            {session.canStop ? (
              <Button
                size="compact"
                variant="tertiary"
                disabled={ending}
                onClick={() => void command('stop')}
              >
                {t('stop')}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(session.ownership === 'attached' ? 'disconnectHint' : 'stopHint')}
          </p>
        </>
      ) : null}
      {copy?.pendingCommandId ? (
        <div role="status" className="flex flex-wrap items-center gap-2 text-xs text-warning">
          <span>{t('pending')}</span>
          <Button
            size="compact"
            variant="tertiary"
            disabled={copy.busy}
            onClick={() => void store.checkCommand(target)}
          >
            {t('check')}
          </Button>
        </div>
      ) : null}
      {paused ? (
        <>
          <section className="flex flex-col gap-1" aria-label={t('stackFrames')}>
            <h3 className="text-xs font-semibold">{t('stackFrames')}</h3>
            {reading ? (
              <p role="status" className="text-xs text-muted-foreground">
                {t('reading')}
              </p>
            ) : null}
            <ul className="max-h-52 overflow-y-auto">
              {(stack?.key === pauseKey ? stack.result.frames : [])?.map((value) => (
                <li key={value.id}>
                  <button
                    type="button"
                    aria-pressed={frame?.key === pauseKey && frame.value.id === value.id}
                    className="flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left text-xs hover:bg-subtle"
                    onClick={() => void chooseFrame(value)}
                  >
                    <span className="break-words font-medium">{value.name}</span>
                    <span className="break-all font-mono text-muted-foreground">
                      {value.source.path ?? value.source.name}:{value.source.line}:
                      {value.source.column}
                    </span>
                    {!value.source.mapped ? (
                      <span className="text-muted-foreground">{t('unmapped')}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
          {scopes?.key === pauseKey ? (
            <section className="flex flex-col gap-2" aria-label={t('variables')}>
              <h3 className="text-xs font-semibold">{t('variables')}</h3>
              <div className="flex flex-wrap gap-1">
                {scopes.values.map((value) => (
                  <Button
                    key={value.variablesReference}
                    size="compact"
                    variant="tertiary"
                    disabled={reading}
                    onClick={() => void readVariables(value.variablesReference, value.name)}
                  >
                    {value.name}
                    {value.expensive ? ` · ${t('onDemand')}` : ''}
                  </Button>
                ))}
              </div>
              {variables?.key === pauseKey && variables.frameId === scopes.frameId ? (
                <>
                  <p className="text-xs text-muted-foreground">{variables.name}</p>
                  <ul className="max-h-56 overflow-y-auto text-xs">
                    {variables.values.map((value) => (
                      <li
                        key={`${value.name}:${value.variablesReference ?? ''}`}
                        className="flex flex-col gap-1 py-1"
                      >
                        <span className="break-all font-mono">
                          {value.name}: {value.value}
                        </span>
                        {value.variablesReference ? (
                          <Button
                            size="compact"
                            variant="ghost"
                            className="self-start"
                            disabled={reading}
                            onClick={() =>
                              void readVariables(value.variablesReference as string, value.name)
                            }
                          >
                            {t('expand')}
                          </Button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
      {session ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (paused && currentFrame && expression.trim())
              void command('evaluate', {
                expression,
                frameId: currentFrame.id,
              });
          }}
        >
          <label className="text-xs font-semibold" htmlFor={`debug-expression-${target.sessionId}`}>
            {t('console')}
          </label>
          <p className="text-xs text-muted-foreground">{t('evaluateHint')}</p>
          {paused && !currentFrame ? (
            <p className="text-xs text-muted-foreground">{t('selectFrame')}</p>
          ) : null}
          <div className="flex items-center gap-2">
            <Input
              id={`debug-expression-${target.sessionId}`}
              aria-label={t('expression')}
              value={expression}
              maxLength={4000}
              onChange={(event) => setExpression(event.target.value)}
              disabled={!paused || busy}
              className="min-w-0 flex-1"
            />
            <Button type="submit" disabled={!paused || !currentFrame || busy || !expression.trim()}>
              {t('evaluate')}
            </Button>
          </div>
          {visibleResult?.value !== undefined ? (
            <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded fill-group p-2 text-xs">
              {visibleResult.value}
            </pre>
          ) : null}
        </form>
      ) : null}
      {session?.breakpoints.length ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">{t('breakpoints')}</summary>
          <ul className="mt-2 space-y-1">
            {session.breakpoints.map((point) => (
              <li key={`${point.path}:${point.requestedLine}`} className="break-all font-mono">
                {point.path}:{point.requestedLine} ·{' '}
                {point.verified ? t('verified') : t('unverified')}
                {point.line !== point.requestedLine ? ` → ${point.line}` : ''}
                {point.message ? ` · ${point.message}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {session?.output ? (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium">{t('output')}</summary>
          <pre className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded fill-group p-2">
            {session.output}
          </pre>
        </details>
      ) : null}
      {error || copy?.error || session?.error ? (
        <p role="alert" className="text-xs text-danger">
          {error || copy?.error || session?.error}
        </p>
      ) : null}
      <Dialog open={review && Boolean(inspected)} onOpenChange={setReview}>
        <DialogPopup
          showCloseButton={false}
          className="flex max-h-[85dvh] max-w-xl flex-col gap-3 overflow-y-auto p-5"
        >
          <DialogTitle>{t('reviewTitle')}</DialogTitle>
          <DialogDescription>{t('reviewHint')}</DialogDescription>
          {inspected ? (
            <>
              <p className="text-sm font-medium">
                {inspected.configuration.name} · {inspected.configuration.runtime}
              </p>
              <p className="text-xs">
                {t('adapter')}: {inspected.adapter.name}
              </p>
              <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-all rounded fill-group p-2 text-xs">
                {JSON.stringify(inspected.adapter.argv)}
              </pre>
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-xs">
                <dt>{t('cwd')}</dt>
                <dd className="break-all font-mono">{inspected.configuration.cwd}</dd>
                {'program' in inspected.configuration ? (
                  <>
                    <dt>{t('program')}</dt>
                    <dd className="break-all font-mono">
                      {inspected.configuration.program}{' '}
                      {JSON.stringify(inspected.configuration.args ?? [])}
                    </dd>
                  </>
                ) : null}
                {'executablePath' in inspected.configuration ? (
                  <>
                    <dt>{t('browser')}</dt>
                    <dd className="break-all font-mono">
                      {inspected.configuration.executablePath}
                    </dd>
                  </>
                ) : null}
                {'envRefs' in inspected.configuration ? (
                  <>
                    <dt>{t('environment')}</dt>
                    <dd className="break-all font-mono">
                      {(inspected.configuration.envRefs ?? []).join(', ') || '—'}
                    </dd>
                  </>
                ) : null}
                {request.attach ? (
                  <>
                    <dt>{t('task')}</dt>
                    <dd>
                      {
                        tasks.find((value) => value.operationId === request.attach?.operationId)
                          ?.script
                      }{' '}
                      · {request.attach.port}
                    </dd>
                  </>
                ) : null}
                {request.preview ? (
                  <>
                    <dt>{t('preview')}</dt>
                    <dd className="break-all">
                      {leases.find((value) => value.leaseId === request.preview?.leaseId)?.path}
                    </dd>
                  </>
                ) : null}
              </dl>
              <details className="text-xs">
                <summary className="cursor-pointer">{t('reviewBasis')}</summary>
                <p className="mt-1 break-all font-mono">{inspected.fingerprint}</p>
                <pre className="mt-1 whitespace-pre-wrap break-all">
                  {JSON.stringify({
                    sourceMaps: inspected.configuration.sourceMaps,
                    outFiles: inspected.configuration.outFiles,
                  })}
                </pre>
              </details>
              {!inspected.trusted ? <p className="text-xs text-warning">{t('trustHint')}</p> : null}
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                <Button
                  size="compact"
                  variant="ghost"
                  disabled={copy?.busy}
                  onClick={() => setReview(false)}
                >
                  {t('cancel')}
                </Button>
                <Button
                  size="compact"
                  disabled={busy}
                  onClick={() =>
                    void store.start(target, !inspected.trusted).then(() => setReview(false))
                  }
                >
                  {t(inspected.trusted ? 'start' : 'trustStart')}
                </Button>
              </div>
            </>
          ) : null}
        </DialogPopup>
      </Dialog>
    </section>
  );
}
