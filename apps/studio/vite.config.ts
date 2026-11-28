import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

// `pnpm dev --live` sets `CORRAL_SERVER=http://127.0.0.1:4317` so Studio hot-reloads against
// the local server. That server must allow this origin (`--allow-origin http://localhost:5173`).
const server = process.env.CORRAL_SERVER;

/** Marks the page as served by the local server, as the server does for its own build. */
const serverRuntime: Plugin = {
  name: 'corral-server-runtime',
  transformIndexHtml: (html) =>
    html.replace('<head>', '<head><meta name="corral-runtime" content="server">'),
};

const fontsStayFiles = (file: string) => (file.endsWith('.woff2') ? false : undefined);

export default defineConfig({
  plugins: [react(), tailwindcss(), ...(server ? [serverRuntime] : [])],
  server: {
    port: 5173,
    ...(server ? { proxy: { '/api': { target: server, changeOrigin: true } } } : {}),
  },
  // Opening the lazy file viewer must not restart the in-memory demo runtime.
  optimizeDeps: { include: ['@pierre/diffs/react'] },
  build: {
    assetsInlineLimit: fontsStayFiles,
    rolldownOptions: {
      // The desktop's annotation overlay is its own page: annotate.html at the build's root,
      // served by the desktop alone (features/browser-annotate.md 계약, decision 44).
      input: { main: 'index.html', annotate: 'annotate.html' },
    },
  },
});
