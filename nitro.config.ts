import { defineNitroConfig } from 'nitro/config';

// Nitro is the build system that compiles WDK's "use workflow"/"use step"
// directives (via the workflow/nitro module). Routes live under server/,
// durable workflows under workflows/. The Postgres world is started by the
// startup plugin on server init.
// In Vite mode (the unified `vite.config.unified.ts` entry, NITRO_VITE=1), the
// `workflow()` Vite plugin already registers the WDK Nitro module itself, so we
// must NOT also list it here or it double-applies. Standalone Nitro (the current
// gateway, `nitro dev`/`nitro build`) needs it listed.
const viteMode = process.env.NITRO_VITE === '1';

export default defineNitroConfig({
  compatibilityDate: '2026-06-16',
  serverDir: './server',
  modules: viteMode ? [] : ['workflow/nitro'],
  plugins: ['plugins/startup.ts'],
  // Production build (`vite build --config vite.config.unified.ts` + `node .output/...`,
  // the devbox serve mode as of 2026-07-05): the 1Password SDK must be file-traced, not
  // inlined — `@1password/sdk-core` resolves a sibling `core_bg.wasm` via `__dirname`,
  // which does not exist in the bundled ESM output (boot crashloop when inlined).
  externals: {
    external: ['@1password/sdk', '@1password/sdk-core'],
  },
  // The workflow/SWC compilation rewrites the `.swc/` cache (incl. `.swc/.gitignore`)
  // on every build. The dev watcher would otherwise see that as a source change and
  // rebuild → which rewrites `.swc/` → an infinite rebuild loop. Ignore build caches.
  //
  // Also ignore the dashboard's Vite SPA tree `app/` (web-dashboard D-WD1): the
  // gateway serves `app/dist` from disk at runtime but imports nothing from it, so
  // a `vite` dev server / `dashboard:build` / `design:export` writing there must
  // NOT churn the gateway's workflow/nitro build (the Vite-vs-WDK entanglement we
  // keep decoupled). `src/dashboard/` is real gateway code now (the folded-in API)
  // and is intentionally watched.
  watchOptions: {
    ignored: [
      /[\\/]\.swc[\\/]/,
      /[\\/]\.output[\\/]/,
      /[\\/]\.nitro[\\/]/,
      /[\\/]app[\\/]/,
      // Claude Code worktrees/scratch: a git worktree checked out under .claude/ put
      // thousands of "source" files in the dev watcher's view and wedged it into a
      // permanent rebuild loop (2026-07-05 — incl. one mid-turn production crash).
      /[\\/]\.claude[\\/]/,
    ],
  },
});
