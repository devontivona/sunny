import { defineNitroConfig } from 'nitro/config';

// Nitro is the build system that compiles WDK's "use workflow"/"use step"
// directives (via the workflow/nitro module). Routes live under server/,
// durable workflows under workflows/. The Postgres world is started by the
// startup plugin on server init.
export default defineNitroConfig({
  compatibilityDate: '2026-06-16',
  serverDir: './server',
  modules: ['workflow/nitro'],
  plugins: ['plugins/startup.ts'],
  // The workflow/SWC compilation rewrites the `.swc/` cache (incl. `.swc/.gitignore`)
  // on every build. The dev watcher would otherwise see that as a source change and
  // rebuild → which rewrites `.swc/` → an infinite rebuild loop. Ignore build caches.
  watchOptions: {
    ignored: [/[\\/]\.swc[\\/]/, /[\\/]\.output[\\/]/, /[\\/]\.nitro[\\/]/],
  },
});
