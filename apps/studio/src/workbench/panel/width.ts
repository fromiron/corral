// The panel's widths (features/session-panel.md "폭", "서랍").
import type { PanelStorage } from './memory.ts';

export const CONVERSATION_MIN_WIDTH = 560;
export const PANEL_MIN_WIDTH = 360;
/** Below this work area width the drawer takes the whole work area. */
export const DRAWER_FULL_BELOW = 640;
/** Without a remembered width the panel takes this share of the work area. */
export const PANEL_DEFAULT_SHARE = 0.45;

/** The app's one remembered panel width, in px. */
export const PANEL_WIDTH_KEY = 'corral:session-panel-width:v1';

/** There is room when the work area holds the conversation's minimum and the panel's. */
export function hasRoom(workArea: number): boolean {
  return workArea >= CONVERSATION_MIN_WIDTH + PANEL_MIN_WIDTH;
}

/**
 * The panel's width beside the conversation: the remembered px, else 45% of the work area,
 * kept within [360, work area − 560]. Where that range is empty (no room) it is 360.
 */
export function panelWidth(workArea: number, remembered: number | null): number {
  const max = workArea - CONVERSATION_MIN_WIDTH;
  if (max < PANEL_MIN_WIDTH) return PANEL_MIN_WIDTH;
  const wanted = remembered ?? workArea * PANEL_DEFAULT_SHARE;
  return Math.round(Math.min(Math.max(wanted, PANEL_MIN_WIDTH), max));
}

/**
 * The drawer's width: the remembered panel width, else 45% of the work area, at least 360 and
 * never wider than the work area; all of the work area under 640. The drawer does not keep the
 * conversation's 560 beside it, so that bound does not apply.
 */
export function drawerWidth(workArea: number, remembered: number | null): number {
  if (workArea < DRAWER_FULL_BELOW) return workArea;
  const wanted = remembered ?? workArea * PANEL_DEFAULT_SHARE;
  return Math.round(Math.min(Math.max(wanted, PANEL_MIN_WIDTH), workArea));
}

export function parsePanelWidth(raw: string | null | undefined): number | null {
  if (typeof raw !== 'string' || !/^\d+(\.\d+)?$/.test(raw)) return null;
  const width = Number(raw);
  return Number.isFinite(width) && width > 0 ? width : null;
}

export function readPanelWidth(storage: PanelStorage | null): number | null {
  try {
    return parsePanelWidth(storage?.getItem(PANEL_WIDTH_KEY));
  } catch {
    return null;
  }
}

/** A failure to remember is silent. */
export function writePanelWidth(storage: PanelStorage | null, width: number): boolean {
  if (!storage || !Number.isFinite(width) || width <= 0) return false;
  try {
    storage.setItem(PANEL_WIDTH_KEY, String(Math.round(width)));
    return true;
  } catch {
    return false;
  }
}
