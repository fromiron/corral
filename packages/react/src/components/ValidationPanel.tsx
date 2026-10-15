import { useReactFlow } from '@xyflow/react';
import { useMemo } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { compileDraft } from '../editor/model.ts';

export function ValidationPanel() {
  const t = useTranslations('Validation');
  const { editor } = useStudioStores();
  const draft = useStore(editor, (s) => s.draft);
  const { issues } = useMemo(() => compileDraft(draft), [draft]);
  const { fitView } = useReactFlow();

  const show = (nodeId: string) => {
    editor.getState().select(nodeId);
    void fitView({ nodes: [{ id: nodeId }], duration: 200, maxZoom: 1.2 });
  };

  return (
    <section aria-labelledby="validation-heading" className="flex flex-col gap-1">
      <h2 id="validation-heading" className="text-sm font-semibold">
        {t('heading')}
      </h2>
      {issues.length === 0 ? (
        <p className="text-xs text-success">✓ {t('ok')}</p>
      ) : (
        <ul className="flex flex-col gap-1" aria-label={t('heading')}>
          {issues.map((issue) => (
            <li
              key={`${issue.nodeId ?? issue.edgeId ?? 'graph'}:${issue.message}`}
              className="flex items-start justify-between gap-2 text-xs"
            >
              <span>
                <span aria-hidden="true">! </span>
                {issue.message}
              </span>
              {issue.nodeId ? (
                <button
                  type="button"
                  onClick={() => show(issue.nodeId as string)}
                  className="rounded border border-line px-1.5 py-0.5"
                >
                  {t('show')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
