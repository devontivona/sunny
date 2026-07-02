/**
 * Media storage + helpers (messaging-media D-MM2/3/4).
 *
 * Inbound attachment bytes are fetched promptly on webhook receipt and persisted
 * under `~/.sunny/media/inbound/<message-id>/<n>.<ext>` (Sendblue URLs expire, so
 * we never rely on them later). Outbound files Sunny sends are persisted twice:
 * a durable copy under `media/outbound/<token>.<ext>` (rendered in the dashboard
 * via its authenticated route) and a short-TTL copy under `media/outbox/<token>.<ext>`
 * served by the UNAUTHENTICATED public route for Sendblue to fetch server-side.
 *
 * Media bytes live OUTSIDE the `~/.sunny` git repo — they're data, not reviewable
 * config — so the whole `media/` tree is self-gitignored.
 *
 * The pure helpers here (type mapping, caps, name validation, outbound planning,
 * payload ref extraction) carry the logic the gateway/agent wire up, and are unit
 * tested without touching disk.
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';

/** Kinds of attachment, mirroring the transport's normalized `type`. */
export type AttachmentKind = 'image' | 'file' | 'video' | 'audio';

/** Direction of a persisted media file. */
export type MediaDirection = 'inbound' | 'outbound';

/**
 * A persisted-attachment reference carried in the stored `UIMessage` payload
 * (D-MM1). The bytes live on disk at `path`; the payload holds only the ref so
 * history replay never re-bills the bytes as tokens, nor re-fetches an expired
 * URL. `error` marks an attachment whose bytes could not be saved (still surfaced
 * to the model as a note, never silently dropped — D-MM2).
 */
export interface AttachmentRef {
  path: string | null;
  mediaType: string;
  kind: AttachmentKind;
  name: string;
  size: number;
  direction: MediaDirection;
  error?: string;
}

/** Caps for inlining inbound media into the model context (D-MM3). */
export const MEDIA = {
  /** Max attachments inlined per message; the rest degrade to a file-note. */
  maxInlineCount: 5,
  /**
   * Max RAW bytes inlined per attachment; larger files degrade to a file-note.
   * The Claude API limit is 10 MB *base64-encoded* per image; base64 inflates by
   * ~4/3, so ~7 MB of raw bytes stays under it. Images are downscaled before this
   * check (`prepareImageForModel`), so it's a safety net, rarely the active limit.
   */
  maxInlineBytes: 7 * 1024 * 1024,
  /** Downscale inlined images to this max long edge (px). Keeps dense text (e.g.
   * a business card) legible — the API's high-res ceiling is 2576px — while cutting
   * image tokens, which scale with dimensions. */
  imageMaxEdge: 2000,
  /** JPEG quality for downscaled/transcoded images. */
  imageQuality: 82,
  /** Below this raw size, an already-ingestible image is inlined as-is (no re-encode). */
  imageRecodeThreshold: 1024 * 1024,
  /** Public outbox lifetime — Sendblue fetches within seconds + a few retries. */
  outboxTtlMs: 24 * 60 * 60 * 1000,
} as const;

// --- type mapping ----------------------------------------------------------

/** Image MIME types Claude can ingest as vision (D-MM3). HEIC/HEIF are NOT here. */
const INGESTIBLE_IMAGE = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

const EXT_BY_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

const TYPE_BY_EXT: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  txt: 'text/plain',
};

/**
 * Whether and how the model can directly ingest a MIME type (D-MM3): images Claude
 * accepts → `image`, PDFs → `document`, everything else (incl. HEIC, video, audio,
 * archives) → null, meaning surface it as a saved-file note instead.
 */
export function modelIngestKind(mediaType: string): 'image' | 'document' | null {
  const t = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (INGESTIBLE_IMAGE.has(t)) return 'image';
  if (t === 'application/pdf') return 'document';
  return null;
}

const HEIC_TYPES = new Set(['image/heic', 'image/heif']);

/** Whether a MIME type is HEIC/HEIF (iPhone photos) — model can't ingest it directly. */
export function isHeic(mediaType: string): boolean {
  const t = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  return HEIC_TYPES.has(t);
}

/** Whether a declared media type is absent or the generic binary fallback — i.e. worth
 *  sniffing from the bytes. Transports (Sendblue) sometimes deliver a PDF/image unlabeled. */
export function isGenericBinaryType(mediaType: string | undefined | null): boolean {
  const t = mediaType?.toLowerCase().split(';')[0]?.trim();
  return !t || t === 'application/octet-stream' || t === 'binary/octet-stream';
}

/**
 * Recover a media type from a file's magic bytes (D-MM3 hardening). Transports don't
 * always label an attachment — Sendblue can deliver a PDF as `application/octet-stream`,
 * which then misses native ingestion and gets read as raw text (poisoning the durable
 * turn's Postgres write). When the declared type is missing/generic, sniff the leading
 * bytes so a PDF/image routes to native ingestion instead. Falls back to `fallback` when
 * the signature is unrecognized. Pure; unit-tested.
 */
export function sniffMediaType(bytes: Buffer, fallback = 'application/octet-stream'): string {
  const b = bytes;
  const at = (i: number, ...sig: number[]) => sig.every((v, k) => b[i + k] === v);
  if (b.length >= 4 && at(0, 0x25, 0x50, 0x44, 0x46)) return 'application/pdf'; // %PDF
  if (b.length >= 8 && at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (b.length >= 3 && at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (b.length >= 4 && at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif'; // GIF8
  // RIFF....WEBP
  if (b.length >= 12 && at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50))
    return 'image/webp';
  // ISO-BMFF `ftyp` box with a HEIC/HEIF brand.
  if (b.length >= 12 && at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = b.subarray(8, 12).toString('latin1');
    if (['heic', 'heix', 'heif', 'hevc', 'mif1', 'msf1'].includes(brand)) return 'image/heic';
  }
  return fallback;
}

/** Prepared image bytes ready to inline as a model content part. */
export interface PreparedImage {
  bytes: Buffer;
  mediaType: string;
}

/**
 * Prepare an inbound image for the model (D-MM3): downscale to the long-edge cap,
 * fix EXIF orientation, and re-encode as JPEG via the host's ImageMagick `convert`.
 * This keeps dense text legible while cutting image tokens (which scale with
 * dimensions) and keeps us well under the API's per-image size limit. iPhone HEIC
 * — which the model can't ingest at all — is always converted here.
 *
 *  - Already-ingestible image under `imageRecodeThreshold` → inlined as-is (no
 *    re-encode, no quality loss, no `convert` dependency).
 *  - Otherwise → resize-if-larger (`>`) + `-auto-orient` + JPEG re-encode.
 *  - HEIC/HEIF and `convert` is missing/failed → `null` (caller makes a file-note).
 *  - Non-HEIC and `convert` is missing/failed → fall back to the original bytes
 *    (they're already model-ingestible; the downscale was only an optimization).
 *
 * No new runtime dependency: `convert` (ImageMagick + libheif) is already on the host.
 */
export function prepareImageForModel(
  bytes: Buffer,
  mediaType: string,
  opts: { maxEdge?: number; quality?: number; recodeThreshold?: number } = {},
): PreparedImage | null {
  const heic = isHeic(mediaType);
  const recodeThreshold = opts.recodeThreshold ?? MEDIA.imageRecodeThreshold;
  // Small, already-ingestible image: pass through untouched.
  if (!heic && modelIngestKind(mediaType) === 'image' && bytes.length <= recodeThreshold) {
    return { bytes, mediaType };
  }
  const maxEdge = opts.maxEdge ?? MEDIA.imageMaxEdge;
  const quality = opts.quality ?? MEDIA.imageQuality;
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), 'sunny-img-'));
    const inPath = join(dir, `in.${extForMediaType(mediaType)}`);
    const outPath = join(dir, 'out.jpg');
    writeFileSync(inPath, bytes);
    // `>` resizes only when larger than the box; -auto-orient bakes in EXIF rotation
    // (iPhone photos are commonly rotated via metadata).
    execFileSync(
      'convert',
      [
        inPath,
        '-auto-orient',
        '-resize',
        `${maxEdge}x${maxEdge}>`,
        '-quality',
        String(quality),
        outPath,
      ],
      { stdio: 'ignore', timeout: 30_000 },
    );
    return { bytes: readFileSync(outPath), mediaType: 'image/jpeg' };
  } catch {
    // HEIC can't be inlined without conversion; a normal image still can.
    return heic ? null : { bytes, mediaType };
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* temp dir cleanup is best-effort */
      }
    }
  }
}

/** Map a MIME type to a kind for the normalized attachment. */
export function kindForMediaType(mediaType: string): AttachmentKind {
  const t = mediaType.toLowerCase();
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  return 'file';
}

/** A safe filesystem extension for a MIME type (best-effort; defaults to `bin`). */
export function extForMediaType(mediaType: string): string {
  const t = mediaType.toLowerCase().split(';')[0]?.trim() ?? '';
  if (EXT_BY_TYPE[t]) return EXT_BY_TYPE[t];
  const sub = t.split('/')[1]?.replace(/[^a-z0-9]/g, '') ?? '';
  return sub || 'bin';
}

/** Best-effort content-type for serving a stored file by its name/extension. */
export function contentTypeForName(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return TYPE_BY_EXT[ext] ?? 'application/octet-stream';
}

/** A `data:` URL for inlining bytes into a model file part. */
export function dataUrl(bytes: Buffer, mediaType: string): string {
  return `data:${mediaType};base64,${bytes.toString('base64')}`;
}

// --- paths -----------------------------------------------------------------

/**
 * The public base URL the host is reachable at (D-MM4) — used to build the media
 * links Sendblue fetches server-side. Reuses the dashboard's public URL (the same
 * ingress already operated for the webhook); `PUBLIC_BASE_URL` overrides.
 */
export function publicBaseUrl(): string {
  return (
    process.env.PUBLIC_BASE_URL ??
    process.env.DASHBOARD_PUBLIC_URL ??
    'https://sunny.waywardlane.com'
  ).replace(/\/+$/, '');
}

export function mediaRoot(runtimeDir: string): string {
  return join(runtimeDir, 'media');
}
const inboundDir = (rt: string) => join(mediaRoot(rt), 'inbound');
const outboundDir = (rt: string) => join(mediaRoot(rt), 'outbound');
const outboxDir = (rt: string) => join(mediaRoot(rt), 'outbox');

/** Sanitize an id used as a path segment (no traversal, no separators). */
function safeSegment(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, '_');
  return cleaned.replace(/^\.+/, '_') || 'x';
}

/**
 * Create the media dirs and self-gitignore the tree (idempotent). Called on boot.
 * A retention README marks inbound as durable-forever (cleanup deferred, D-MM4);
 * the outbox is the only TTL-cleaned dir.
 */
export function ensureMediaDirs(runtimeDir: string): void {
  for (const dir of [inboundDir(runtimeDir), outboundDir(runtimeDir), outboxDir(runtimeDir)]) {
    mkdirSync(dir, { recursive: true });
  }
  const gi = join(mediaRoot(runtimeDir), '.gitignore');
  if (!existsSync(gi)) writeFileSync(gi, '# Message media — data, never committed.\n*\n');
  const readme = join(mediaRoot(runtimeDir), 'README.md');
  if (!existsSync(readme)) {
    writeFileSync(
      readme,
      [
        '# Message media',
        '',
        'Persisted attachment bytes (messaging-media D-MM2/4). Not in the repo.',
        '',
        '- `inbound/<message-id>/<n>.<ext>` — received attachments. Durable; retention',
        '  cleanup is deferred (modest volume for one user).',
        '- `outbound/<token>.<ext>` — durable copies of images Sunny sent (rendered in',
        '  the dashboard). Retained.',
        '- `outbox/<token>.<ext>` — short-TTL public copies the transport fetches.',
        `  Removed after ~${Math.round(MEDIA.outboxTtlMs / 3600000)}h.`,
        '',
      ].join('\n'),
    );
  }
}

/** Persist inbound attachment bytes; returns the absolute path. */
export function persistInbound(
  runtimeDir: string,
  messageId: string,
  index: number,
  bytes: Buffer,
  mediaType: string,
): string {
  const dir = join(inboundDir(runtimeDir), safeSegment(messageId));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${index}.${extForMediaType(mediaType)}`);
  writeFileSync(path, bytes);
  return path;
}

/** Persist a durable outbound copy (for dashboard rendering); returns the path. */
export function persistOutbound(
  runtimeDir: string,
  token: string,
  bytes: Buffer,
  mediaType: string,
): string {
  const path = join(outboundDir(runtimeDir), `${token}.${extForMediaType(mediaType)}`);
  mkdirSync(outboundDir(runtimeDir), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

/**
 * Publish bytes to the short-TTL public outbox; returns the URL-safe filename
 * (`<token>.<ext>`) that the public `/media/<filename>` route serves.
 */
export function publishOutbox(runtimeDir: string, bytes: Buffer, mediaType: string): string {
  const token = randomBytes(16).toString('hex');
  const filename = `${token}.${extForMediaType(mediaType)}`;
  mkdirSync(outboxDir(runtimeDir), { recursive: true });
  writeFileSync(join(outboxDir(runtimeDir), filename), bytes);
  return filename;
}

/** A fresh outbound token (128-bit, hex) for the durable + outbox copies. */
export function outboundToken(): string {
  return randomBytes(16).toString('hex');
}

/**
 * Validate a public outbox filename: a 128-bit hex token with an optional simple
 * extension, and nothing else. This is the ONLY gate on the unauthenticated route
 * (D-MM4) — it guarantees the request maps to a fixed dir + a token-named file,
 * never a caller-supplied path, so traversal (`..`, separators, absolute paths)
 * is impossible. Pure; unit-tested.
 */
export function isValidOutboxName(name: string): boolean {
  return /^[a-f0-9]{32}(\.[a-z0-9]+)?$/.test(name);
}

/** Resolve a public outbox filename to a path, or null if invalid/missing. */
export function resolveOutbox(runtimeDir: string, name: string): string | null {
  if (!isValidOutboxName(name)) return null;
  const path = join(outboxDir(runtimeDir), name);
  return existsSync(path) ? path : null;
}

/**
 * Confine a stored ref path to the media root before serving it through the
 * authenticated dashboard route (D-MM9) — defense in depth so a malformed payload
 * can't turn the route into a general file server.
 */
export function isWithinMediaRoot(runtimeDir: string, path: string): boolean {
  try {
    const root = realpathSync(mediaRoot(runtimeDir));
    const real = realpathSync(path);
    return real === root || real.startsWith(root + sep);
  } catch {
    return false;
  }
}

// --- outbox cleanup (D-MM4) ------------------------------------------------

/** Injectable fs seam so cleanup logic is unit-testable without real files. */
export interface CleanupFs {
  list: (dir: string) => string[];
  mtimeMs: (path: string) => number;
  remove: (path: string) => void;
}

const realCleanupFs: CleanupFs = {
  list: (dir) => (existsSync(dir) ? readdirSync(dir) : []),
  mtimeMs: (path) => statSync(path).mtimeMs,
  remove: (path) => rmSync(path, { force: true }),
};

/** Delete outbox files older than the TTL; returns how many were removed. */
export function cleanupOutbox(
  runtimeDir: string,
  now: number,
  ttlMs: number = MEDIA.outboxTtlMs,
  fs: CleanupFs = realCleanupFs,
): number {
  const dir = outboxDir(runtimeDir);
  let removed = 0;
  for (const name of fs.list(dir)) {
    const path = join(dir, name);
    try {
      if (now - fs.mtimeMs(path) > ttlMs) {
        fs.remove(path);
        removed++;
      }
    } catch {
      /* a file vanishing mid-sweep is fine */
    }
  }
  return removed;
}

// --- outbound planning (D-MM5/6/7) -----------------------------------------

/** A single image attached to an outbound message: a local path or a URL. */
export interface OutboundAttachment {
  /** A local file path Sunny produced, or an http(s) URL to pass through. */
  pathOrUrl: string;
  mimeType?: string;
}

export type OutboundPlan =
  | { kind: 'text' } // no media, or media dropped (degraded) — send text only
  | { kind: 'host'; pathOrUrl: string; mimeType?: string } // host the file, send as native media (DM)
  | { kind: 'url'; url: string } // an existing URL — pass straight through as media_url
  | { kind: 'link'; pathOrUrl: string; mimeType?: string }; // group: host + send the URL as text

/**
 * Decide how to deliver an outbound attachment given the channel's media support
 * and the thread kind (D-MM5/6/7). Pure; unit-tested. Native media send is DM-only
 * (Sendblue returns early for groups), so groups get a hosted public link instead;
 * a channel without `media` support drops the attachment and still sends the text.
 */
export function planOutbound(
  attachment: OutboundAttachment | undefined,
  opts: { media: boolean; isGroup: boolean },
): OutboundPlan {
  if (!attachment) return { kind: 'text' };
  if (!opts.media) return { kind: 'text' };
  const isUrl = isHttpUrl(attachment.pathOrUrl);
  if (opts.isGroup)
    return { kind: 'link', pathOrUrl: attachment.pathOrUrl, mimeType: attachment.mimeType };
  if (isUrl) return { kind: 'url', url: attachment.pathOrUrl };
  return { kind: 'host', pathOrUrl: attachment.pathOrUrl, mimeType: attachment.mimeType };
}

export function isHttpUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

// --- payload ref extraction (shared by dashboard data + media route) -------

/** A renderable media reference for the dashboard: a disk file or an external URL. */
export interface RenderableMedia {
  disk: string | null;
  url: string | null;
  mediaType: string;
  kind: AttachmentKind;
  name: string;
}

interface UiPartLike {
  type: string;
  data?: unknown;
  input?: { image?: unknown };
  output?: unknown;
}

/**
 * Extract the ordered, renderable media of a stored row's payload (D-MM9). Both
 * the dashboard data layer (to build `src`s) and the authenticated media route
 * (to resolve index → disk path) use this, so their ordering stays identical.
 * - inbound: `data-attachment` parts with a saved `path`.
 * - outbound: a `send_message` tool part whose output carries a durable media
 *   path, or whose input image was an external URL (passed through).
 */
export function renderableMedia(payload: unknown): RenderableMedia[] {
  const parts = partsOf(payload);
  const out: RenderableMedia[] = [];
  for (const part of parts) {
    if (part.type === 'data-attachment') {
      const ref = part.data as AttachmentRef | undefined;
      if (ref?.path && !ref.error) {
        out.push({
          disk: ref.path,
          url: null,
          mediaType: ref.mediaType,
          kind: ref.kind,
          name: ref.name,
        });
      }
      continue;
    }
    if (part.type === 'tool-send_message') {
      const media = (part.output as { media?: OutboundMediaResult } | undefined)?.media;
      if (media && 'path' in media && media.path) {
        out.push({
          disk: media.path,
          url: null,
          mediaType: media.mediaType,
          kind: media.kind,
          name: media.name,
        });
      } else if (media && 'url' in media && media.url) {
        out.push({
          disk: null,
          url: media.url,
          mediaType: media.mediaType,
          kind: media.kind,
          name: media.name,
        });
      }
    }
  }
  return out;
}

/**
 * All `data-attachment` refs in a payload (D-MM1), including errored ones — so
 * recovery can faithfully reconstruct `event.attachments` rather than dropping
 * them (D-MM2). Order matches the stored parts.
 */
export function attachmentRefsOf(payload: unknown): AttachmentRef[] {
  return partsOf(payload)
    .filter((p) => p.type === 'data-attachment')
    .map((p) => p.data as AttachmentRef)
    .filter((r): r is AttachmentRef => !!r && typeof r === 'object');
}

function partsOf(payload: unknown): UiPartLike[] {
  if (payload && typeof payload === 'object' && 'parts' in payload) {
    const p = (payload as { parts?: unknown }).parts;
    if (Array.isArray(p)) return p as UiPartLike[];
  }
  return [];
}

/**
 * The media outcome of an outbound send, recorded in the `send_message` tool
 * output so the persisted turn (D-MG9) carries a durable, renderable ref. A
 * hosted local file gets a durable `path`; an external URL is passed through.
 */
export type OutboundMediaResult =
  | { path: string; mediaType: string; kind: AttachmentKind; name: string }
  | { url: string; mediaType: string; kind: AttachmentKind; name: string };
