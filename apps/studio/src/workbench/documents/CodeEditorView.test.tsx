// @vitest-environment jsdom
import type { editor } from 'monaco-editor/editor';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { CodeEditorView, type EditorDebugState } from './CodeEditorView.tsx';

const fixture = vi.hoisted(() => ({ monaco: {} as object }));
vi.mock('./monaco.ts', () => ({
  loadMonaco: async () => fixture.monaco,
  onMonacoWorkerError: () => () => {},
}));
vi.mock('../theme-colors.ts', () => ({
  resolvedThemeColors: (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, '#171717'])),
}));

it('gutter and F9 share an explicit line action while debug decorations preserve the model', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let mouse:
    | ((event: {
        event: { leftButton: boolean };
        target: {
          type: number;
          position: { lineNumber: number };
          detail: { isAfterLines: boolean };
        };
      }) => void)
    | undefined;
  let changed: (() => void) | undefined;
  const actions = new Map<string, { run(): void }>();
  const decorations = { set: vi.fn(), clear: vi.fn() };
  const enabled = { set: vi.fn(), reset: vi.fn() };
  const model = {
    getLineCount: () => 5,
    setValue: vi.fn(),
    pushEditOperations: vi.fn(),
    dispose: vi.fn(),
  } as unknown as editor.ITextModel;
  const instance = {
    getSelection: () => null,
    getPosition: () => ({ lineNumber: 3, column: 2 }),
    onDidChangeCursorSelection: () => ({ dispose: vi.fn() }),
    onMouseDown: vi.fn((listener: typeof mouse) => {
      mouse = listener;
      return { dispose: vi.fn() };
    }),
    onDidChangeModelContent: vi.fn((listener: () => void) => {
      changed = listener;
      return { dispose: vi.fn() };
    }),
    addAction: vi.fn((action: { id: string; run(): void }) => {
      actions.set(action.id, action);
      return { dispose: vi.fn() };
    }),
    createDecorationsCollection: () => decorations,
    createContextKey: () => enabled,
    updateOptions: vi.fn(),
    saveViewState: () => null,
    dispose: vi.fn(),
  };
  const create = vi.fn(() => instance);
  fixture.monaco = {
    editor: {
      create,
      defineTheme: vi.fn(),
      setTheme: vi.fn(),
      registerEditorOpener: () => ({ dispose: vi.fn() }),
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49, F9: 67 },
  };
  const toggle = vi.fn();
  const initial: EditorDebugState = {
    breakpoints: [{ line: 2, verified: true }],
    pausedLine: 4,
    canToggle: true,
    toggleLabel: 'Toggle breakpoint',
    onToggle: toggle,
  };
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  const render = (debug: EditorDebugState) =>
    act(async () =>
      root.render(
        <CodeEditorView
          model={model}
          viewId="view"
          ariaLabel="file"
          saveLabel="Save"
          onSave={() => {}}
          debug={debug}
        />,
      ),
    );
  try {
    await render(initial);
    expect(create).toHaveBeenCalledExactlyOnceWith(
      element.querySelector('section'),
      expect.objectContaining({ model }),
    );
    expect(decorations.set).toHaveBeenLastCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          range: expect.objectContaining({ startLineNumber: 2 }),
          options: expect.objectContaining({ glyphMarginClassName: 'corral-debug-breakpoint' }),
        }),
        expect.objectContaining({
          range: expect.objectContaining({ startLineNumber: 4 }),
          options: expect.objectContaining({ className: 'corral-debug-paused' }),
        }),
      ]),
    );
    mouse?.({
      event: { leftButton: true },
      target: { type: 2, position: { lineNumber: 2 }, detail: { isAfterLines: false } },
    });
    actions.get('corral.debug.toggle-breakpoint')?.run();
    expect(toggle.mock.calls).toEqual([[2], [3]]);
    changed?.();
    expect(decorations.clear).toHaveBeenCalled();
    await render({
      ...initial,
      canToggle: false,
      breakpoints: [{ line: 2, verified: false }],
      pausedLine: null,
    });
    actions.get('corral.debug.toggle-breakpoint')?.run();
    expect(toggle).toHaveBeenCalledTimes(2);
    expect(decorations.set).toHaveBeenLastCalledWith([
      expect.objectContaining({
        options: expect.objectContaining({
          glyphMarginClassName: 'corral-debug-breakpoint corral-debug-breakpoint-unverified',
        }),
      }),
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(model.setValue).not.toHaveBeenCalled();
    expect(model.pushEditOperations).not.toHaveBeenCalled();
    expect(model.dispose).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    element.remove();
    vi.unstubAllGlobals();
  }
});
