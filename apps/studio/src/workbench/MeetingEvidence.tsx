import {
  TEXT_ATTACHMENT_MAX_COUNT,
  type TextAttachment,
  textAttachmentKey,
} from '@corral/contracts';
import { type ArtifactVersionView, type RunSummary, validTextAttachments } from '@corral/core';
import { Button } from '@corral/react/design-kit';
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useServices } from '../services.tsx';
import { captureMeetingResult } from './meetingEvidence.ts';
import { TextAttachmentPicker } from './TextAttachments.tsx';

/** Lists metadata only on request, then reads only the result version the person chooses. */
export function MeetingEvidencePicker(props: {
  projectId: string;
  value: TextAttachment[];
  onChange(value: TextAttachment[]): void;
  onLoading(loading: boolean): void;
  disabled: boolean;
}) {
  const services = useServices();
  const t = useTranslations('Meetings');
  const latest = useRef({ services, props });
  latest.current = { services, props };
  const epoch = useRef(0);
  const alive = useRef(true);
  const [runs, setRuns] = useState<RunSummary[] | null>(null);
  const [results, setResults] = useState<{
    runId: string;
    artifacts: ArtifactVersionView[];
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [fileLoading, setFileLoading] = useState(false);
  const [error, setError] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: moving to another source owner invalidates pending reads and choices.
  useEffect(() => {
    alive.current = true;
    epoch.current += 1;
    setRuns(null);
    setResults(null);
    setLoading(false);
    setFileLoading(false);
    setError(false);
    latest.current.props.onLoading(false);
    return () => {
      alive.current = false;
      epoch.current += 1;
    };
  }, [services, props.projectId]);
  const blocked =
    props.disabled || loading || fileLoading || props.value.length >= TEXT_ATTACHMENT_MAX_COUNT;
  async function read(action: (current: () => boolean) => Promise<void>) {
    if (blocked) return;
    const owner = ++epoch.current;
    const current = () =>
      alive.current &&
      epoch.current === owner &&
      latest.current.services === services &&
      latest.current.props.projectId === props.projectId;
    setLoading(true);
    setError(false);
    props.onLoading(true);
    try {
      await action(current);
    } catch {
      if (current()) setError(true);
    } finally {
      if (current()) {
        setLoading(false);
        latest.current.props.onLoading(false);
      }
    }
  }
  const list = () =>
    read(async (current) => {
      const [all, sessions] = await Promise.all([
        services.transport.listRuns(),
        services.repository.listSessions(props.projectId),
      ]);
      const sessionIds = new Set(sessions.map((session) => session.sessionId));
      if (!current()) return;
      setRuns(
        all.filter((run) =>
          run.sessionId ? sessionIds.has(run.sessionId) : run.projectId === props.projectId,
        ),
      );
      setResults(null);
    });
  const chooseRun = (runId: string) =>
    read(async (current) => {
      const { projection } = await services.transport.getSnapshot(runId);
      if (projection.runId !== runId) throw new Error('Run source changed.');
      if (current())
        setResults({
          runId,
          artifacts: Object.values(projection.artifacts).filter(
            (item) => item.submitted && !item.media,
          ),
        });
    });
  const chooseArtifact = (runId: string, artifact: ArtifactVersionView) =>
    read(async (current) => {
      const captured = await captureMeetingResult(services.transport, runId, artifact);
      if (!current() || latest.current.props.disabled) return;
      const next = [
        ...new Map(
          [...latest.current.props.value, captured].map((item) => [textAttachmentKey(item), item]),
        ).values(),
      ];
      if (!validTextAttachments(next)) throw new Error('Invalid evidence captures.');
      latest.current.props.onChange(next);
      setRuns(null);
      setResults(null);
    });
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <TextAttachmentPicker
        key={`${services.mode}:${services.workspaceId ?? ''}:${props.projectId}`}
        value={props.value}
        onChange={props.onChange}
        onLoading={(value) => {
          setFileLoading(value);
          props.onLoading(value);
        }}
        disabled={props.disabled || loading}
        enabled
      />
      <div>
        <Button
          type="button"
          size="compact"
          variant="ghost"
          disabled={blocked}
          onClick={() => void list()}
        >
          {t('evidenceResults')}
        </Button>
      </div>
      {runs ? (
        <fieldset className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          <legend>{t(results ? 'evidenceArtifacts' : 'evidenceRuns')}</legend>
          {results
            ? results.artifacts.map((artifact) => (
                <Button
                  key={artifact.artifactVersionId}
                  type="button"
                  size="compact"
                  variant="tertiary"
                  disabled={blocked}
                  onClick={() => void chooseArtifact(results.runId, artifact)}
                >
                  {artifact.name} v{artifact.version}
                </Button>
              ))
            : runs.map((run) => (
                <Button
                  key={run.runId}
                  type="button"
                  size="compact"
                  variant="tertiary"
                  disabled={blocked}
                  onClick={() => void chooseRun(run.runId)}
                >
                  {run.runId} · {run.startedAt}
                </Button>
              ))}
          {(results ? results.artifacts : runs).length === 0 ? <p>{t('evidenceEmpty')}</p> : null}
        </fieldset>
      ) : null}
      {loading ? <p role="status">{t('evidenceLoading')}</p> : null}
      {error ? (
        <p role="alert" className="text-danger">
          {t('evidenceFailed')}
        </p>
      ) : null}
      <p className="text-muted-foreground">{t('evidenceHint')}</p>
    </div>
  );
}
