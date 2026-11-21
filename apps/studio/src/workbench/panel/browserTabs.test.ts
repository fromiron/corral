// The panel model's 브라우저 tabs (features/session-panel.md 탭, "+" 목록, 주소와 기억;
// features/browser-tab.md 여는 곳, 새 창과 팝업, 계약): a new tab every time it is asked for, one
// tab per preview lease, the address carrying only the tab's ID, and memory carrying an ordinary
// page's origin and path or a preview page's lease.
import { describe, expect, it } from 'vitest';
import { nextSearch } from './address.ts';
import { ctx, enter, files, ids, narrow, panel, steps, way } from './fixtures.ts';
import { parsePanelMemory, rememberedPanel, serializePanelMemory } from './memory.ts';
import { type PanelEvent, reducePanel } from './model.ts';
import { type PanelTab, pageAt, plusItems, tabKey } from './tabs.ts';

const browser = (browserId: string, more: Partial<PanelTab & { kind: 'browser' }> = {}) =>
  ({ kind: 'browser', browserId, ...more }) as PanelTab;
/** Desktop with the browser bridge; the frame hands the reducer a fresh ID with each event. */
const desk = (newBrowserId = 'b_new', over = {}) => ctx({ browser: true, newBrowserId, ...over });
const plusBrowser: PanelEvent = { type: 'open', target: { panel: 'browser' }, from: 'plus' };

describe('opening a browser tab', () => {
  it('"+" opens a new tab at the right end, selected, with no page, and writes its ID', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(before, plusBrowser, desk('b_1'));
    expect(ids(result.state)).toEqual([files, browser('b_1')]);
    expect(result.state.selected).toBe('browser:b_1');
    expect(result.address).toEqual({ panel: 'browser', browser: 'b_1' });
    expect(result.history).toBe('replace');
  });

  it('opens another tab each time, never selecting the one already open', () => {
    const { state } = steps(panel({ presentation: 'closed' }), [plusBrowser], desk('b_1'));
    const again = reducePanel(state, plusBrowser, desk('b_2'));
    expect(ids(again.state)).toEqual([browser('b_1'), browser('b_2')]);
    expect(again.state.selected).toBe('browser:b_2');
  });

  it('a way (the palette, /browser) opens a new tab and adds an entry', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(before, way({ panel: 'browser' }), desk('b_1'));
    expect(result.state.selected).toBe('browser:b_1');
    expect(result.history).toBe('push');
  });

  it('opens nothing without the desktop browser (web mode, a remote host) (반례)', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(before, plusBrowser, ctx({ newBrowserId: 'b_1' }));
    expect(result.state).toBe(before);
    expect(result.history).toBeNull();
  });

  it('a preview lease opens its own tab once; opening it again selects that tab', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const lease = way({ panel: 'browser', lease: 'lease_1' });
    const first = reducePanel(before, lease, desk('b_1'));
    expect(ids(first.state)).toEqual([files, browser('b_1', { lease: 'lease_1' })]);
    expect(first.history).toBe('push');
    const back = reducePanel(first.state, { type: 'select', key: 'files' }, desk('b_2'));
    const again = reducePanel(back.state, lease, desk('b_3'));
    expect(ids(again.state)).toEqual([files, browser('b_1', { lease: 'lease_1' })]);
    expect(again.state.selected).toBe('browser:b_1');
  });
});

describe('the address', () => {
  it('enter with panel=browser and no ID opens a new tab and rewrites the address with its ID', () => {
    const result = reducePanel(
      panel(),
      enter({ panel: 'browser' }, null, 'address'),
      desk('b_1', { room: true }),
    );
    expect(ids(result.state)).toEqual([browser('b_1')]);
    expect(result.address).toEqual({ panel: 'browser', browser: 'b_1' });
    expect(result.history).toBe('replace');
    expect(nextSearch({ panel: 'browser' }, result)).toEqual({ panel: 'browser', browser: 'b_1' });
  });

  it('a followed address naming a tab of the conversation selects it', () => {
    const before = panel({
      tabs: [files, browser('b_1')],
      selected: 'files',
      presentation: 'beside',
    });
    const result = reducePanel(
      before,
      { type: 'follow', search: { panel: 'browser', browser: 'b_1' }, source: 'in-app' },
      desk('b_9'),
    );
    expect(result.state.selected).toBe('browser:b_1');
    expect(result.state.tabs).toHaveLength(2);
  });

  it('a followed address naming no tab of the conversation opens nothing and is rewritten (반례)', () => {
    const before = panel({ tabs: [files], selected: 'files', presentation: 'beside' });
    const result = reducePanel(
      before,
      { type: 'follow', search: { panel: 'browser', browser: 'b_gone' }, source: 'in-app' },
      desk('b_9'),
    );
    expect(ids(result.state)).toEqual([files]);
    expect(result.address).toEqual({ panel: 'files' });
    expect(result.history).toBe('replace');
  });

  it('entering with an unknown ID restores the memory instead of opening a tab (반례)', () => {
    const memory = { tabs: [files], selected: 'files' as const, open: true };
    const result = reducePanel(
      panel(),
      enter({ panel: 'browser', browser: 'b_gone' }, memory, 'address'),
      desk('b_9'),
    );
    expect(ids(result.state)).toEqual([files]);
    expect(result.address).toEqual({ panel: 'files' });
  });
});

describe('pages that change the tab list', () => {
  const open = () =>
    panel({
      tabs: [files, browser('b_1'), browser('b_2')],
      selected: 'browser:b_1',
      presentation: 'beside',
    });

  it('a page’s new window becomes a tab at the strip’s end, selected', () => {
    const result = reducePanel(
      open(),
      { type: 'browserPopup', browserId: 'b_pop', openerId: 'b_1' },
      desk(),
    );
    expect(ids(result.state)).toEqual([files, browser('b_1'), browser('b_2'), browser('b_pop')]);
    expect(result.state.selected).toBe('browser:b_pop');
    expect(result.history).toBe('replace');
  });

  it('a new window of a page the conversation no longer has opens nothing (반례)', () => {
    const before = open();
    const result = reducePanel(
      before,
      { type: 'browserPopup', browserId: 'b_pop', openerId: 'b_gone' },
      desk(),
    );
    expect(ids(result.state)).toEqual([files, browser('b_1'), browser('b_2')]);
    expect(result.history).toBeNull();
  });

  it('"새 탭에서 링크 열기" opens a tab right beside the page’s own, selected', () => {
    const result = reducePanel(
      open(),
      { type: 'browserBeside', browserId: 'b_link', besideId: 'b_1' },
      desk(),
    );
    expect(ids(result.state)).toEqual([files, browser('b_1'), browser('b_link'), browser('b_2')]);
    expect(result.state.selected).toBe('browser:b_link');
  });

  it('a new window’s tab whose page closes goes, and its right neighbour is selected', () => {
    const state = panel({
      tabs: [files, browser('b_pop'), browser('b_2')],
      selected: 'browser:b_pop',
      presentation: 'beside',
    });
    const result = reducePanel(state, { type: 'browserGone', browserId: 'b_pop' }, desk());
    expect(ids(result.state)).toEqual([files, browser('b_2')]);
    expect(result.state.selected).toBe('browser:b_2');
  });

  it('a page’s own address is kept for memory as its origin and path, never its query', () => {
    const state = panel({
      tabs: [browser('b_1')],
      selected: 'browser:b_1',
      presentation: 'beside',
    });
    const at = pageAt('https://user:pass@example.com/docs?token=abc#part');
    expect(at).toEqual({ origin: 'https://example.com', path: '/docs' });
    const result = reducePanel(
      state,
      { type: 'browserAt', browserId: 'b_1', at: at ?? null },
      desk(),
    );
    expect(ids(result.state)).toEqual([
      browser('b_1', { at: { origin: 'https://example.com', path: '/docs' } }),
    ]);
    expect(result.history).toBeNull();
    const raw = serializePanelMemory(rememberedPanel(result.state));
    expect(raw).not.toContain('token');
    expect(raw).not.toContain('pass');
    expect(parsePanelMemory(raw)?.tabs).toEqual([
      browser('b_1', { at: { origin: 'https://example.com', path: '/docs' } }),
    ]);
  });

  it('only an http(s) address is kept (반례)', () => {
    expect(pageAt('file:///etc/hosts')).toBeNull();
    expect(pageAt('javascript:alert(1)')).toBeNull();
    expect(pageAt('not a url')).toBeNull();
  });
});

describe('memory', () => {
  it('keeps a preview tab’s lease and a blank tab, and drops malformed browser entries', () => {
    const raw = JSON.stringify({
      v: 1,
      tabs: [
        { browser: 'b_1', lease: 'lease_1' },
        { browser: 'b_2' },
        { browser: 'b_3', origin: 'https://a.example', path: '/x' },
        { browser: 'bad id!' },
        { browser: 'b_4', origin: 'file://', path: '/etc' },
        { browser: 'b_5', origin: 'https://a.example', path: 'x' },
        { browser: 'b_1' },
      ],
      selected: 'browser:b_2',
      open: true,
    });
    expect(parsePanelMemory(raw)).toEqual({
      tabs: [
        browser('b_1', { lease: 'lease_1' }),
        browser('b_2'),
        browser('b_3', { at: { origin: 'https://a.example', path: '/x' } }),
      ],
      selected: 'browser:b_2',
      open: true,
    });
  });

  it('a browser tab’s key is browser: and its ID', () => {
    expect(tabKey(browser('b_1'))).toBe('browser:b_1');
  });

  it('entering without the desktop browser drops remembered browser tabs (반례)', () => {
    const memory = {
      tabs: [files, browser('b_1')],
      selected: 'browser:b_1' as const,
      open: true,
    };
    const result = reducePanel(panel(), enter({}, memory, 'link'), ctx());
    expect(ids(result.state)).toEqual([files]);
    expect(result.state.selected).toBe('files');
  });
});

describe('restored preview tabs', () => {
  const memory = {
    tabs: [files, browser('b_1', { lease: 'lease_gone' }), browser('b_2', { lease: 'lease_on' })],
    selected: 'browser:b_1' as const,
    open: true,
  };

  it('stay until the preview lease list answers, then those whose lease is not ready go', () => {
    const entered = reducePanel(panel(), enter({}, memory, 'link'), desk());
    expect(entered.state.tabs).toHaveLength(3);
    const answered = reducePanel(
      entered.state,
      { type: 'context' },
      desk('b_9', { leaseIds: ['lease_on'] }),
    );
    expect(ids(answered.state)).toEqual([files, browser('b_2', { lease: 'lease_on' })]);
    expect(answered.state.selected).toBe('files');
    expect(answered.history).toBe('replace');
  });

  it('the clean-up runs once: a lease opened later is never dropped by it (반례)', () => {
    const entered = reducePanel(panel(), enter({}, memory, 'link'), desk());
    const answered = reducePanel(
      entered.state,
      { type: 'context' },
      desk('b_9', { leaseIds: ['lease_on', 'lease_gone'] }),
    );
    const later = reducePanel(answered.state, { type: 'context' }, desk('b_9', { leaseIds: [] }));
    expect(later.state.tabs).toHaveLength(3);
  });

  it('a narrow room still drops them without opening a drawer', () => {
    const entered = reducePanel(panel(), enter({}, memory, 'link'), narrow({ browser: true }));
    const answered = reducePanel(
      entered.state,
      { type: 'context' },
      narrow({ browser: true, leaseIds: [] }),
    );
    expect(answered.state.presentation).not.toBe('drawer');
    expect(ids(answered.state)).toEqual([files]);
  });
});

describe('the "+" list', () => {
  it('ends with 브라우저 on the desktop, even with nothing else to open', () => {
    expect(plusItems({ folder: true, runIds: [], paddock: true, browser: true })).toEqual([
      'files',
      'terminal',
      'changes',
      'tools',
      'browser',
    ]);
    expect(plusItems({ folder: false, runIds: [], browser: true })).toEqual(['browser']);
    expect(plusItems({ folder: false, runIds: [] })).toEqual([]);
  });
});
