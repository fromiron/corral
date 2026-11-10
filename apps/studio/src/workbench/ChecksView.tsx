import type { VerificationResultView, WorkspaceBindingView } from '@corral/client';
import type { TextAttachment } from '@corral/contracts';
import { createTextAttachment } from '@corral/core';
import { Button, cn, fontWeights, Tooltip, useShape } from '@corral/react/design-kit';
import { Info, Settings } from '@corral/react/icons';
import { Link } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { fixRequestName, fixRequestText } from './checkFixRequest.ts';
import { commandLine } from './commandLine.ts';
import { type AttachmentCapture, beginAttachmentCapture } from './context/bridge.ts';
import { useSettingsNavigation } from './navigation.ts';

const failed = (result: VerificationResultView) =>
  result.state === 'failed' ||
  result.state === 'error' ||
  result.timedOut ||
  result.report?.verdict === 'fail';

/** Date and time in the interface language (the app sets `<html lang>`). */
function checkTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(globalThis.document?.documentElement.lang || undefined, {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

/**
 * The session's checks: the agreed commands to run, and each record with its command, result,
 * exit code, time, duration, whether it still holds for the current tree, and its output. A
 * failed check can draft a fix request into the composer; that only adds an attachment there.
 */
export function Checks({
  sessionId,
  projectId,
  binding,
  changed,
  onAttach,
  titled = true,
}: {
  sessionId: string;
  projectId?: string;
  binding: WorkspaceBindingView | null;
  changed: number;
  onAttach?(attachment: TextAttachment, capture: AttachmentCapture): void | Promise<void>;
  /** False where the host already names this view (the Checks sub-view's tab). */
  titled?: boolean;
}) {
  const t = useTranslations('Files');
  const tk = useTranslations('Checks');
  const tc = useTranslations('Context');
  const navigation = useSettingsNavigation();
  const shape = useShape();
  const { workspaces, mode, workspaceId } = useServices();
  const source = useMemo(
    () => ({ workspaces, workspaceId, projectId, sessionId }),
    [workspaces, workspaceId, projectId, sessionId],
  );
  const currentSource = useRef(source);
  currentSource.current = source;
  const mounted = useRef(false);
  const readRevision = useRef(0);
  const [loaded, setLoaded] = useState<{
    source: typeof source;
    results: VerificationResultView[];
  }>({ source, results: [] });
  const results = loaded.source === source ? loaded.results : [];
  const [error, setError] = useState<string | null>(null);
  const [attaching, setAttaching] = useState(false);
  const [attached, setAttached] = useState<string | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      readRevision.current += 1;
    };
  }, []);
  const isCurrent = () => mounted.current && currentSource.current === source;
  const checkAction = async (action: Promise<unknown>) => {
    setError(null);
    try {
      await action;
      if (isCurrent()) await reload();
    } catch (error) {
      if (isCurrent()) setError(error instanceof Error ? error.message : String(error));
    }
  };
  const reload = useCallback(async () => {
    if (!source.workspaces) return;
    const revision = ++readRevision.current;
    const value = await source.workspaces.verifications(source.sessionId).catch(() => []);
    if (mounted.current && currentSource.current === source && readRevision.current === revision)
      setLoaded({ source, results: value });
  }, [source]);
  useEffect(() => {
    void changed;
    void reload();
  }, [reload, changed]);
  const running = results.some((r) => r.state === 'running');
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 1000);
    return () => clearInterval(timer);
  }, [running, reload]);
  const commands = binding?.verifyCommands ?? [];
  // A finished record of this session; its report, when present, must be the same check.
  const settled = (result: VerificationResultView) =>
    Boolean(
      onAttach &&
        workspaceId &&
        projectId &&
        mode === 'server' &&
        result.state !== 'running' &&
        (!result.report ||
          (result.report.sessionId === sessionId &&
            result.report.verificationId === result.verificationId &&
            result.report.state !== 'queued' &&
            result.report.state !== 'running')),
    );
  const canAttach = (result: VerificationResultView) => settled(result) && Boolean(result.output);
  const canDraftFix = (result: VerificationResultView) => settled(result) && failed(result);
  const attach = async (result: VerificationResultView, as: 'output' | 'fix') => {
    if (!(as === 'fix' ? canDraftFix(result) : canAttach(result))) return;
    if (!workspaceId || !projectId || !onAttach || attaching) return;
    setAttaching(true);
    setAttached(null);
    setError(null);
    try {
      const capture = beginAttachmentCapture({ hostId: workspaceId, projectId, sessionId });
      const report = result.report;
      const provenance = {
        kind: 'check' as const,
        hostId: workspaceId,
        projectId,
        sessionId,
        verificationId: result.verificationId,
        commandId: result.commandId,
        tree: result.tree,
        ...(report
          ? {
              fingerprint: report.fingerprint,
              configRevision: report.configRevision,
              outputHash: report.output.hash,
              outputTruncated: report.output.truncated,
            }
          : {}),
      };
      // A fix request is written from the check rather than captured from it, so it carries no
      // source: the composer would otherwise call it changed and offer the raw output instead.
      const attachment =
        as === 'fix'
          ? createTextAttachment(
              fixRequestName(result.name),
              'text/markdown',
              fixRequestText(result),
            )
          : createTextAttachment('check-output.txt', 'text/plain', result.output, provenance);
      await onAttach(attachment, capture);
      if (isCurrent()) setAttached(result.verificationId);
    } catch {
      if (isCurrent()) setError(tc('attachFailed'));
    } finally {
      if (mounted.current) setAttaching(false);
    }
  };
  // Checks are registered with the project's folder, in its settings.
  const tools =
    mode === 'server' && projectId ? (
      <Link {...navigation.link('workspace', projectId)} />
    ) : undefined;
  return (
    <section
      {...(titled ? { 'aria-labelledby': 'checks-heading' } : { 'aria-label': tk('title') })}
      className="flex flex-col gap-3"
    >
      {titled ? (
        <h3
          id="checks-heading"
          className="text-body"
          style={{ fontVariationSettings: fontWeights.semibold }}
        >
          {t('checksHeading')}
        </h3>
      ) : null}
      {error ? (
        <p role="alert" className="text-caption text-destructive">
          {error}
        </p>
      ) : null}
      {commands.length === 0 && results.length === 0 ? (
        <div
          data-testid="checks-empty"
          className={cn(
            shape.container,
            'grid justify-items-center gap-3 border border-dashed border-border px-6 py-10 text-center',
          )}
        >
          <div className="grid justify-items-center gap-1">
            <b className="text-body" style={{ fontVariationSettings: fontWeights.semibold }}>
              {t('noChecks')}
            </b>
            {mode === 'browser' ? (
              <p className="m-0 max-w-sm text-caption text-muted-foreground">
                {t('checksServerOnly')}
              </p>
            ) : null}
          </div>
          {tools ? (
            <Button variant="secondary" size="compact" render={tools}>
              {tk('openProjectTools')}
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-1">
          {commands.map((command) => (
            <Button
              variant="tertiary"
              size="compact"
              key={command.id}
              type="button"
              disabled={running}
              onClick={() =>
                workspaces && void checkAction(workspaces.verify(sessionId, command.id))
              }
            >
              {t('runCheck', { name: command.name })}
            </Button>
          ))}
          <span className="ml-auto flex items-center gap-0.5">
            {mode !== 'browser' && commands.length ? (
              <Tooltip content={t('isolatedChecksNote')}>
                <Button variant="ghost" size="icon-compact" aria-label={t('isolatedChecksNote')}>
                  <Info aria-hidden />
                </Button>
              </Tooltip>
            ) : null}
            {tools ? (
              <Tooltip content={tk('openProjectTools')}>
                <Button
                  variant="ghost"
                  size="icon-compact"
                  aria-label={tk('openProjectTools')}
                  render={tools}
                >
                  <Settings aria-hidden />
                </Button>
              </Tooltip>
            ) : null}
          </span>
        </div>
      )}
      <ul className="flex flex-col gap-1">
        {results.map((r) => (
          <li
            key={r.verificationId}
            className="flex flex-col gap-1 rounded fill-group p-2 text-caption"
            data-testid="check-result"
          >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span style={{ fontVariationSettings: fontWeights.semibold }}>{r.name}</span>
              <span
                className={
                  r.state === 'passed'
                    ? 'text-success'
                    : r.state === 'running'
                      ? ''
                      : 'text-destructive'
                }
              >
                {r.report ? t(`checkReportState.${r.report.state}`) : t(`checkState.${r.state}`)}
              </span>
              {r.report ? <span>{t(`checkVerdict.${r.report.verdict}`)}</span> : null}
              {r.state === 'running' && r.report?.owner.kind === 'manual' ? (
                <Button
                  size="compact"
                  variant="tertiary"
                  onClick={() =>
                    workspaces &&
                    void checkAction(workspaces.cancelVerification(sessionId, r.verificationId))
                  }
                >
                  {t('cancelCheck')}
                </Button>
              ) : null}
              {r.endedAt ? (
                <span className="text-muted-foreground tabular-nums">
                  {t('checkMeta', { code: r.exitCode ?? '—', ms: r.durationMs ?? 0 })}
                </span>
              ) : null}
              <time dateTime={r.startedAt} className="text-muted-foreground tabular-nums">
                {checkTime(r.startedAt)}
              </time>
              {r.timedOut ? <span className="text-destructive">{t('timedOut')}</span> : null}
              {r.stale ? <span className="text-warning">{t('stale')}</span> : null}
              {r.configChanged && !r.stale ? (
                <span className="text-warning">{t('configChanged')}</span>
              ) : null}
              {r.endedAt && !r.stale && !r.configChanged ? (
                <span className="text-muted-foreground">{tk('current')}</span>
              ) : null}
              {onAttach && workspaceId && projectId ? (
                <span className="ml-auto flex flex-wrap gap-1">
                  {canDraftFix(r) ? (
                    <Button
                      size="compact"
                      variant="secondary"
                      disabled={attaching}
                      onClick={() => void attach(r, 'fix')}
                    >
                      {tk('draftFix')}
                    </Button>
                  ) : null}
                  <Button
                    size="compact"
                    variant="tertiary"
                    disabled={attaching || !canAttach(r)}
                    onClick={() => void attach(r, 'output')}
                  >
                    {t('attachCheckOutput')}
                  </Button>
                </span>
              ) : null}
              {attached === r.verificationId ? <span role="status">{tc('attached')}</span> : null}
            </div>
            <code className="break-all font-mono text-muted-foreground">{commandLine(r.argv)}</code>
            {r.report ? (
              <details className="text-muted-foreground">
                <summary>{t('checkEvidence')}</summary>
                <p>
                  {t('checkFingerprint', {
                    revision: r.report.configRevision,
                    hash: r.report.fingerprint.slice(0, 12),
                    tree: r.tree.slice(0, 12),
                  })}
                </p>
                <p>{t('checkRetention', { date: r.report.retainUntil })}</p>
                {!r.report.cleanupConfirmed && r.report.endedAt ? (
                  <p className="text-warning">{t('checkCleanupUnknown')}</p>
                ) : null}
                {r.report.targetUnchanged === false ? (
                  <p className="text-warning">{t('checkTargetChanged')}</p>
                ) : null}
              </details>
            ) : null}
            {r.output ? (
              <details>
                <summary className="cursor-pointer text-muted-foreground">{tk('output')}</summary>
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">
                  {r.output}
                </pre>
              </details>
            ) : null}
          </li>
        ))}
      </ul>
    </section>
  );
}
