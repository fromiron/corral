import { useId } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';

export function NodeInspector() {
  const t = useTranslations('Inspector');
  const id = useId();
  const { editor } = useStudioStores();
  const brief = useStore(editor, (s) => s.draft.brief);
  const node = useStore(editor, (s) => s.draft.nodes.find((n) => n.id === s.selectedNodeId));

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-3">
      <h2 id={`${id}-heading`} className="text-sm font-semibold">
        {t('heading')}
      </h2>
      <div className="flex flex-col gap-1">
        <label htmlFor={`${id}-brief`} className="text-xs font-medium">
          {t('brief')}
        </label>
        <textarea
          id={`${id}-brief`}
          value={brief}
          onChange={(e) => editor.getState().setBrief(e.target.value)}
          rows={2}
          className="rounded-md border border-line bg-surface p-2 text-sm"
        />
      </div>
      {!node ? (
        <p className="text-sm text-muted">{t('none')}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <label htmlFor={`${id}-label`} className="text-xs font-medium">
            {t('label')}
          </label>
          <input
            id={`${id}-label`}
            value={node.label}
            onChange={(e) => editor.getState().updateNode(node.id, { label: e.target.value })}
            className="rounded-md border border-line bg-surface p-2 text-sm"
          />
          {node.type === 'agent' ? (
            <>
              <label htmlFor={`${id}-prompt`} className="text-xs font-medium">
                {t('prompt')}
              </label>
              <textarea
                id={`${id}-prompt`}
                value={node.prompt}
                onChange={(e) => editor.getState().updateNode(node.id, { prompt: e.target.value })}
                rows={4}
                className="rounded-md border border-line bg-surface p-2 text-sm"
              />
            </>
          ) : (
            <p className="text-xs text-muted">{t('outputNote')}</p>
          )}
          <button
            type="button"
            onClick={() => editor.getState().removeNode(node.id)}
            className="self-start rounded-md border border-danger px-2 py-1 text-xs text-danger"
          >
            {t('delete')}
          </button>
        </div>
      )}
    </section>
  );
}
