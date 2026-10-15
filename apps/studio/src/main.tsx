import { enMessages } from '@corral/react';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { IntlProvider } from 'use-intl';
import { App } from './App.tsx';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <IntlProvider
      locale="en"
      messages={enMessages}
      timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
    >
      <App />
    </IntlProvider>
  </StrictMode>,
);
