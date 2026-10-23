import { useReactFlow } from '@xyflow/react';
import { useCallback, useEffect } from 'react';
import { useTranslations } from 'use-intl';
import { useStore } from 'zustand';
import { useStudioStores } from '../context.tsx';
import { KitButton as Button } from '../design-kit/index.ts';

/** True when a key press belongs to text editing or an IME composition, not to the canvas. */
export function isTextEditingEvent(event: KeyboardEvent): boolean {
  if (event.isComposing || event.keyCode === 229) return true;
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) ||
    Boolean(
      target.closest(
        '[role="combobox"], [role="listbox"], [role="option"], [role="radio"], [role="checkbox"], [role="switch"]',
      ),
    )
  );
}

/** Dispatched on `window` to tidy up the open editor's canvas (the command palette uses it). */
export const TIDY_EVENT = 'corral:tidy-canvas';

export function EditorToolbar() {
  const t = useTranslations('Toolbar');
  const { editor } = useStudioStores();
  const canUndo = useStore(editor, (s) => s.canUndo);
  const canRedo = useStore(editor, (s) => s.canRedo);
  const empty = useStore(editor, (s) => s.draft.definition.nodes.length === 0);
  const { fitView } = useReactFlow();
  // Tidy up (roadmap 18), then show the whole result once React Flow has the new positions.
  const tidy = useCallback(() => {
    editor.getState().arrange();
    requestAnimationFrame(() => void fitView({ duration: 200, padding: 0.1 }));
  }, [editor, fitView]);
  useEffect(() => {
    // The command palette lives outside the editor; it asks through this event.
    window.addEventListener(TIDY_EVENT, tidy);
    return () => window.removeEventListener(TIDY_EVENT, tidy);
  }, [tidy]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Text fields keep the browser's own undo; IME composition never triggers commands.
      if (isTextEditingEvent(event) || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'z' && !event.shiftKey) {
        event.preventDefault();
        editor.getState().undo();
      } else if ((key === 'z' && event.shiftKey) || key === 'y') {
        event.preventDefault();
        editor.getState().redo();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editor]);

  return (
    <div role="toolbar" aria-label={t('shortcuts')} className="flex items-center gap-1">
      <Button
        variant="tertiary"
        type="button"
        onClick={() => editor.getState().undo()}
        disabled={!canUndo}
      >
        {t('undo')}
      </Button>
      <Button
        variant="tertiary"
        type="button"
        onClick={() => editor.getState().redo()}
        disabled={!canRedo}
      >
        {t('redo')}
      </Button>
      <Button
        variant="tertiary"
        type="button"
        onClick={tidy}
        disabled={empty}
        title={t('tidyHint')}
      >
        {t('tidy')}
      </Button>
    </div>
  );
}
