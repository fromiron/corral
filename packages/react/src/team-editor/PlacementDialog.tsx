import type { ControlEdge, CorralDefinition } from '@corral/contracts';
import { useTranslations } from 'use-intl';
import {
  Button,
  KitDialog,
  KitDialogContent,
  KitDialogDescription,
  KitDialogFooter,
  KitDialogHeader,
  KitDialogTitle,
} from '../design-kit/index.ts';
import { fontWeights } from '../design-kit/lib/font-weight.ts';
import type { Placement } from './commands.ts';
import type { PlacementPrompt } from './placement-preview.ts';

export function PlacementDialog({
  prompt,
  cancel,
  choose,
  confirm,
  previewWrap,
  returnFocus,
}: {
  prompt: PlacementPrompt;
  cancel: () => void;
  choose: (at: Placement) => void;
  confirm: () => void;
  previewWrap: () => void;
  returnFocus: () => HTMLElement | true;
}) {
  const t = useTranslations('TeamEditor.placement');
  const port = useTranslations('Canvas.ports');
  const label = (definition: CorralDefinition, edge: ControlEdge) => {
    const source = definition.nodes.find((n) => n.id === edge.source);
    const target = definition.nodes.find((n) => n.id === edge.target);
    const sourcePort =
      source?.type === 'decision' && source.mode === 'router'
        ? source.routes.find((r) => r.id === edge.sourcePort)?.label
        : undefined;
    const portLabel = (id: string) => (port.has(id) ? port(id) : id);
    return `${source?.label ?? edge.source} · ${sourcePort ?? portLabel(edge.sourcePort)} → ${target?.label ?? edge.target} · ${portLabel(edge.targetPort)}`;
  };
  const list = (title: string, edges: ControlEdge[], definition: CorralDefinition) =>
    edges.length ? (
      <section>
        <h3 className="mb-1 text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
          {title}
        </h3>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          {edges.map((e) => (
            <li key={e.id}>{label(definition, e)}</li>
          ))}
        </ul>
      </section>
    ) : null;
  const base = prompt.base.definition;
  const incoming =
    prompt.kind === 'output' ? base.controlEdges.filter((e) => e.target === prompt.outputId) : [];
  return (
    <KitDialog
      open
      onOpenChange={(open) => {
        if (!open) cancel();
      }}
    >
      <KitDialogContent
        finalFocus={returnFocus}
        showCloseButton={false}
        className="max-h-[85dvh] overflow-y-auto"
      >
        <KitDialogHeader>
          <KitDialogTitle>
            {t(prompt.kind === 'output' ? 'chooseTitle' : 'previewTitle')}
          </KitDialogTitle>
          <KitDialogDescription>
            {prompt.kind === 'output'
              ? incoming.length
                ? t('chooseIncoming')
                : t('noIncoming')
              : prompt.wrapping
                ? t('wrapDescription')
                : prompt.location}
          </KitDialogDescription>
        </KitDialogHeader>
        {prompt.kind === 'output' ? (
          <div className="flex flex-col items-start gap-2">
            {incoming.length ? (
              <h3 className="text-subtitle" style={{ fontVariationSettings: fontWeights.semibold }}>
                {t('beforeOutput')}
              </h3>
            ) : null}
            {incoming.map((e) => (
              <Button
                key={e.id}
                variant="secondary"
                className="h-auto max-w-full whitespace-normal text-left"
                onClick={() => choose({ kind: 'edge', edgeId: e.id })}
              >
                {label(base, e)}
              </Button>
            ))}
            <Button variant="secondary" onClick={() => choose({ kind: 'empty' })}>
              {t('standalone')}
            </Button>
          </div>
        ) : (
          <div className="space-y-3 text-body">
            {list(t('removed'), prompt.diff.removed, base)}
            {list(t('added'), prompt.diff.added, prompt.result.draft.definition)}
            {list(t('boundary'), prompt.diff.boundary, prompt.result.draft.definition)}
            {prompt.diff.boundary.length ? <p>{t('boundaryDescription')}</p> : null}
            {prompt.diff.disconnects && !prompt.wrapping ? (
              <p>{t('disconnectDescription')}</p>
            ) : null}
            {prompt.wrap ? (
              <Button variant="secondary" onClick={previewWrap}>
                {t('wrap')}
              </Button>
            ) : null}
          </div>
        )}
        <KitDialogFooter>
          <Button variant="secondary" onClick={cancel}>
            {t('cancel')}
          </Button>
          {prompt.kind === 'preview' ? <Button onClick={confirm}>{t('apply')}</Button> : null}
        </KitDialogFooter>
      </KitDialogContent>
    </KitDialog>
  );
}
