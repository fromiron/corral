// The 작업 tab's way into the browser tab (features/browser-tab.md 여는 곳): where the desktop's
// browser tab is, a ready preview lease opens in its own preview tab, or the one already open
// for it is chosen. Without it (a remote host's window, web mode) the context is null and the
// previews keep their separate window or inline frame.
import { createContext, useContext } from 'react';

export interface PreviewTabs {
  /**
   * Opens or chooses the lease's preview tab; false when nothing opened (the panel is held by a
   * confirmation, or no tab can be made). `started`: the 작업 tab started this service preview,
   * so closing its tab or leaving the conversation stops it (닫기와 떠나기).
   */
  open(leaseId: string, options?: { started?: boolean }): boolean;
}

export const PreviewTabsContext = createContext<PreviewTabs | null>(null);

export const usePreviewTabs = () => useContext(PreviewTabsContext);
