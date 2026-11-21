import { describe, expect, it } from 'vitest';
import type { PanelStorage } from './memory.ts';
import {
  drawerWidth,
  hasRoom,
  PANEL_WIDTH_KEY,
  panelWidth,
  parsePanelWidth,
  readPanelWidth,
  WIDE_PANEL_WIDTH,
  widePanel,
  writePanelWidth,
} from './width.ts';

describe('room (폭)', () => {
  it('exists when the work area holds 560 + 360', () => {
    expect(hasRoom(920)).toBe(true);
    expect(hasRoom(919)).toBe(false);
    expect(hasRoom(1400)).toBe(true);
  });
});

describe('the panel width', () => {
  it('is 45% of the work area without a remembered width', () => {
    expect(panelWidth(1200, null)).toBe(540);
  });

  it('is the remembered width', () => {
    expect(panelWidth(1400, 500)).toBe(500);
  });

  it('is at least 360 and at most the work area minus 560', () => {
    expect(panelWidth(1000, 200)).toBe(360);
    expect(panelWidth(1000, 900)).toBe(440);
    expect(panelWidth(920, null)).toBe(360);
    expect(panelWidth(2000, null)).toBe(900);
  });

  it('is 360 where the range is empty (no room)', () => {
    expect(panelWidth(800, null)).toBe(360);
    expect(panelWidth(800, 700)).toBe(360);
  });
});

describe('the drawer width', () => {
  it('is the remembered panel width, else 45% of the work area, at least 360', () => {
    expect(drawerWidth(900, 500)).toBe(500);
    expect(drawerWidth(900, null)).toBe(405);
    expect(drawerWidth(800, null)).toBe(360);
    expect(drawerWidth(800, 200)).toBe(360);
  });

  it('is never wider than the work area', () => {
    expect(drawerWidth(700, 1000)).toBe(700);
    expect(drawerWidth(640, 900)).toBe(640);
  });

  it('takes the whole work area under 640', () => {
    expect(drawerWidth(639, null)).toBe(639);
    expect(drawerWidth(400, 380)).toBe(400);
    expect(drawerWidth(300, 1000)).toBe(300);
  });
});

describe('the remembered width', () => {
  const storage = (): PanelStorage & { items: Map<string, string> } => {
    const items = new Map<string, string>();
    return {
      items,
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => void items.set(key, value),
      removeItem: (key) => void items.delete(key),
    };
  };

  it('is one px value for the app', () => {
    const s = storage();
    expect(writePanelWidth(s, 480)).toBe(true);
    expect([...s.items.keys()]).toEqual([PANEL_WIDTH_KEY]);
    expect(readPanelWidth(s)).toBe(480);
  });

  it.each([null, undefined, '', 'wide', '-10', '0', 'NaN', 'Infinity', '{"w":1}'])(
    'treats %s as none (failure)',
    (raw) => {
      expect(parsePanelWidth(raw)).toBeNull();
    },
  );

  it('fails silently when storage throws or is missing (failure)', () => {
    const throwing: PanelStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => undefined,
    };
    expect(readPanelWidth(throwing)).toBeNull();
    expect(writePanelWidth(throwing, 480)).toBe(false);
    expect(readPanelWidth(null)).toBeNull();
    expect(writePanelWidth(null, 480)).toBe(false);
  });
});

describe('a wide panel (파일 탭과 트리 열)', () => {
  it('is 800px or more in whatever state it is: beside, maximized or a drawer', () => {
    expect(WIDE_PANEL_WIDTH).toBe(800);
    expect(widePanel('beside', 1800, 800)).toBe(true);
    expect(widePanel('beside', 1800, 799)).toBe(false);
    expect(widePanel('maximized', 1200, 400)).toBe(true);
    expect(widePanel('maximized', 790, 400)).toBe(false);
    expect(widePanel('drawer', 900, 850)).toBe(true);
    expect(widePanel('drawer', 600, null)).toBe(false);
  });

  it('is not wide before the work area is measured, or while it is off screen at its width', () => {
    expect(widePanel('beside', null, 900)).toBe(false);
    expect(widePanel('closed', 1800, 900)).toBe(true);
    expect(widePanel('withdrawn', 800, 900)).toBe(false);
  });
});
