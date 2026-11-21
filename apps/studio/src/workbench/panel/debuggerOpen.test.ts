// The debugger opening a 문서 tab (features/session-panel.md 하단 도크, 디버그와 문서): it never
// raises a drawer over the dock and never adds a history entry.
import { describe, expect, it } from 'vitest';
import { ctx, files, ids, narrow, panel, shape, way } from './fixtures.ts';
import { type PanelEvent, reducePanel } from './model.ts';
import type { PanelTab, PanelTarget } from './tabs.ts';

const doc = (path: string): PanelTab => ({ kind: 'document', source: 'copy', path });
const frame = (path: string): PanelEvent => ({
  type: 'open',
  target: { panel: 'document', file: path } satisfies PanelTarget,
  from: 'debugger',
});

describe('a document the debugger opens', () => {
  it('without room on a closed panel opens and selects its tab, the panel staying closed and the address compose', () => {
    const state = panel({ tabs: [files], selected: 'files', presentation: 'closed' });
    const result = reducePanel(state, frame('src/a.ts'), narrow());
    expect(shape(result.state)).toEqual({
      tabs: [files, doc('src/a.ts')],
      selected: 'document:copy:src/a.ts',
      presentation: 'closed',
    });
    expect(result.address).toEqual({ compose: true });
    expect(result.history).toBe('replace');
  });

  it('on a withdrawn panel leaves it withdrawn', () => {
    const state = panel({ tabs: [files], selected: 'files', presentation: 'withdrawn' });
    const result = reducePanel(state, frame('src/a.ts'), narrow());
    expect(result.state.presentation).toBe('withdrawn');
    expect(result.state.selected).toBe('document:copy:src/a.ts');
    expect(result.history).toBe('replace');
  });

  it('with room on a closed panel opens it beside, as a way would, but rewrites the address', () => {
    const state = panel({ tabs: [files], selected: 'files', presentation: 'closed' });
    const result = reducePanel(state, frame('src/a.ts'), ctx());
    expect(result.state.presentation).toBe('beside');
    expect(result.address).toMatchObject({ panel: 'document', file: 'src/a.ts' });
    expect(result.history).toBe('replace');
  });

  it('frame after frame never adds an entry; one already selected writes nothing', () => {
    let state = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    for (const path of ['a.ts', 'b.ts', 'c.ts']) {
      const result = reducePanel(state, frame(path), ctx());
      expect(result.history).toBe('replace');
      state = result.state;
    }
    expect(ids(state)).toEqual([files, doc('a.ts'), doc('b.ts'), doc('c.ts')]);
    expect(state.selected).toBe('document:copy:c.ts');
    expect(reducePanel(state, frame('c.ts'), ctx()).history).toBeNull();
  });

  it('in a drawer the person opened stays in it', () => {
    const state = panel({ tabs: [files], selected: 'files', presentation: 'drawer' });
    expect(reducePanel(state, frame('src/a.ts'), narrow()).state.presentation).toBe('drawer');
  });

  it('is not a way: a way without room raises the drawer and adds an entry (counterexample)', () => {
    const state = panel({ tabs: [files], selected: 'files', presentation: 'closed' });
    const result = reducePanel(state, way({ panel: 'document', file: 'src/a.ts' }), narrow());
    expect(result.state.presentation).toBe('drawer');
    expect(result.history).toBe('push');
  });
});
