import type { DragEvent } from 'react';
import { useTranslations } from 'use-intl';
import { useStudioStores } from '../context.tsx';
import {
  KitButton as Button,
  KitCard as Card,
  KitCardDescription as CardDescription,
  KitCardFooter as CardFooter,
  KitCardHeader as CardHeader,
  KitCardTitle as CardTitle,
} from '../design-kit/index.ts';
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
      <h2 id="palette-heading" className="text-subtitle">
        {t('heading')}
      </h2>
      <p className="text-caption text-muted-foreground">{t('hint')}</p>
      <ul className="flex flex-col gap-2">
        {KINDS.map((kind) => (
          <li
            key={kind}
            draggable
            onDragStart={(event) => onDragStart(event, kind)}
            data-palette-item={kind}
            className="cursor-grab active:cursor-grabbing"
          >
            <Card>
              <CardHeader>
                <CardTitle>{t(kind)}</CardTitle>
                <CardDescription>{t(`${kind}Description`)}</CardDescription>
              </CardHeader>
              <CardFooter>
                <Button variant="tertiary" onClick={() => add(kind)}>
                  {t('add', { kind: t(kind) })}
                </Button>
              </CardFooter>
            </Card>
          </li>
        ))}
      </ul>
    </section>
  );
}
