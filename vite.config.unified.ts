import { defineConfig } from 'vite';
import { nitro } from 'nitro/vite';
import { workflow } from 'workflow/vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Unified dev/serve entry (web-dashboard D-WD1, revised): one server = the React
// SPA (Vite HMR) + the gateway's Nitro routes (hot-reload) + WDK (`use workflow`
// transform + rebuild). Vite hosts Nitro via the Nitro Vite plugin; `workflow()`
// registers the WDK Nitro module (so nitro.config.ts must NOT also list it — see
// nitro.config.ts, gated on NITRO_VITE). Run via `npm run dev:unified`.
//
// Nitro reads nitro.config.ts (serverDir ./server, plugins/startup.ts, compat
// date) since vite root = project root. The SPA is served at the ROOT `/` (root
// index.html → /app/main.tsx): `/` is unmatched by Nitro, so Nitro hands it to
// Vite, which serves it with HMR. Nitro keeps `/dashboard/api`, `/webhooks/*`,
// `/health`, `/.well-known/workflow/*`. (A matched Nitro route that 404s does
// NOT fall back to Vite — only genuinely unmatched paths do — so the SPA must
// live at a path Nitro doesn't claim.)
const PORT = Number(process.env.PORT ?? 8789);
// On a Cloudflare tunnel the HMR websocket must target the public origin over
// wss:443, or it silently falls back to localhost. Off for plain-localhost dev.
const tunnelHmr = process.env.TUNNEL_HMR === '1';

export default defineConfig({
  base: '/',
  plugins: [nitro(), react(), tailwindcss(), workflow()],
  // Isolate this service's Nitro/WDK build dir so it can run alongside the legacy
  // standalone gateway (which uses the default node_modules/.nitro) from the SAME
  // project dir without corrupting each other's build output (devbox hazard:
  // two services must not share a build dir). The workflow build lives under it too.
  nitro: {
    buildDir: 'node_modules/.nitro-unified',
    // Production build (devbox build-and-serve, 2026-07-05): the 1Password SDK must be
    // file-traced into .output/server/node_modules, not inlined — `@1password/sdk-core`
    // resolves a sibling `core_bg.wasm` via `__dirname`, which doesn't exist in bundled
    // ESM output (boot crashloop when inlined). Mirrored in nitro.config.ts for the
    // standalone build; in Vite mode THIS block is the one that's read.
    externals: {
      external: ['@1password/sdk', '@1password/sdk-core'],
    },
  },
  // No `build.outDir` override: the Nitro-Vite plugin serves the client build
  // dir as public assets, and pointing it at the pre-existing `app/dist` (the
  // standalone prod build) would shadow Vite's dev SPA with a stale bundle. In
  // dev there is no built dir, so Vite serves + transforms index.html (HMR).
  server: {
    port: PORT,
    host: true,
    allowedHosts: ['.waywardlane.com', 'localhost'],
    ...(tunnelHmr ? { hmr: { protocol: 'wss', clientPort: 443 } } : {}),
  },
  // Belt for the nitro.externals suspenders: the Vite server build must also treat the
  // 1Password SDK as external (see the nitro block above).
  ssr: {
    external: ['@1password/sdk', '@1password/sdk-core'],
  },
});
