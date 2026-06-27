import { readFileSync } from 'node:fs';
import { and, desc, eq } from 'drizzle-orm';
import {
  createEventStream,
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
import { auth as completeMcpOAuth } from '@ai-sdk/mcp';
import { getRun } from 'workflow/api';
import type { UIMessageChunk } from 'ai';
import { getRuntime } from '../../../../src/runtime.js';
import { getLiveBus, type LiveRun } from '../../../../src/observability/live.js';
import { defaultRedactor } from '../../../../src/observability/redact.js';
import { messages } from '../../../../src/db/schema.js';
import { logger } from '../../../../src/logger.js';
import { DashboardData } from '../../../../src/dashboard/data.js';
import { getMcpServer } from '../../../../src/mcp/registry.js';
import { SunnyOAuthProvider, findOAuthServerByState } from '../../../../src/mcp/oauth.js';
import {
  contentTypeForName,
  isWithinMediaRoot,
  renderableMedia,
} from '../../../../src/gateway/media.js';
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

  // MCP OAuth callback (mcp D-MCP5). Ungated: the third-party authorization server
  // redirects the owner's browser here with `?code&state` and NO session cookie. We
  // match the in-flight `state` to a registered server and complete the token exchange
  // (tokens are saved to the OAuth store, never surfaced). This is the completion half
  // of consent — `mcp_manage` initiates it (surfaces the consent link).
  if (path === 'mcp/oauth/callback' && method === 'GET') {
    setResponseHeader(event, 'content-type', 'text/html; charset=utf-8');
    const code = String(query.code ?? '');
    const state = String(query.state ?? '');
    if (!code || !state) {
      setResponseStatus(event, 400);
      return approvalPage('Missing authorization code or state.', false);
    }
    const serverName = findOAuthServerByState(config.runtimeDir, state);
    const entry = serverName ? getMcpServer(config.runtimeDir, serverName) : undefined;
    if (!serverName || !entry) {
      setResponseStatus(event, 400);
      return approvalPage('Unknown or expired authorization request (state mismatch).', false);
    }
    try {
      const provider = new SunnyOAuthProvider({
        runtimeDir: config.runtimeDir,
        serverName,
        serverUrl: entry.url,
      });
      await completeMcpOAuth(provider, {
        serverUrl: entry.url,
        authorizationCode: code,
        callbackState: state,
      });
      log.info('mcp oauth callback completed', { serverName });
      return approvalPage(
        `Authorized "${serverName}" ✓ — you can close this tab; its tools are ready.`,
        true,
      );
    } catch (err) {
      log.error('mcp oauth callback failed', { serverName, err: String(err) });
      setResponseStatus(event, 502);
      return approvalPage(
        'Could not complete authorization — ask Sunny to connect it again.',
        false,
      );
    }
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
        case path === 'mcp':
          return data.mcpServers();
        case path === 'skills':
          return data.skills();
        case path.startsWith('skills/'): {
          const name = decodeURIComponent(path.slice('skills/'.length));
          const detail = data.skill(name);
          return detail ?? json(404, { error: 'skill not found' });
        }
        case path === 'media': {
          // Authenticated media serving (messaging-media D-MM9): stream a row's
          // i-th renderable image from disk. Confined to the media root — never a
          // general file server — and only reachable past the auth gate above.
          const msg = String(query.msg ?? '');
          const i = Number(query.i ?? -1);
          if (!msg || !Number.isInteger(i) || i < 0) return json(400, { error: 'bad media ref' });
          const [row] = await db.select().from(messages).where(eq(messages.id, msg)).limit(1);
          if (!row) return json(404, { error: 'not found' });
          const ref = renderableMedia(row.payload)[i];
          if (!ref?.disk || !isWithinMediaRoot(config.runtimeDir, ref.disk)) {
            return json(404, { error: 'not found' });
          }
          try {
            const bytes = readFileSync(ref.disk);
            setResponseHeader(event, 'content-type', ref.mediaType || contentTypeForName(ref.disk));
            setResponseHeader(event, 'cache-control', 'private, max-age=300');
            return bytes;
          } catch {
            return json(404, { error: 'not found' });
          }
        }
        case path === 'schedules':
          return { schedules: await data.schedules() };
        case path === 'jobs':
          return await data.jobs();
        // Live observability (live-conversation-streaming): the active-runs snapshot
        // for the home indicator, and a read-only SSE stream of a run's UIMessageChunks
        // for the live view. Both sit behind the same auth gate as everything below.
        case path === 'live/active':
          return await data.activeRuns();
        case path === 'live/stream': {
          const stream = createEventStream(event);
          // Thread-scoped subscription (the Conversation page): stream whatever turn
          // is/becomes active on the thread, so an open page needs no run id and has
          // no polling gap.
          const thread = String(query.thread ?? '');
          if (thread) {
            startThreadStream(stream, thread);
            return stream.send();
          }
          const run = String(query.run ?? '');
          if (!run) return json(400, { error: 'missing run or thread id' });
          if (String(query.kind ?? 'turn') === 'job')
            void startJobStream(stream, run, getHeader(event, 'last-event-id'));
          else startTurnStream(stream, run);
          return stream.send();
        }
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

// === Live SSE (live-conversation-streaming) =================================

type LiveStream = ReturnType<typeof createEventStream>;

/** Stream a Tier-1 turn's live chunks from the in-process bus over SSE: replay the
 *  buffered chunks (late-join), then tail until the turn finishes. Uses h3's
 *  `createEventStream` so headers/flushing/disconnect are handled by the framework
 *  (a raw ReadableStream Response did not reliably flush through the dev pipeline). */
function startTurnStream(stream: LiveStream, runId: string): void {
  const bus = getLiveBus();
  let closed = false;
  const unsub = bus.subscribeTurn(runId, (ev) => {
    if (closed) return;
    if (ev.type === 'chunk') void stream.push({ event: 'chunk', data: JSON.stringify(ev.chunk) });
    else if (ev.type === 'status')
      void stream.push({ event: 'status', data: JSON.stringify(ev.run) });
    else {
      void stream.push({ event: 'done', data: JSON.stringify(ev.run) }).then(() => stream.close());
    }
  });
  stream.onClosed(() => {
    closed = true;
    unsub();
  });
  // Unknown/already-reaped run: tell the client to fall back to the persisted record
  // immediately rather than hang.
  if (!bus.getTurn(runId)) {
    void stream.push({ event: 'done', data: JSON.stringify({ runId }) }).then(() => stream.close());
  }
}

/** Stream a whole thread's live turns over SSE (the Conversation page): replays a
 *  currently-running turn, then streams it and every later turn on the thread. Stays
 *  open across turns — `done` is forwarded but the connection is NOT closed, so the
 *  next message on the thread streams instantly without a reconnect. */
function startThreadStream(stream: LiveStream, threadId: string): void {
  const bus = getLiveBus();
  let closed = false;
  const unsub = bus.subscribeThread(threadId, (ev) => {
    if (closed) return;
    if (ev.type === 'chunk') void stream.push({ event: 'chunk', data: JSON.stringify(ev.chunk) });
    else if (ev.type === 'status')
      void stream.push({ event: 'status', data: JSON.stringify(ev.run) });
    else void stream.push({ event: 'done', data: JSON.stringify(ev.run) });
  });
  stream.onClosed(() => {
    closed = true;
    unsub();
  });
}

/** Stream a Tier-2 job's live chunks from its durable WDK run stream over SSE:
 *  replay the last chunks (negative startIndex), then tail until the run completes. */
async function startJobStream(
  stream: LiveStream,
  runId: string,
  lastEventId?: string,
): Promise<void> {
  const redactor = defaultRedactor();
  let closed = false;
  let reader: ReadableStreamDefaultReader<UIMessageChunk> | null = null;
  stream.onClosed(() => {
    closed = true;
    // Cancel the durable-run reader promptly: otherwise a disconnected client keeps
    // the WDK stream subscribed while it's blocked in read() (a long idle job would
    // hold it until the next chunk / completion).
    void reader?.cancel().catch(() => {});
  });
  // Resume after the last chunk the client already received. EventSource sends the
  // `Last-Event-ID` header on auto-reconnect, so a reconnect (e.g. a tunnel idle-drop
  // during a long job) continues the fold instead of replaying+duplicating chunks the
  // client already folded. A fresh connect starts at 0 (the client needs the opening
  // chunks for readUIMessageStream to assemble the message).
  const resumeFrom = lastEventId != null && /^\d+$/.test(lastEventId) ? Number(lastEventId) + 1 : 0;

  // Reflect the real run status on connect so a completed run viewed historically
  // doesn't flash "live".
  let initStatus: LiveRun['status'] = 'running';
  try {
    const s = await getRun<unknown>(runId).status;
    initStatus = s === 'failed' ? 'errored' : s === 'completed' ? 'finished' : 'running';
  } catch {
    /* default running */
  }
  await stream.push({ event: 'status', data: JSON.stringify(await jobRunMeta(runId, initStatus)) });
  try {
    reader = getRun<unknown>(runId)
      .getReadable<UIMessageChunk>({ startIndex: resumeFrom })
      .getReader();
    let idx = resumeFrom;
    try {
      for (;;) {
        if (closed) break;
        const { done, value } = await reader.read();
        if (done) break;
        // `id` is the absolute chunk index, so a reconnect resumes right after it.
        await stream.push({
          id: String(idx),
          event: 'chunk',
          data: JSON.stringify(redactor.redact(value)),
        });
        idx++;
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
    }
  } catch (err) {
    log.warn('live job stream read failed', { runId, err: String(err) });
  }
  let status: 'finished' | 'errored' = 'finished';
  try {
    status = (await getRun<unknown>(runId).status) === 'failed' ? 'errored' : 'finished';
  } catch {
    /* keep optimistic 'finished' */
  }
  if (!closed) {
    await stream.push({ event: 'done', data: JSON.stringify(await jobRunMeta(runId, status)) });
    await stream.close();
  }
}

/** Build a job's live descriptor from the WDK run (best-effort metadata). */
async function jobRunMeta(runId: string, status: LiveRun['status']): Promise<LiveRun> {
  const run = getRun<unknown>(runId);
  let label = 'Background job';
  let startedAt = new Date(0);
  try {
    const name = await run.workflowName;
    label = name.endsWith('runScheduledJob') ? 'Scheduled job' : 'Background job';
  } catch {
    /* default label */
  }
  try {
    startedAt = (await run.startedAt) ?? (await run.createdAt) ?? startedAt;
  } catch {
    /* default startedAt */
  }
  return {
    runId,
    kind: 'job',
    threadId: null,
    label,
    status,
    startedAt: startedAt.toISOString(),
    steps: 0,
    model: 'claude-opus-4-8',
    effort: 'high',
    usage: null,
    traceUrl: null,
  };
}

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
