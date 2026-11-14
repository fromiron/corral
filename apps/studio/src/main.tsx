import './csp.ts';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { desktop } from './desktop.tsx';
import { LocaleProvider } from './locale.tsx';
import { SessionMissingView } from './pages/RootLayout.tsx';
import { StartupFailure } from './pages/StartupFailure.tsx';
import { createStudioRouter } from './router.tsx';
import { createStudioServices, ServicesProvider } from './services.tsx';
import { StudioDesignKit } from './workbench/StudioDesignKit.tsx';
import { applyAppearance } from './workbench/themes/appearance.ts';
import '@corral/react/fonts.css';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
// The saved theme, named or not, is on the root before the first frame React draws.
applyAppearance();
if (desktop) document.documentElement.classList.add('desktop-app');

// Pasting a bootstrap link can change only the fragment without rerunning startup.
window.addEventListener('hashchange', () => {
  if (window.location.hash.startsWith('#bootstrap=')) window.location.reload();
});

const renderer = createRoot(root);
try {
  const services = await createStudioServices();
  window.addEventListener('pagehide', () => services.disposeRuns(), { once: true });
  const router = createStudioRouter(services);
  renderer.render(
    <StrictMode>
      <StudioDesignKit>
        <LocaleProvider>
          <ServicesProvider services={services}>
            {services.sessionMissing ? <SessionMissingView /> : <RouterProvider router={router} />}
          </ServicesProvider>
        </LocaleProvider>
      </StudioDesignKit>
    </StrictMode>,
  );
} catch {
  renderer.render(
    <StrictMode>
      <StudioDesignKit>
        <LocaleProvider>
          <StartupFailure />
        </LocaleProvider>
      </StudioDesignKit>
    </StrictMode>,
  );
}
