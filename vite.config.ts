import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server needs a websocket for hot reload; production builds get the strict policy:
// the page may only talk to its own origin, so bank data has nowhere to go.
const strictCsp = (): Plugin => ({
  name: 'strict-csp',
  apply: 'build',
  transformIndexHtml: (html) => html.replace(' ws://localhost:*', ''),
});

export default defineConfig({
  // relative paths: the same build works at a site's root or under a path, e.g. GitHub Pages' /pwlb-forecasts/
  base: './',
  plugins: [react(), strictCsp()],
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000 },
  server: { port: 5173 },
});
