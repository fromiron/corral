import './csp.ts';
import { enMessages } from '@corral/react';
import { RouterProvider } from '@tanstack/react-router';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { SessionMissingView } from './pages/RootLayout.tsx';
import { createStudioRouter } from './router.tsx';
import { createStudioServices, ServicesProvider } from './services.tsx';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

const services = await createStudioServices();
const router = createStudioRouter(services);

createRoot(root).render(
  <StrictMode>
    <IntlProvider
      locale="en"
      messages={enMessages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <ServicesProvider services={services}>
        {services.sessionMissing ? <SessionMissingView /> : <RouterProvider router={router} />}
      </ServicesProvider>
    </IntlProvider>
  </StrictMode>,
);
