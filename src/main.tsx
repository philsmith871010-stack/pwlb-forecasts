import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/inter/800.css';
import 'bootstrap-icons/font/bootstrap-icons.css';
import './theme/base.css';
import { App } from './ui/App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Dev-only handle for automated UI checks; stripped from production builds.
if (import.meta.env.DEV) void import('./state/store').then((m) => { (window as unknown as { __store: unknown }).__store = m.useStore; });
