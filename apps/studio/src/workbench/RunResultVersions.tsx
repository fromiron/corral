import { canReadArtifactBody } from '@corral/core';
import { type ResultItem, type RunSessionStore, runResults, useRunDisplay } from '@corral/react';
import {
  Button,
  SectionLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@corral/react/design-kit';
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';

/**
 * The Results view: every version the run made, with the execution that made it. A version
 * opens in the run's existing readers: final results in the result reader, the rest as the
 * artifact they are. A version whose text is no longer kept is listed but cannot be opened.
 */
export function RunResultVersions({
  session,
  onOpenResult,
  onOpenArtifact,
}: {
  session: RunSessionStore;
  onOpenResult: (artifactVersionId: string, origin: HTMLElement) => void;
  onOpenArtifact: (artifactVersionId: string, origin: HTMLElement) => void;
}) {
  const t = useTranslations('Results');
  const m = useTranslations('RunMonitor.resultVersions');
  const monitor = useTranslations('RunMonitor');
  const run = useTranslations('Run');
  const projection = useRunDisplay(session, (s) => s.projection);
  const current = useStore(session, (s) => s.projection);
  const definition = useStore(session, (s) => s.definition);
  const results = useMemo(() => (projection ? runResults(projection) : null), [projection]);
  if (!projection || !results) return null;
  const source = (item: ResultItem) => {
    const execution = projection.executions[item.authorExecutionId];
    if (!execution) return item.authorExecutionId;
    const round = execution.iterationId
      ? projection.iterations[execution.iterationId]?.no
      : undefined;
    return [
      definition?.nodes.find((node) => node.id === execution.nodeId)?.label ?? execution.nodeId,
      ...(round ? [run('round', { no: round })] : []),
      run('attempt', { no: execution.attemptNo }),
    ].join(' · ');
  };
  const sections = [
    { id: 'final', heading: t('final'), items: results.final, final: true },
    {
      id: 'other',
      heading: t(results.kind === 'partial' ? 'partial' : 'intermediate'),
      items: results.intermediate.flatMap((group) => group.versions),
      final: false,
    },
  ].filter((section) => section.items.length > 0);
  if (!sections.length)
    return (
      <p role="status" className="p-6 text-caption text-muted-foreground">
        {results.kind === 'pending' ? t('kind.pending') : t('kind.none')}
      </p>
    );
  // Rows are numbered across the groups so the table's one hover highlight follows them all.
  let row = 0;
  return (
    <div className="mx-auto w-full max-w-[1040px] px-6 py-5">
      <Table aria-label={monitor('results')} className="table-fixed">
        <colgroup>
          <col className="w-1/2" />
          <col className="w-1/3" />
          <col />
        </colgroup>
        <TableHeader>
          <TableRow>
            <TableHead>{m('name')}</TableHead>
            <TableHead>{m('source')}</TableHead>
            <TableHead className="text-right">{m('version')}</TableHead>
          </TableRow>
        </TableHeader>
        {sections.map((section) => (
          <TableBody key={section.id} aria-label={section.heading}>
            {/* Each kind of result is a labelled group of rows under the one header. */}
            <TableRow>
              <TableHead scope="rowgroup" colSpan={3} className="pt-4">
                <SectionLabel count={section.items.length}>{section.heading}</SectionLabel>
              </TableHead>
            </TableRow>
            {section.items.map((item) => {
              const readable = canReadArtifactBody(current, item.artifactVersionId);
              return (
                <TableRow
                  key={item.artifactVersionId}
                  index={row++}
                  data-result-version={item.artifactVersionId}
                  className={readable ? 'cursor-pointer' : undefined}
                  // The whole row opens a version; its name stays the keyboard's way in.
                  onClick={(event) => {
                    if (!readable || (event.target as Element).closest('button')) return;
                    event.currentTarget.querySelector('button')?.click();
                  }}
                >
                  <TableCell className="py-1">
                    {readable ? (
                      <Button
                        variant="ghost"
                        size="compact"
                        className="max-w-full justify-start text-foreground"
                        aria-label={t('itemName', { name: item.name, version: item.version })}
                        onClick={(event) =>
                          (section.final ? onOpenResult : onOpenArtifact)(
                            item.artifactVersionId,
                            event.currentTarget,
                          )
                        }
                      >
                        <span className="truncate">{item.name}</span>
                      </Button>
                    ) : (
                      <span className="flex min-w-0 flex-col px-2.5">
                        <span className="truncate text-foreground">{item.name}</span>
                        <span className="text-caption">{m('notKept')}</span>
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="truncate" title={source(item)}>
                    {source(item)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m('versionNumber', { version: item.version })}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        ))}
      </Table>
    </div>
  );
}
