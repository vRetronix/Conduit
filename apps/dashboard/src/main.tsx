// First: Zod must not probe for eval under the renderer's CSP (see the module).
import '@conduit/shared/app/zod-jitless';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/index.css';
import { applyCachedAppearance } from './theme/appearance';

// The last appearance seen in this window, before the first frame (the backend's saved value follows).
applyCachedAppearance();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
