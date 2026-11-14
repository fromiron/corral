import { canReadArtifactBody } from '@corral/core';
import { type ResultItem, type RunSessionStore, runResults, useRunDisplay } from '@corral/react';
import {
  Button,
  EmptyState,
  SectionLabel,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useSize,
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
  // A name is a row button's label; one that cannot be opened is set the same way.
  const size = useSize();
  const label = size.type;
  const inset = size.variant === 'compact' ? '-ml-3' : '-ml-4';
  if (!projection || !results) return null;
  const source = (item: ResultItem) => {
    const execution = projection.executions[item.authorExecutionId];
    if (!execution) return item.authorExecutionId;
    const round = execution.iterationId
      ? projection.iterations[execution.iterationId]?.no
      : undefined;
    return [
      definition?.nodes.find((node) => node.id === execution.nodeId)?.label ?? execution.nodeId,
      // Parallel runs of one agent make same-named versions in the same attempt; the run's
      // execution number tells them apart, and the row starts as the result reader names the
      // author.
      ...(item.authorExecutionNumber
        ? [t('authorExecution', { number: item.authorExecutionNumber })]
        : []),
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
  // No results yet, or none at all once the run ended: the state as a title. The run header
  // already says the run is still working, so no sentence promises results later.
  if (!sections.length)
    return (
      <div role="status" className="mx-auto w-full max-w-[1040px] px-6 py-5">
        <EmptyState title={t(results.kind === 'pending' ? 'kind.pending' : 'kind.none')} />
      </div>
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
                  {/* Every name starts where the column's header does: the button's own inset
                      is taken back, and a name that cannot be opened has none. */}
                  <TableCell className="py-1">
                    {readable ? (
                      <Button
                        variant="ghost"
                        className={`${inset} max-w-full justify-start text-foreground`}
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
                      <span className="flex min-w-0 flex-col">
                        <span className={`truncate text-foreground ${label.body}`}>
                          {item.name}
                        </span>
                        <span className={label.caption}>{m('notKept')}</span>
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
