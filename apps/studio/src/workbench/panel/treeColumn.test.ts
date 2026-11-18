// The wide panel's tree column in the panel model (features/session-panel.md 파일 탭과 트리 열): while
// the panel is wide and a 문서 tab is open, 파일 is not drawn in the strip, so it is never the
// selected tab; its ways select the 문서 tab chosen last instead.
import { describe, expect, it } from 'vitest';
import { changes, ctx, files, ids, panel, way } from './fixtures.ts';
import { EMPTY_PANEL, reducePanel } from './model.ts';
import type { PanelTab } from './tabs.ts';

const doc = (path: string): PanelTab => ({ kind: 'document', source: 'copy', path });
const a = doc('src/a.ts');
const b = doc('src/b.ts');
const wide = ctx({ wide: true });
const narrow = ctx({ wide: false });

describe('the wide panel never selects 파일 beside a 문서 tab', () => {
  it('a way to 파일 selects the 문서 tab chosen last', () => {
    let state = panel({ tabs: [files, a, b], selected: 'document:copy:src/a.ts' });
    state = reducePanel(state, { type: 'select', key: 'document:copy:src/b.ts' }, wide).state;
    state = reducePanel(state, { type: 'select', key: 'document:copy:src/a.ts' }, wide).state;
    const result = reducePanel(state, way({ panel: 'files' }), wide);
    expect(result.state.selected).toBe('document:copy:src/a.ts');
    expect(result.address).toMatchObject({ panel: 'document', file: 'src/a.ts' });
  });

  it('without a 문서 tab chosen yet, the first in the strip', () => {
    const state = panel({ tabs: [changes, files, b, a], selected: 'changes' });
    const result = reducePanel(state, { type: 'select', key: 'files' }, wide);
    expect(result.state.selected).toBe('document:copy:src/b.ts');
  });

  it('widening with 파일 selected selects the 문서 tab chosen last, rewriting the address', () => {
    let state = panel({ tabs: [files, a, b], selected: 'document:copy:src/a.ts' });
    state = reducePanel(state, { type: 'select', key: 'document:copy:src/b.ts' }, narrow).state;
    state = reducePanel(state, { type: 'select', key: 'files' }, narrow).state;
    expect(state.selected).toBe('files');
    const result = reducePanel(state, { type: 'context' }, wide);
    expect(result.state.selected).toBe('document:copy:src/b.ts');
    expect(result.history).toBe('replace');
  });

  it('narrowing leaves the selection as it is (counterexample)', () => {
    const state = panel({ tabs: [files, a], selected: 'document:copy:src/a.ts' });
    const result = reducePanel(state, { type: 'context' }, narrow);
    expect(result.state.selected).toBe('document:copy:src/a.ts');
  });

  it('a wide panel with 파일 alone keeps it selected, and a narrow one selects it (counterexamples)', () => {
    const alone = panel({ tabs: [files], selected: 'files' });
    expect(reducePanel(alone, { type: 'context' }, wide).state.selected).toBe('files');
    const both = panel({ tabs: [files, a], selected: 'document:copy:src/a.ts' });
    expect(reducePanel(both, { type: 'select', key: 'files' }, narrow).state.selected).toBe(
      'files',
    );
  });

  it('entering with 파일 remembered as selected selects a 문서 tab', () => {
    const result = reducePanel(
      EMPTY_PANEL,
      {
        type: 'enter',
        search: {},
        via: 'link',
        memory: { tabs: [files, a], selected: 'files', open: true },
      },
      wide,
    );
    expect(ids(result.state)).toEqual([files, a]);
    expect(result.state.selected).toBe('document:copy:src/a.ts');
  });

  it('closing the selected 문서 tab selects its neighbour in the strip, never the hidden 파일', () => {
    const state = panel({ tabs: [a, files, b], selected: 'document:copy:src/a.ts' });
    const result = reducePanel(state, { type: 'close', key: 'document:copy:src/a.ts' }, wide);
    expect(result.state.selected).toBe('document:copy:src/b.ts');
  });

  it('closing the last 문서 tab while it was selected selects 파일 again', () => {
    const state = panel({ tabs: [changes, files, a], selected: 'document:copy:src/a.ts' });
    const result = reducePanel(state, { type: 'close', key: 'document:copy:src/a.ts' }, wide);
    expect(ids(result.state)).toEqual([changes, files]);
    expect(result.state.selected).toBe('files');
  });

  it('closing the last 문서 tab while another was selected keeps that selection', () => {
    const state = panel({ tabs: [changes, files, a], selected: 'changes' });
    const result = reducePanel(state, { type: 'close', key: 'document:copy:src/a.ts' }, wide);
    expect(result.state.selected).toBe('changes');
  });

  it('an event that changes nothing returns the same state', () => {
    const state = panel({ tabs: [files, a], selected: 'document:copy:src/a.ts' });
    const once = reducePanel(state, { type: 'context' }, wide).state;
    expect(reducePanel(once, { type: 'context' }, wide).state).toBe(once);
  });
});
