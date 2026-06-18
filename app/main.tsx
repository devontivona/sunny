import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Agentation } from 'agentation';
import './index.css';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
    {/* Dev-only annotation toolbar. `import.meta.env.DEV` is statically false in
        production builds, so Vite tree-shakes Agentation out of the prod bundle.
        `endpoint` syncs annotations to the Agentation server via a same-origin
        proxy (server/routes/__agentation) so it works over the tunnel, not just
        on localhost. Without an endpoint the toolbar only saves to localStorage. */}
    {import.meta.env.DEV && <Agentation endpoint={`${window.location.origin}/__agentation`} />}
  </StrictMode>,
);
