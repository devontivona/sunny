import { defineEventHandler, getRequestURL, proxyRequest } from 'nitro/h3';

/**
 * Dev-only: same-origin proxy for the Agentation annotation toolbar.
 *
 * The toolbar (mounted in dev via app/main.tsx) syncs to a base `endpoint`,
 * calling `${endpoint}/health`, `${endpoint}/sessions`, etc. The Agentation
 * server runs on the home box at localhost:4747, which a REMOTE browser viewing
 * the tunnel can't reach. Pointing the toolbar at `<origin>/__agentation` routes
 * its requests here (same-origin, no CORS), and we forward them to the local
 * Agentation server — so annotations placed over the tunnel reach the MCP server
 * (and thus the agent). Carries only the toolbar's own routes; it holds design
 * annotations, not Sunny state.
 */
export default defineEventHandler((event) => {
  const url = getRequestURL(event);
  const subpath = url.pathname.replace(/^\/__agentation/, '') || '/';
  return proxyRequest(event, `http://127.0.0.1:4747${subpath}${url.search}`);
});
