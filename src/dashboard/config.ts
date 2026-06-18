/**
 * Dashboard configuration (web-dashboard D-WD4/5). The dashboard is served by the
 * gateway's Nitro process (folded in — see design.md D-WD1), so it has no port/
 * host/bind of its own. Secrets are env-only (D-PS5).
 */
export type DashboardMode =
  | 'auth' // session secret set → full iMessage-approval gate (prod)
  | 'open' // DASHBOARD_DEV_OPEN=1, no secret → open access (local dev only)
  | 'unconfigured'; // no secret, no dev-open → dashboard disabled, default-deny

export interface DashboardConfig {
  mode: DashboardMode;
  /** HMAC secret for signing session cookies; null unless mode === 'auth'. */
  sessionSecret: string | null;
  /** Public base URL used to build owner-facing approve links. */
  publicUrl: string;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const REQUEST_TTL_MS = 10 * 60 * 1000; // 10 minutes

export const ttl = { session: SESSION_TTL_MS, request: REQUEST_TTL_MS };

export function loadDashboardConfig(): DashboardConfig {
  const sessionSecret = process.env.DASHBOARD_SESSION_SECRET?.trim() || null;
  const devOpen = process.env.DASHBOARD_DEV_OPEN === '1';
  const mode: DashboardMode = sessionSecret ? 'auth' : devOpen ? 'open' : 'unconfigured';
  const publicUrl = (process.env.DASHBOARD_PUBLIC_URL ?? 'https://sunny.waywardlane.com').replace(
    /\/+$/,
    '',
  );
  return { mode, sessionSecret, publicUrl };
}
