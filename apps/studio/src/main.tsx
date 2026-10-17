import './csp.ts';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { desktop } from './desktop.tsx';
import { LocaleProvider } from './locale.tsx';
import { SessionMissingView } from './pages/RootLayout.tsx';
import { createStudioRouter } from './router.tsx';
import { createStudioServices, ServicesProvider } from './services.tsx';
import { applyTheme, preferences } from './workbench/preferences.ts';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
applyTheme(preferences.getState().theme);
if (desktop) document.documentElement.classList.add('desktop-app');

const services = await createStudioServices();
const router = createStudioRouter(services);

createRoot(root).render(
  <StrictMode>
    <LocaleProvider>
      <ServicesProvider services={services}>
        {services.sessionMissing ? <SessionMissingView /> : <RouterProvider router={router} />}
      </ServicesProvider>
    </LocaleProvider>
  </StrictMode>,
);
