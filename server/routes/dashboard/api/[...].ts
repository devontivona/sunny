import { and, desc, eq } from 'drizzle-orm';
import {
  defineEventHandler,
  deleteCookie,
  getCookie,
  getHeader,
  getQuery,
  getRequestIP,
  setCookie,
  setResponseHeader,
  setResponseStatus,
  type H3Event,
} from 'nitro/h3';
import { getRuntime } from '../../../../src/runtime.js';
import { messages } from '../../../../src/db/schema.js';
import { logger } from '../../../../src/logger.js';
import { DashboardData } from '../../../../src/dashboard/data.js';
import { AuthStore } from '../../../../src/dashboard/auth/store.js';
import {
  constantTimeEqual,
  signSession,
  verifySession,
} from '../../../../src/dashboard/auth/session.js';
import {
  loadDashboardConfig,
  ttl,
  type DashboardConfig,
} from '../../../../src/dashboard/config.js';

/**
 * The web dashboard's read-only JSON API + iMessage-approval auth, served inside
 * the gateway's Nitro process (web-dashboard D-WD1; folded in from the former
 * standalone Express service). One catch-all handles `/dashboard/api/**`.
 *
 * Because it shares the gateway runtime, it gets the db + `gateway.send()` in
 * process — so the owner approval prompt is sent by a direct in-process call
 * (using a fixed owner-only template), replacing the old cross-process internal
 * notify endpoint. Default-deny still holds: nothing private is served without a
 * valid session, and with no session secret configured the dashboard is disabled
 * unless DASHBOARD_DEV_OPEN=1 (local dev).
 */

const log = logger('dashboard');
const SESSION_COOKIE = 'dash_session';
const PENDING_COOKIE = 'dash_pending';
const STARTED_AT = Date.now();

type AuthState =
  | { state: 'authenticated' }
  | { state: 'open' }
  | { state: 'unconfigured' }
  | { state: 'anonymous' }
  | { state: 'pending'; requestId: string; deviceHint: string };

// Per-IP rate limit for approval requests (module-level; persists across calls).
const reqHits = new Map<string, number[]>();
function rateLimited(ip: string, max = 5, windowMs = 10 * 60_000): boolean {
  const now = Date.now();
  const hits = (reqHits.get(ip) ?? []).filter((t) => now - t < windowMs);
  hits.push(now);
  reqHits.set(ip, hits);
  return hits.length > max;
}

function cookieOpts(cfg: DashboardConfig, maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cfg.mode === 'auth',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  };
}

function deviceHint(event: H3Event): string {
  const ua = String(getHeader(event, 'user-agent') ?? 'unknown');
  const platform = /Mac|iPhone|iPad|Android|Windows|Linux/.exec(ua)?.[0] ?? 'device';
  const browser = /Firefox|Edg|Chrome|Safari/.exec(ua)?.[0] ?? 'browser';
  return `${platform}/${browser} · ${getRequestIP(event, { xForwardedFor: true }) ?? '?'}`;
}

export default defineEventHandler(async (event) => {
  const cfg = loadDashboardConfig();
  const { db, config, gateway } = await getRuntime();
  const data = new DashboardData(db, config, STARTED_AT);
  const auth = new AuthStore(db);

  // Subpath after /dashboard/api/ (no query string).
  const path = new URL(event.path, 'http://localhost').pathname.replace(/^\/dashboard\/api\/?/, '');
  const method = event.method;
  const query = getQuery(event);

  // --- auth resolution (mints sessions for the approved, polling browser) ---
  async function resolveAuth(): Promise<AuthState> {
    if (cfg.mode === 'open') return { state: 'open' };
    if (cfg.mode === 'unconfigured') return { state: 'unconfigured' };

    const token = getCookie(event, SESSION_COOKIE);
    if (token && cfg.sessionSecret) {
      const sid = verifySession(token, cfg.sessionSecret);
      if (sid) {
        const session = await auth.getValidSession(sid);
        if (session) {
          void auth.touchSession(sid);
          return { state: 'authenticated' };
        }
      }
      deleteCookie(event, SESSION_COOKIE, { path: '/' });
    }

    const pendingId = getCookie(event, PENDING_COOKIE);
    if (pendingId) {
      const row = await auth.getRequest(pendingId);
      if (row) {
        if (row.status === 'pending' && row.expiresAt.getTime() <= Date.now()) {
          await auth.setRequestStatus(row.id, 'expired');
          deleteCookie(event, PENDING_COOKIE, { path: '/' });
          return { state: 'anonymous' };
        }
        if (row.status === 'approved' && cfg.sessionSecret) {
          const session = await auth.createSession(row.deviceHint ?? '');
          await auth.setRequestStatus(row.id, 'consumed', session.id);
          setCookie(
            event,
            SESSION_COOKIE,
            signSession(session.id, cfg.sessionSecret),
            cookieOpts(cfg, ttl.session),
          );
          deleteCookie(event, PENDING_COOKIE, { path: '/' });
          log.info('session issued', { sessionId: session.id });
          return { state: 'authenticated' };
        }
        if (row.status === 'pending') {
          return { state: 'pending', requestId: row.id, deviceHint: row.deviceHint ?? '' };
        }
      }
      deleteCookie(event, PENDING_COOKIE, { path: '/' });
    }
    return { state: 'anonymous' };
  }

  const json = (status: number, body: unknown) => {
    setResponseStatus(event, status);
    return body;
  };

  // === Auth routes (ungated) ==============================================

  if (path === 'auth/status' && method === 'GET') {
    return await resolveAuth();
  }

  if (path === 'auth/request' && method === 'POST') {
    if (cfg.mode !== 'auth') return json(400, { error: 'auth not configured' });
    const ip = getRequestIP(event, { xForwardedFor: true }) ?? 'unknown';
    if (rateLimited(ip)) return json(429, { error: 'too many requests; try again later' });
    try {
      const existingId = getCookie(event, PENDING_COOKIE);
      let row = existingId ? await auth.getRequest(existingId) : null;
      if (!row || row.status !== 'pending' || row.expiresAt.getTime() <= Date.now()) {
        row = await auth.createRequest(deviceHint(event));
        const approveUrl = `${cfg.publicUrl}/dashboard/api/auth/approve?rid=${row.id}&secret=${encodeURIComponent(row.secret)}`;
        await notifyOwner(approveUrl, row.deviceHint ?? '', row.id);
      }
      setCookie(event, PENDING_COOKIE, row.id, cookieOpts(cfg, ttl.request));
      return { requestId: row.id, deviceHint: row.deviceHint ?? '' };
    } catch (err) {
      log.error('access request failed', { err: String(err) });
      return json(502, { error: 'could not message the owner for approval' });
    }
  }

  if (path === 'auth/approve' && method === 'GET') {
    const rid = String(query.rid ?? '');
    const secret = String(query.secret ?? '');
    const row = rid ? await auth.getRequest(rid) : null;
    setResponseHeader(event, 'content-type', 'text/html; charset=utf-8');
    const fail = (msg: string) => {
      setResponseStatus(event, 400);
      return approvalPage(msg, false);
    };
    if (!row || !secret || !constantTimeEqual(secret, row.secret))
      return fail('Invalid or unknown approval link.');
    if (row.status === 'pending' && row.expiresAt.getTime() <= Date.now()) {
      await auth.setRequestStatus(row.id, 'expired');
      return fail('This approval link has expired. Start over from the device you were pairing.');
    }
    if (row.status !== 'pending' && row.status !== 'approved')
      return fail('This approval link was already used or is no longer valid.');
    await auth.approveRequest(row.id);
    log.info('access request approved by owner', { requestId: row.id });
    return approvalPage(
      'Approved ✓ — return to the device you were pairing; it will continue automatically.',
      true,
    );
  }

  if (path === 'auth/logout' && method === 'POST') {
    const token = getCookie(event, SESSION_COOKIE);
    if (token && cfg.sessionSecret) {
      const sid = verifySession(token, cfg.sessionSecret);
      if (sid) await auth.revokeSession(sid);
    }
    deleteCookie(event, SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  // === Gated read-only data ===============================================

  const state = await resolveAuth();
  if (state.state !== 'authenticated' && state.state !== 'open') {
    return json(401, { error: 'unauthorized' });
  }

  try {
    if (method === 'GET') {
      switch (true) {
        case path === 'memory/core':
          return data.core();
        case path === 'memory/topics':
          return data.topics();
        case path.startsWith('memory/topics/'): {
          const name = decodeURIComponent(path.slice('memory/topics/'.length));
          const doc = data.topic(name);
          return doc ?? json(404, { error: 'topic not found' });
        }
        case path === 'conversation/threads':
          return { threads: await data.threads() };
        case path === 'conversation/thread': {
          const id = String(query.id ?? '');
          if (!id) return json(400, { error: 'missing thread id' });
          return await data.thread(id);
        }
        case path === 'conversation/search':
          return await data.search(String(query.q ?? ''));
        case path === 'tools':
          return data.tools();
        case path === 'credentials':
          return data.credentials();
        case path === 'skills':
          return data.skills();
        case path.startsWith('skills/'): {
          const name = decodeURIComponent(path.slice('skills/'.length));
          const detail = data.skill(name);
          return detail ?? json(404, { error: 'skill not found' });
        }
        case path === 'schedules':
          return { schedules: await data.schedules() };
        case path === 'jobs':
          return await data.jobs();
        case path === 'activity':
          return await data.activity();
        case path === 'health':
          return await data.health();
      }
    }
  } catch (err) {
    log.error('api error', { path, err: String(err) });
    return json(500, { error: 'internal error' });
  }

  return json(404, { error: 'not found' });

  // --- in-process owner notify (fixed template, owner-only) ----------------
  async function notifyOwner(approveUrl: string, hint: string, requestId: string): Promise<void> {
    const recentOwner = await db
      .select()
      .from(messages)
      .where(and(eq(messages.isOwner, true), eq(messages.role, 'user')))
      .orderBy(desc(messages.timestamp))
      .limit(25);
    const ownerThread = recentOwner.find((m) => m.threadId.split(':')[2] !== 'g')?.threadId;
    if (!ownerThread)
      throw new Error('no owner DM thread known yet (owner must message Sunny first)');
    // Conversational, in Sunny's voice — still a fixed, owner-only template
    // (only the device hint + approve link are interpolated; never arbitrary text).
    const text =
      `Hey — a new device (${hint || 'unknown'}) just asked to open your dashboard. ` +
      `If that's you, tap to let it in (the link expires soon):\n${approveUrl}\n\n` +
      `If it wasn't you, just ignore this and it'll lapse.`;
    await gateway.send(ownerThread, { text }, { persist: false });
    log.info('sent dashboard approval prompt to owner', { requestId, ownerThread });
  }
});

/**
 * Minimal owner-facing approval result page (no app assets needed). Matches the
 * dashboard's TUI language: GitHub Dark, one monospace size, no card/border/radius.
 */
function approvalPage(message: string, ok: boolean): string {
  const color = ok ? '#3fb950' : '#f85149';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark"><title>サニー</title>
<style>:root{color-scheme:dark}html,body{margin:0}
body{min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:24px;background:#0d1117;color:#e6edf3;font-family:ui-monospace,"JetBrains Mono","Fira Code",monospace;font-size:15px;line-height:24px}
.wrap{max-width:480px}.m{font-weight:700;letter-spacing:.2em;margin-bottom:12px}.t{color:${color}}</style></head>
<body><div class="wrap"><div class="m">サニー</div><div class="t">${escapeHtml(message)}</div></div></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
