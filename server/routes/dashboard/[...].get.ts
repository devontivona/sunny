import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { defineEventHandler, setResponseHeader, setResponseStatus } from 'nitro/h3';
import { logger } from '../../../src/logger.js';

/**
 * Serve the dashboard SPA (web-dashboard D-WD1). The Vite build emits a static
 * bundle to `app/dist`; this serves it from disk AT RUNTIME (not via Nitro's
 * build-time `publicAssets`) so the gateway's Nitro/WDK build stays fully
 * decoupled from the Vite build — it never needs `app/dist` to exist at build
 * time, only at request time. Unknown paths fall back to `index.html` so hash
 * deep links don't 404. The more-specific `/dashboard/api/**` route wins over
 * this catch-all, so the JSON API is unaffected.
 */

const log = logger('dashboard:spa');
const DIST = join(process.cwd(), 'app', 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.map': 'application/json; charset=utf-8',
};

function extOf(p: string): string {
  const i = p.lastIndexOf('.');
  return i < 0 ? '' : p.slice(i).toLowerCase();
}

export default defineEventHandler((event) => {
  // In the unified Vite+Nitro setup (NITRO_VITE=1) the Vite dev/build pipeline
  // serves the SPA (with HMR in dev) — this disk-serve route is only for the
  // standalone Nitro gateway. Bow out so Nitro hands the request to Vite.
  if (process.env.NITRO_VITE === '1') {
    setResponseStatus(event, 404);
    return '';
  }
  if (!existsSync(DIST)) {
    setResponseStatus(event, 503);
    setResponseHeader(event, 'content-type', 'text/plain');
    return 'dashboard SPA not built — run `npm run dashboard:build`';
  }

  // Subpath after /dashboard/, sans query.
  const rel = new URL(event.path, 'http://localhost').pathname.replace(/^\/dashboard\/?/, '');
  // Resolve within DIST and guard against path traversal.
  const candidate = normalize(join(DIST, rel));
  const indexHtml = join(DIST, 'index.html');

  let file = indexHtml;
  if (rel && candidate.startsWith(DIST) && existsSync(candidate) && statSync(candidate).isFile()) {
    file = candidate;
  }

  const ext = extOf(file);
  setResponseHeader(event, 'content-type', TYPES[ext] ?? 'application/octet-stream');
  // Fingerprinted assets are immutable; the HTML shell must always revalidate.
  if (file !== indexHtml && rel.startsWith('assets/')) {
    setResponseHeader(event, 'cache-control', 'public, max-age=31536000, immutable');
  } else {
    setResponseHeader(event, 'cache-control', 'no-cache');
  }
  try {
    return readFileSync(file);
  } catch (err) {
    log.error('failed to read SPA asset', { file, err: String(err) });
    setResponseStatus(event, 500);
    return 'error';
  }
});
