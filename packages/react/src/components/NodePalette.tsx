import type { DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { useStudioStores } from '../context.tsx';
import type { EditorNodeType } from '../editor/model.ts';
import { NODE_DRAG_TYPE } from './CorralCanvas.tsx';

const KINDS: EditorNodeType[] = ['agent', 'decision', 'loop', 'output'];

export function NodePalette() {
  const t = useTranslations('Palette');
  const { editor } = useStudioStores();

  const onDragStart = (event: DragEvent, kind: EditorNodeType) => {
    event.dataTransfer.setData(NODE_DRAG_TYPE, kind);
    event.dataTransfer.effectAllowed = 'move';
  };
  // Keyboard and pointer-free alternative to dragging (Technical-Design §13.4).
  // New nodes go to the right of what is already there, so they never land on a Loop area.
  const add = (kind: EditorNodeType) => {
    const boxes = Object.values(editor.getState().draft.layout);
    const right = Math.max(40, ...boxes.map((b) => b.x + (b.width ?? 180)));
    editor.getState().addNode(kind, { x: right + 40, y: 100 });
  };

  return (
    <section aria-labelledby="palette-heading" className="flex flex-col gap-2">
      <h2 id="palette-heading" className="text-sm font-semibold">
        {t('heading')}
      </h2>
      <p className="text-xs text-muted">{t('hint')}</p>
      <ul className="flex flex-col gap-2">
        {KINDS.map((kind) => (
          <li
            key={kind}
            draggable
            onDragStart={(event) => onDragStart(event, kind)}
            data-palette-item={kind}
            className="cursor-grab rounded-lg fill-group p-2 active:cursor-grabbing"
          >
            <div className="text-sm font-medium">{t(kind)}</div>
            <div className="text-xs text-muted">{t(`${kind}Description`)}</div>
            <button
              type="button"
              onClick={() => add(kind)}
              className="mt-2 rounded-md fill-control px-2 py-1 text-xs hover:bg-subtle"
            >
              {t('add', { kind: t(kind) })}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
