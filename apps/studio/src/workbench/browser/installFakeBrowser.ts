// Development only (main.tsx, behind `import.meta.env.DEV` and `?fakeDesktopBrowser=1`): the
// browser tab over a stand-in bridge, to look at it outside the desktop app. The page's place is
// a grey box where the desktop would lay its view. `window.corralFakeBrowser` sends events to
// try the tab's other states (a failed page, a permission ask, a download).
import type { StudioServices } from '../../services.tsx';
import { createFakeBrowserBridge, type FakeBrowserBridge } from './fakeBrowserBridge.ts';

declare global {
  interface Window {
    corralFakeBrowser?: FakeBrowserBridge;
  }
}

export function installFakeBrowser(services: StudioServices) {
  if (services.browser) return;
  const bridge = createFakeBrowserBridge({ delay: 400 });
  services.browser = bridge;
  window.corralFakeBrowser = bridge;
  const style = document.createElement('style');
  style.textContent = '[data-slot="browser-page"][data-live]{background:var(--color-accent)}';
  document.head.append(style);
}
