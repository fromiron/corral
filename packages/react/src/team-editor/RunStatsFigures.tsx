import type { CorralNode } from '@corral/contracts';
import type { RunStats } from '@corral/core';
import { useFormatter, useTranslations } from 'use-intl';
import {
  Popover,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from '../design-kit/adapters/popover.tsx';
import { useSize } from '../design-kit/lib/size-context.tsx';
import { cn } from '../design-kit/lib/utils.ts';
import type { StatFigure } from './runStats.ts';

const chip =
  'inline-flex h-5 items-center rounded-full border border-border bg-background px-2 whitespace-nowrap text-muted-foreground';

/**
 * A step's run stats, pinned to its bottom edge. Each figure lists the runs behind it, and each
 * run opens its run page.
 */
export function RunStatsFigures({
  node,
  figures,
  stats,
  onOpenRun,
}: {
  node: CorralNode;
  figures: readonly StatFigure[];
  stats: RunStats;
  onOpenRun?: ((runId: string) => void) | undefined;
}) {
  const t = useTranslations('TeamEditor.stats');
  const status = useTranslations('Status');
  const portName = useTranslations('Canvas.ports');
  const format = useFormatter();
  const size = useSize();
  const portLabel = (port: string) =>
    node.type === 'decision' && node.mode === 'router'
      ? (node.routes.find((route) => route.id === port)?.label ?? port)
      : portName.has(port)
        ? portName(port)
        : port;
  const label = (figure: StatFigure) => {
    switch (figure.kind) {
      case 'rounds':
        return t('rounds', {
          average: format.number(figure.average, { maximumFractionDigits: 1 }),
        });
      case 'cap':
        return t('cap', { hit: figure.hit, of: figure.of });
      case 'branch':
        return t('branch', { port: portLabel(figure.port), count: figure.count });
      case 'tokens':
        return t('tokens', {
          share: format.number(figure.share, { style: 'percent', maximumFractionDigits: 0 }),
        });
      case 'failures':
        return t('failures', { count: figure.count });
      case 'retries':
        return t('retries', { count: figure.count });
      case 'idle':
        return t('idle');
    }
  };
  const value = (figure: StatFigure, counted: number) => {
    switch (figure.kind) {
      case 'rounds':
      case 'cap':
        return t('runRounds', { count: counted });
      case 'branch':
        return t('runSelected', { count: counted });
      case 'tokens':
        return t('runTokens', { count: counted });
      case 'failures':
        return t('runFailures', { count: counted });
      case 'retries':
        return t('runRetries', { count: counted });
      case 'idle':
        return '';
    }
  };
  const runOf = new Map(stats.runs.map((run) => [run.runId, run]));
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the canvas's own pointer and key handling (select, pan, Delete) away from the figures and their run lists.
    <div
      data-stats={node.id}
      className={cn(size.type.micro, 'flex items-center gap-1')}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {figures.map((figure) =>
        figure.kind === 'idle' ? (
          <span key="idle" className={chip}>
            {label(figure)}
          </span>
        ) : (
          <Popover key={figure.kind === 'branch' ? `branch:${figure.port}` : figure.kind}>
            <PopoverTrigger className={cn(chip, 'cursor-pointer text-foreground hover:bg-accent')}>
              {label(figure)}
            </PopoverTrigger>
            <PopoverPopup width="sm" padding="compact" side="bottom" align="start">
              <PopoverTitle className={cn(size.type.caption, 'px-2 pt-1 pb-2')}>
                {node.label} · {label(figure)}
              </PopoverTitle>
              <ul className="grid gap-0.5">
                {figure.runs.map((counted) => {
                  const run = runOf.get(counted.runId);
                  return (
                    <li key={counted.runId}>
                      <button
                        type="button"
                        className={cn(
                          size.type.caption,
                          'grid w-full grid-cols-[1fr_auto] gap-x-3 rounded-md px-2 py-1.5 text-left hover:bg-accent',
                        )}
                        onClick={() => onOpenRun?.(counted.runId)}
                      >
                        <span className="text-foreground">
                          {run
                            ? format.dateTime(new Date(run.startedAt), {
                                dateStyle: 'medium',
                                timeStyle: 'short',
                              })
                            : counted.runId}
                        </span>
                        <span className="text-muted-foreground">
                          {value(figure, counted.value)}
                        </span>
                        <span className="text-muted-foreground">
                          {run ? status(run.status) : null}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </PopoverPopup>
          </Popover>
        ),
      )}
    </div>
  );
}
