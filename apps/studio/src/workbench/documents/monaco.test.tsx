import type { editor } from 'monaco-editor/editor';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CodeEditorView } from './CodeEditorView.tsx';
import { loadMonaco } from './monaco.ts';

it('imports and renders the editor boundary without loading the browser runtime', () => {
  expect(typeof loadMonaco).toBe('function');
  const html = renderToStaticMarkup(
    <CodeEditorView
      model={{} as editor.ITextModel}
      viewId="fixture"
      ariaLabel="Edit fixture.ts"
      saveLabel="Save"
      onSave={() => {}}
    />,
  );
  expect(html).toContain('Edit fixture.ts');
});
