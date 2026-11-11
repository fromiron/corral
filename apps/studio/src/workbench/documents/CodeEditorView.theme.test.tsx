// @vitest-environment jsdom
import type { editor } from 'monaco-editor/editor';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { parsePreferences } from '../preferences.ts';
import { applyAppearance, endPreview, previewPalette } from '../themes/appearance.ts';
import { BUILTIN_THEMES } from '../themes/builtin.ts';
import { CodeEditorView } from './CodeEditorView.tsx';

const fixture = vi.hoisted(() => ({ monaco: {} as object }));
vi.mock('./monaco.ts', () => ({
  loadMonaco: async () => fixture.monaco,
  onMonacoWorkerError: () => () => {},
}));
vi.mock('../theme-colors.ts', () => ({
  resolvedThemeColors: (names: string[]) =>
    Object.fromEntries(names.map((name) => [name, '#171717'])),
}));

const monokai = BUILTIN_THEMES.find((theme) => theme.id === 'monokai')?.palette;
afterEach(() => {
  applyAppearance({ ...parsePreferences(null), theme: 'light' });
  vi.unstubAllGlobals();
});

function fakeMonaco() {
  const disposable = () => ({ dispose: vi.fn() });
  const instance = {
    getSelection: () => null,
    getPosition: () => null,
    onDidChangeCursorSelection: disposable,
    onMouseDown: disposable,
    onDidChangeModelContent: disposable,
    addAction: disposable,
    createDecorationsCollection: () => ({ set: vi.fn(), clear: vi.fn() }),
    createContextKey: () => ({ set: vi.fn(), reset: vi.fn() }),
    updateOptions: vi.fn(),
    saveViewState: () => null,
    dispose: vi.fn(),
  };
  const create = vi.fn(() => instance);
  const defineTheme = vi.fn();
  const setTheme = vi.fn();
  fixture.monaco = {
    editor: {
      create,
      defineTheme,
      setTheme,
      registerEditorOpener: disposable,
      MouseTargetType: { GUTTER_GLYPH_MARGIN: 2 },
      TrackedRangeStickiness: { NeverGrowsWhenTypingAtEdges: 1 },
    },
    KeyMod: { CtrlCmd: 2048 },
    KeyCode: { KeyS: 49, F9: 67 },
  };
  return { create, defineTheme, setTheme };
}

async function showEditor() {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  applyAppearance({ ...parsePreferences(null), theme: 'light' });
  const monaco = fakeMonaco();
  const model = { getLineCount: () => 1 } as unknown as editor.ITextModel;
  const element = document.createElement('div');
  document.body.append(element);
  const root = createRoot(element);
  await act(async () =>
    root.render(
      <CodeEditorView
        model={model}
        viewId="v"
        ariaLabel="file"
        saveLabel="Save"
        onSave={() => {}}
      />,
    ),
  );
  return {
    ...monaco,
    last: () => monaco.defineTheme.mock.calls.at(-1)?.[1] as editor.IStandaloneThemeData,
    close: async () => {
      await act(async () => root.unmount());
      element.remove();
    },
  };
}

it('takes a named theme’s syntax colors without recreating the editor, and today’s theme under light', async () => {
  const { create, defineTheme, setTheme, last, close } = await showEditor();
  try {
    expect(defineTheme).toHaveBeenCalled();
    expect(last()).toMatchObject({ base: 'vs', rules: [] });
    expect(last().colors['editor.selectionBackground']).toBeUndefined();

    await act(async () => {
      applyAppearance({ ...parsePreferences(null), theme: 'dark', palette: 'builtin:monokai' });
    });
    expect(last().base).toBe('vs-dark');
    expect(last().rules).toContainEqual({
      token: 'comment',
      foreground: monokai?.syntax.comment.slice(1),
    });
    expect(last().colors['editor.selectionBackground']).toBe(monokai?.ui.selection);
    expect(setTheme).toHaveBeenLastCalledWith('corral');

    await act(async () => {
      applyAppearance({ ...parsePreferences(null), theme: 'light' });
    });
    expect(last()).toMatchObject({ base: 'vs', rules: [] });
    expect(create).toHaveBeenCalledTimes(1);
  } finally {
    await close();
  }
});

// A re-theme inside the apply itself (before it returns) left Monaco's overview ruler blank in
// Chromium after a switch; the root observer re-themes once, after the apply.
it('re-themes once per apply, after the apply returns, and follows a draft that changes only a syntax color', async () => {
  const { defineTheme, last, close } = await showEditor();
  try {
    defineTheme.mockClear();
    await act(async () => {
      applyAppearance({ ...parsePreferences(null), theme: 'dark', palette: 'builtin:monokai' });
      expect(defineTheme).not.toHaveBeenCalled();
    });
    expect(defineTheme).toHaveBeenCalledTimes(1);
    expect(last().base).toBe('vs-dark');

    if (!monokai) throw new Error('No Monokai');
    await act(async () => {
      previewPalette({ ...monokai, syntax: { ...monokai.syntax, keyword: '#123456' } });
    });
    expect(last().rules).toContainEqual({ token: 'keyword', foreground: '123456' });
    // The saved choice here is the default (system, read as light).
    await act(async () => endPreview());
    expect(last()).toMatchObject({ base: 'vs', rules: [] });
  } finally {
    await close();
  }
});
