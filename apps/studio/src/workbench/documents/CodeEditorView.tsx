import type { LanguageRefactor, TextRange } from '@corral/contracts';
import { cn } from '@corral/react/design-kit';
import type { editor } from 'monaco-editor/editor';
import { useEffect, useRef } from 'react';
import { resolvedThemeColors } from '../theme-colors.ts';
import { loadMonaco, type Monaco, onMonacoWorkerError } from './monaco.ts';

export type LanguageSelection = {
  position: Extract<LanguageRefactor, { kind: 'rename' }>['position'];
  range: Extract<LanguageRefactor, { kind: 'code_actions' }>['range'];
};
export interface EditorDebugState {
  breakpoints: { line: number; verified: boolean }[];
  pausedLine: number | null;
  canToggle: boolean;
  toggleLabel: string;
  onToggle(line: number): void;
}
export interface CodeEditorViewProps {
  model: editor.ITextModel;
  viewId: string;
  readOnly?: boolean;
  ariaLabel: string;
  saveLabel: string;
  onSave: () => unknown;
  onLanguageSelection?: (selection: LanguageSelection) => void;
  onSelection?: (startLine: number, endLine: number, selection: TextRange | null) => void;
  revealRange?: { startLine: number; endLine: number };
  revealSelection?: TextRange;
  onError?: () => void;
  onOpenResource?: (resource: string, range: TextRange) => Promise<boolean>;
  debug?: EditorDebugState;
  className?: string;
}

const viewStates = new WeakMap<editor.ITextModel, Map<string, editor.ICodeEditorViewState>>();

function revealLines(
  instance: editor.IStandaloneCodeEditor,
  range: { startLine: number; endLine: number },
) {
  revealTextSelection(instance, { ...range, startColumn: 1, endColumn: Number.MAX_SAFE_INTEGER });
}

function revealTextSelection(instance: editor.IStandaloneCodeEditor, range: TextRange) {
  const model = instance.getModel();
  if (!model) return;
  const selection = model.validateRange({
    startLineNumber: range.startLine,
    startColumn: range.startColumn,
    endLineNumber: range.endLine,
    endColumn: range.endColumn,
  });
  instance.setSelection(selection);
  instance.revealRangeInCenter(selection);
}

function applyEditorTheme(monaco: Monaco) {
  const root = document.documentElement;
  const colors = resolvedThemeColors([
    'surface',
    'text',
    'muted-foreground',
    'primary',
    'raised',
    'line',
    'danger',
    'warning',
    'focus-ring',
  ]);
  monaco.editor.defineTheme('corral', {
    base: root.classList.contains('dark') ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': colors.surface,
      'editor.foreground': colors.text,
      'editorLineNumber.foreground': colors['muted-foreground'],
      'editorLineNumber.activeForeground': colors.text,
      'editorCursor.foreground': colors.primary,
      'editorWidget.background': colors.raised,
      'editorWidget.border': colors.line,
      'editorError.foreground': colors.danger,
      'editorWarning.foreground': colors.warning,
      focusBorder: colors['focus-ring'],
    },
  });
  monaco.editor.setTheme('corral');
}

/** A view owns selection and scroll; the document store owns text, undo and model lifetime. */
export function CodeEditorView(props: CodeEditorViewProps) {
  const {
    model,
    viewId,
    readOnly = false,
    ariaLabel,
    saveLabel,
    revealRange,
    revealSelection,
    className,
    debug,
  } = props;
  const container = useRef<HTMLElement>(null);
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const updateDebug = useRef(() => {});
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
        const decorations = instance.createDecorationsCollection();
        const canDebug = instance.createContextKey<boolean>('corralDebugCanToggle', false);
        let debugAction: { dispose(): void } | undefined;
        let actionLabel: string | undefined;
        let sourceChanged = false;
        const validLine = (line: number) =>
          Number.isInteger(line) && line > 0 && line <= model.getLineCount();
        const toggle = (line: number) => {
          const state = callbacks.current.debug;
          if (state?.canToggle && !sourceChanged && !instance.inComposition && validLine(line))
            state.onToggle(line);
        };
        updateDebug.current = () => {
          const state = callbacks.current.debug;
          sourceChanged = false;
          instance.updateOptions({ glyphMargin: Boolean(state) });
          canDebug.set(Boolean(state?.canToggle));
          if (actionLabel !== state?.toggleLabel) {
            debugAction?.dispose();
            actionLabel = state?.toggleLabel;
            debugAction = state
              ? instance.addAction({
                  id: 'corral.debug.toggle-breakpoint',
                  label: state.toggleLabel,
                  keybindings: [monaco.KeyCode.F9],
                  precondition: 'corralDebugCanToggle',
                  contextMenuGroupId: 'navigation',
                  run: () => {
                    const position = instance.getPosition();
                    if (position) toggle(position.lineNumber);
                  },
                })
              : undefined;
          }
          const lines: editor.IModelDeltaDecoration[] = [];
          const range = (line: number) => ({
            startLineNumber: line,
            startColumn: 1,
            endLineNumber: line,
            endColumn: 1,
          });
          for (const breakpoint of state?.breakpoints ?? [])
            if (validLine(breakpoint.line))
              lines.push({
                range: range(breakpoint.line),
                options: {
                  glyphMarginClassName: `corral-debug-breakpoint${breakpoint.verified ? '' : ' corral-debug-breakpoint-unverified'}`,
                  stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
                },
              });
          if (state?.pausedLine && validLine(state.pausedLine))
            lines.push({
              range: range(state.pausedLine),
              options: {
                isWholeLine: true,
                className: 'corral-debug-paused',
                stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
              },
            });
          decorations.set(lines);
        };
        updateDebug.current();
        const debugMouse = instance.onMouseDown((event) => {
          if (
            event.event.leftButton &&
            event.target.type === monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
            !event.target.detail.isAfterLines
          )
            toggle(event.target.position.lineNumber);
        });
        const debugChanged = instance.onDidChangeModelContent(() => {
          sourceChanged = true;
          canDebug.set(false);
          decorations.clear();
        });
        const saved = viewStates.get(model)?.get(viewId);
        if (saved) instance.restoreViewState(saved);
        const select = (selection: ReturnType<typeof instance.getSelection>) => {
          if (!selection) return;
          callbacks.current.onLanguageSelection?.({
            position: {
              line: selection.positionLineNumber - 1,
              character: selection.positionColumn - 1,
            },
            range: {
              start: { line: selection.startLineNumber - 1, character: selection.startColumn - 1 },
              end: { line: selection.endLineNumber - 1, character: selection.endColumn - 1 },
            },
          });
          callbacks.current.onSelection?.(
            selection.startLineNumber,
            selection.endLineNumber,
            selection.isEmpty()
              ? null
              : {
                  startLine: selection.startLineNumber,
                  startColumn: selection.startColumn,
                  endLine: selection.endLineNumber,
                  endColumn: selection.endColumn,
                },
          );
        };
        const selected = instance.onDidChangeCursorSelection(({ selection }) => select(selection));
        select(instance.getSelection());
        const save = instance.addAction({
          id: 'corral.document.save',
          label: saveLabel,
          keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
          run: async () => {
            if (!instance.inComposition) await callbacks.current.onSave();
          },
        });
        const opener = monaco.editor.registerEditorOpener({
          openCodeEditor(source, resource, selection) {
            if (source !== instance || !selection || !callbacks.current.onOpenResource)
              return false;
            const range =
              'startLineNumber' in selection
                ? {
                    startLine: selection.startLineNumber,
                    startColumn: selection.startColumn,
                    endLine: selection.endLineNumber,
                    endColumn: selection.endColumn,
                  }
                : {
                    startLine: selection.lineNumber,
                    startColumn: selection.column,
                    endLine: selection.lineNumber,
                    endColumn: selection.column,
                  };
            return callbacks.current.onOpenResource(resource.toString(), range);
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
          opener.dispose();
          debugMouse.dispose();
          debugChanged.dispose();
          debugAction?.dispose();
          canDebug.reset();
          decorations.clear();
          updateDebug.current = () => {};
          selected.dispose();
          save.dispose();
          stopWorkerErrors();
          theme.disconnect();
          instance.dispose();
          editorRef.current = null;
        };
        const selection = callbacks.current.revealSelection;
        const range = callbacks.current.revealRange;
        if (selection) revealTextSelection(instance, selection);
        else if (range) revealLines(instance, range);
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
    void debug;
    updateDebug.current();
  }, [debug]);

  useEffect(() => {
    const instance = editorRef.current;
    if (!instance || !revealRange) return;
    revealLines(instance, revealRange);
  }, [revealRange]);

  useEffect(() => {
    const instance = editorRef.current;
    if (instance && revealSelection) revealTextSelection(instance, revealSelection);
  }, [revealSelection]);

  return (
    <section
      ref={container}
      aria-label={ariaLabel}
      className={cn('h-full min-h-64 min-w-0 flex-1 overflow-hidden', className)}
    />
  );
}
