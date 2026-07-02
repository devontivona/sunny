import { describe, expect, it } from 'vitest';
import {
  attachmentRefsOf,
  cleanupOutbox,
  contentTypeForName,
  extForMediaType,
  isGenericBinaryType,
  isValidOutboxName,
  kindForMediaType,
  modelIngestKind,
  sniffMediaType,
  planOutbound,
  renderableMedia,
  type AttachmentRef,
  type CleanupFs,
} from './media.js';

describe('modelIngestKind', () => {
  it('maps ingestible images to image, PDFs to document', () => {
    expect(modelIngestKind('image/jpeg')).toBe('image');
    expect(modelIngestKind('image/png')).toBe('image');
    expect(modelIngestKind('image/webp')).toBe('image');
    expect(modelIngestKind('application/pdf')).toBe('document');
  });

  it('returns null for types the model cannot ingest (HEIC, video, audio, archives)', () => {
    expect(modelIngestKind('image/heic')).toBeNull();
    expect(modelIngestKind('image/heif')).toBeNull();
    expect(modelIngestKind('video/mp4')).toBeNull();
    expect(modelIngestKind('audio/mpeg')).toBeNull();
    expect(modelIngestKind('application/zip')).toBeNull();
  });

  it('ignores parameters and case', () => {
    expect(modelIngestKind('IMAGE/JPEG; charset=binary')).toBe('image');
  });
});

describe('kindForMediaType / extForMediaType / contentTypeForName', () => {
  it('derives a kind from the MIME top-level type', () => {
    expect(kindForMediaType('image/png')).toBe('image');
    expect(kindForMediaType('video/quicktime')).toBe('video');
    expect(kindForMediaType('audio/mpeg')).toBe('audio');
    expect(kindForMediaType('application/pdf')).toBe('file');
  });

  it('maps types to safe extensions and back to content-types', () => {
    expect(extForMediaType('image/jpeg')).toBe('jpg');
    expect(extForMediaType('application/pdf')).toBe('pdf');
    expect(extForMediaType('application/x-tar')).toBe('xtar');
    expect(contentTypeForName('abc.png')).toBe('image/png');
    expect(contentTypeForName('abc.unknownext')).toBe('application/octet-stream');
  });
});

describe('isValidOutboxName (public route traversal resistance, D-MM4)', () => {
  const token = 'a'.repeat(32);

  it('accepts a 128-bit hex token with an optional simple extension', () => {
    expect(isValidOutboxName(token)).toBe(true);
    expect(isValidOutboxName(`${token}.jpg`)).toBe(true);
    expect(isValidOutboxName(`${token}.pdf`)).toBe(true);
  });

  it('rejects traversal, separators, and malformed names', () => {
    expect(isValidOutboxName('../etc/passwd')).toBe(false);
    expect(isValidOutboxName(`${token}/../secret`)).toBe(false);
    expect(isValidOutboxName(`/abs/${token}.jpg`)).toBe(false);
    expect(isValidOutboxName(`${token}.jpg/../x`)).toBe(false);
    expect(isValidOutboxName('short.jpg')).toBe(false);
    expect(isValidOutboxName(`${token}.JPG`)).toBe(false); // upper-case ext
    expect(isValidOutboxName(`${'A'.repeat(32)}`)).toBe(false); // non-hex
    expect(isValidOutboxName('')).toBe(false);
  });
});

describe('planOutbound (D-MM5/6/7)', () => {
  const local = { pathOrUrl: '/home/sunny/chart.png', mimeType: 'image/png' };
  const url = { pathOrUrl: 'https://example.com/x.png' };

  it('no attachment → text only', () => {
    expect(planOutbound(undefined, { media: true, isGroup: false })).toEqual({ kind: 'text' });
  });

  it('DM + local file → host', () => {
    expect(planOutbound(local, { media: true, isGroup: false })).toEqual({
      kind: 'host',
      pathOrUrl: local.pathOrUrl,
      mimeType: 'image/png',
    });
  });

  it('DM + existing URL → pass through (no hosting)', () => {
    expect(planOutbound(url, { media: true, isGroup: false })).toEqual({
      kind: 'url',
      url: url.pathOrUrl,
    });
  });

  it('group → link (native media send is DM-only)', () => {
    expect(planOutbound(local, { media: true, isGroup: true })).toEqual({
      kind: 'link',
      pathOrUrl: local.pathOrUrl,
      mimeType: 'image/png',
    });
  });

  it('channel without media support → drop attachment, send text', () => {
    expect(planOutbound(local, { media: false, isGroup: false })).toEqual({ kind: 'text' });
  });
});

describe('attachmentRefsOf / renderableMedia (payload extraction, D-MM1/9)', () => {
  const inbound: AttachmentRef = {
    path: '/m/inbound/x/0.jpg',
    mediaType: 'image/jpeg',
    kind: 'image',
    name: 'photo.jpg',
    size: 10,
    direction: 'inbound',
  };
  const errored: AttachmentRef = {
    path: null,
    mediaType: 'image/heic',
    kind: 'image',
    name: 'bad.heic',
    size: 0,
    direction: 'inbound',
    error: 'fetch failed',
  };

  const userPayload = {
    role: 'user',
    parts: [
      { type: 'text', text: 'look' },
      { type: 'data-attachment', data: inbound },
      { type: 'data-attachment', data: errored },
    ],
  };

  it('attachmentRefsOf returns every ref including errored ones (for recovery)', () => {
    expect(attachmentRefsOf(userPayload)).toEqual([inbound, errored]);
  });

  it('renderableMedia skips errored/unsaved refs', () => {
    const r = renderableMedia(userPayload);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ disk: inbound.path, mediaType: 'image/jpeg', kind: 'image' });
  });

  it('renderableMedia surfaces outbound media from a send_message tool part', () => {
    const assistantPayload = {
      role: 'assistant',
      parts: [
        {
          type: 'tool-send_message',
          input: { text: 'here', image: '/home/sunny/out.png' },
          output: {
            status: 'delivered',
            media: {
              path: '/m/outbound/tok.png',
              mediaType: 'image/png',
              kind: 'image',
              name: 'out.png',
            },
          },
        },
      ],
    };
    expect(renderableMedia(assistantPayload)).toEqual([
      {
        disk: '/m/outbound/tok.png',
        url: null,
        mediaType: 'image/png',
        kind: 'image',
        name: 'out.png',
      },
    ]);
  });

  it('renderableMedia passes an external outbound URL straight through', () => {
    const assistantPayload = {
      role: 'assistant',
      parts: [
        {
          type: 'tool-send_message',
          input: { text: 'link', image: 'https://x/y.png' },
          output: {
            status: 'delivered',
            media: { url: 'https://x/y.png', mediaType: 'image/*', kind: 'image', name: 'y.png' },
          },
        },
      ],
    };
    expect(renderableMedia(assistantPayload)).toEqual([
      { disk: null, url: 'https://x/y.png', mediaType: 'image/*', kind: 'image', name: 'y.png' },
    ]);
  });

  it('tolerates legacy/empty payloads', () => {
    expect(attachmentRefsOf(null)).toEqual([]);
    expect(renderableMedia({ role: 'user', parts: [{ type: 'text', text: 'hi' }] })).toEqual([]);
  });
});

describe('sniffMediaType / isGenericBinaryType (unlabeled-attachment recovery)', () => {
  const buf = (...bytes: number[]) => Buffer.from(bytes);

  it('recovers application/pdf from the %PDF signature', () => {
    expect(sniffMediaType(Buffer.from('%PDF-1.6\n…binary…'))).toBe('application/pdf');
  });

  it('recovers common image types from their magic bytes', () => {
    expect(sniffMediaType(buf(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe('image/png');
    expect(sniffMediaType(buf(0xff, 0xd8, 0xff, 0xe0))).toBe('image/jpeg');
    expect(sniffMediaType(buf(0x47, 0x49, 0x46, 0x38, 0x39, 0x61))).toBe('image/gif');
    // RIFF....WEBP
    expect(sniffMediaType(buf(0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50))).toBe(
      'image/webp',
    );
    // ISO-BMFF ftyp with a HEIC brand: [size][ftyp][heic]
    expect(sniffMediaType(buf(0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63))).toBe(
      'image/heic',
    );
  });

  it('falls back for an unrecognized signature (plain text / unknown)', () => {
    expect(sniffMediaType(Buffer.from('just some text'))).toBe('application/octet-stream');
    expect(sniffMediaType(Buffer.from('x'), 'text/plain')).toBe('text/plain');
  });

  it('flags only absent / generic-binary declared types as worth sniffing', () => {
    expect(isGenericBinaryType(undefined)).toBe(true);
    expect(isGenericBinaryType(null)).toBe(true);
    expect(isGenericBinaryType('')).toBe(true);
    expect(isGenericBinaryType('application/octet-stream')).toBe(true);
    expect(isGenericBinaryType('application/pdf')).toBe(false);
    expect(isGenericBinaryType('image/jpeg')).toBe(false);
  });
});

describe('cleanupOutbox (short-TTL sweep, D-MM4)', () => {
  it('removes only files older than the TTL', () => {
    const now = 1_000_000;
    const ttl = 1000;
    const removed: string[] = [];
    const fs: CleanupFs = {
      list: () => ['old.jpg', 'fresh.png'],
      mtimeMs: (p) => (p.endsWith('old.jpg') ? now - ttl - 1 : now - 1),
      remove: (p) => removed.push(p),
    };
    const count = cleanupOutbox('/rt', now, ttl, fs);
    expect(count).toBe(1);
    expect(removed).toHaveLength(1);
    expect(removed[0]).toContain('old.jpg');
  });

  it('is a no-op on an empty/missing outbox', () => {
    const fs: CleanupFs = { list: () => [], mtimeMs: () => 0, remove: () => {} };
    expect(cleanupOutbox('/rt', 1, 1, fs)).toBe(0);
  });
});
