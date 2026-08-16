import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {ensureServiceWorker} from './lib/pwa';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Registered after the first render is scheduled, so fetching and installing the
// worker never competes with painting the app. `ensureServiceWorker` no-ops on
// browsers without service worker support and resolves either way, so nothing
// downstream needs to branch on it.
void ensureServiceWorker();
