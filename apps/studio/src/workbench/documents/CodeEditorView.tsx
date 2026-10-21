import { cn } from '@corral/react/ui';
import type { editor } from 'monaco-editor/editor';
import { useEffect, useRef } from 'react';
import { loadMonaco, type Monaco, onMonacoWorkerError } from './monaco.ts';

export interface CodeEditorViewProps {
  model: editor.ITextModel;
  viewId: string;
  readOnly?: boolean;
  ariaLabel: string;
  saveLabel: string;
  onSave: () => unknown;
  onSelection?: (startLine: number, endLine: number) => void;
  revealRange?: { startLine: number; endLine: number };
  onError?: () => void;
  className?: string;
}

const viewStates = new WeakMap<editor.ITextModel, Map<string, editor.ICodeEditorViewState>>();

function revealLines(
  instance: editor.IStandaloneCodeEditor,
  range: { startLine: number; endLine: number },
) {
  const model = instance.getModel();
  if (!model) return;
  const selection = model.validateRange({
    startLineNumber: range.startLine,
    startColumn: 1,
    endLineNumber: range.endLine,
    endColumn: Number.MAX_SAFE_INTEGER,
  });
  instance.setSelection(selection);
  instance.revealRangeInCenter(selection);
}

function applyEditorTheme(monaco: Monaco) {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const color = (name: string) => style.getPropertyValue(`--${name}`).trim();
  monaco.editor.defineTheme('corral', {
    base: root.classList.contains('dark') ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': color('surface'),
      'editor.foreground': color('text'),
      'editorLineNumber.foreground': color('muted'),
      'editorLineNumber.activeForeground': color('text'),
      'editorCursor.foreground': color('accent'),
      'editorWidget.background': color('raised'),
      'editorWidget.border': color('line'),
      'editorError.foreground': color('danger'),
      'editorWarning.foreground': color('warning'),
      focusBorder: color('accent'),
    },
  });
  monaco.editor.setTheme('corral');
}

/** A view owns selection and scroll; the document store owns text, undo and model lifetime. */
export function CodeEditorView(props: CodeEditorViewProps) {
  const { model, viewId, readOnly = false, ariaLabel, saveLabel, revealRange, className } = props;
  const container = useRef<HTMLElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const callbacks = useRef(props);
  useEffect(() => {
    callbacks.current = props;
  });

  useEffect(() => {
    let cancelled = false;
    let cleanup = () => {};
    void loadMonaco()
      .then((monaco) => {
        if (cancelled || !container.current) return;
        applyEditorTheme(monaco);
        const instance = monaco.editor.create(container.current, {
          model,
          readOnly: callbacks.current.readOnly ?? false,
          ariaLabel: callbacks.current.ariaLabel,
          accessibilitySupport: 'auto',
          automaticLayout: true,
          minimap: { enabled: false },
          scrollBeyondLastLine: false,
          fontSize: 14,
          padding: { top: 12, bottom: 12 },
        });
        editorRef.current = instance;
        const saved = viewStates.get(model)?.get(viewId);
        if (saved) instance.restoreViewState(saved);
        const selected = instance.onDidChangeCursorSelection(({ selection }) => {
          callbacks.current.onSelection?.(selection.startLineNumber, selection.endLineNumber);
        });
        const save = instance.addAction({
          id: 'corral.document.save',
          label: saveLabel,
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: async () => {
            if (!instance.inComposition) await callbacks.current.onSave();
          },
        });
        const stopWorkerErrors = onMonacoWorkerError(() => callbacks.current.onError?.());
        const theme = new MutationObserver(() => applyEditorTheme(monaco));
        theme.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['class', 'data-theme', 'style'],
        });
        cleanup = () => {
          const state = instance.saveViewState();
          if (state) {
            const states = viewStates.get(model) ?? new Map();
            states.set(viewId, state);
            viewStates.set(model, states);
          }
          selected.dispose();
          save.dispose();
          stopWorkerErrors();
          theme.disconnect();
          instance.dispose();
          editorRef.current = null;
        };
        const range = callbacks.current.revealRange;
        if (range) revealLines(instance, range);
      })
      .catch(() => {
        if (!cancelled) callbacks.current.onError?.();
      });
    return () => {
      cancelled = true;
      cleanup();
    };
  }, [model, viewId, saveLabel]);

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, ariaLabel });
  }, [readOnly, ariaLabel]);

  useEffect(() => {
    const instance = editorRef.current;
    if (!instance || !revealRange) return;
    revealLines(instance, revealRange);
  }, [revealRange]);

  return (
    <section
      ref={container}
      aria-label={ariaLabel}
      className={cn('h-full min-h-64 min-w-0 flex-1 overflow-hidden', className)}
    />
  );
}
