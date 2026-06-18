import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Front-end build for the web dashboard (D-WD1). Deliberately decoupled from the
// gateway's Nitro/WDK build: `vite build` emits a static SPA under `app/dist`
// that the gateway's Nitro process serves at runtime (server/routes/dashboard/).
// In dev, `vite` runs the HMR dev server and proxies the JSON API to the gateway.
const GATEWAY_PORT = process.env.PORT ?? '8787';

export default defineConfig({
  root: 'app',
  // The SPA is mounted under /dashboard on the gateway host.
  base: '/dashboard/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/dashboard/api': { target: `http://localhost:${GATEWAY_PORT}`, changeOrigin: true },
    },
  },
});
