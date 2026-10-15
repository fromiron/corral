import type { Diagnostic, PlanIssue } from '@corral/core';
import { useReactFlow } from '@xyflow/react';
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { compileDraft } from '../editor/model.ts';

type Located = Pick<Diagnostic, 'nodeId' | 'edgeId' | 'linkId'>;

export function ValidationPanel() {
  const t = useTranslations('Validation');
  const { editor } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const { diagnostics, runtimeLimits, definition } = useMemo(() => compileDraft(draft), [draft]);
  const { fitView } = useReactFlow();

  /** Nodes to bring into view for a diagnostic's location. */
  const nodesOf = (at: Located): string[] => {
    if (at.nodeId) return [at.nodeId];
    const edge = draft.definition.controlEdges.find((e) => e.id === at.edgeId);
    if (edge) return [edge.source, edge.target];
    const link = draft.definition.capabilityLinks.find((l) => l.id === at.linkId);
    return link ? [link.sourceNodeId, link.targetNodeId] : [];
  };
  const show = (at: Located) => {
    const ids = nodesOf(at);
    if (ids[0]) editor.getState().select(ids[0]);
    void fitView({ nodes: ids.map((id) => ({ id })), duration: 200, maxZoom: 1.2 });
  };
  const text = (d: Diagnostic | PlanIssue) =>
    'severity' in d && t.has(`codes.${d.code}`)
      ? t(`codes.${d.code}`, { message: d.message })
      : d.message;

  const errors = diagnostics.filter((d) => d.severity === 'error');
  return (
    <section aria-labelledby="validation-heading" className="flex flex-col gap-2">
      <h2 id="validation-heading" className="text-sm font-semibold">
        {t('heading')}
      </h2>
      {errors.length === 0 && runtimeLimits.length === 0 && definition ? (
        <p className="text-xs text-success">✓ {t('ok')}</p>
      ) : null}
      {errors.length > 0 ? (
        <ul className="flex flex-col gap-1" aria-label={t('heading')} data-testid="diagnostics">
          {errors.map((d) => (
            <Issue
              key={`${d.code}:${d.nodeId ?? d.edgeId ?? d.linkId ?? ''}:${d.message}`}
              text={text(d)}
              at={d}
              onShow={show}
            />
          ))}
        </ul>
      ) : null}
      {errors.length === 0 && runtimeLimits.length > 0 ? (
        <div className="flex flex-col gap-1" data-testid="runtime-limits">
          <h3 className="text-xs font-semibold">{t('runtimeHeading')}</h3>
          <p className="text-xs text-muted">{t('runtimeNote')}</p>
          <ul className="flex flex-col gap-1">
            {runtimeLimits.map((issue) => (
              <Issue
                key={`${issue.nodeId}:${issue.message}`}
                text={issue.message}
                at={issue}
                onShow={show}
              />
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function Issue({ text, at, onShow }: { text: string; at: Located; onShow: (at: Located) => void }) {
  const t = useTranslations('Validation');
  const located = Boolean(at.nodeId || at.edgeId || at.linkId);
  return (
    <li className="flex items-start justify-between gap-2 text-xs">
      <span>
        <span aria-hidden="true">! </span>
        {text}
      </span>
      {located ? (
        <button
          type="button"
          onClick={() => onShow(at)}
          className="rounded border border-line px-1.5 py-0.5"
        >
          {t('show')}
        </button>
      ) : null}
    </li>
  );
}
