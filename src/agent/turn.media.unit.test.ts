import { describe, expect, it } from 'vitest';
import type { UIMessage } from 'ai';
import { resolveInboundMediaParts, toModelMessages } from './turn.js';
import { makeStoredMessage } from '../../tests/factories.js';
import type { AttachmentRef } from '../gateway/media.js';

function dataAttachment(ref: Partial<AttachmentRef>): UIMessage['parts'][number] {
  return {
    type: 'data-attachment',
    data: {
      path: '/m/inbound/x/0.bin',
      mediaType: 'application/octet-stream',
      kind: 'file',
      name: 'f',
      size: 1,
      direction: 'inbound',
      ...ref,
    },
  } as UIMessage['parts'][number];
}

const text = (t: string): UIMessage['parts'][number] => ({ type: 'text', text: t });

describe('resolveInboundMediaParts (D-MM3 best-effort mapping)', () => {
  const read = () => Buffer.from('hello');
  // Default fake preparer: pass an image through unchanged (HEIC → JPEG).
  const passthrough = (b: Buffer, mt: string) => ({
    bytes: b,
    mediaType: mt === 'image/heic' || mt === 'image/heif' ? 'image/jpeg' : mt,
  });

  it('ingestible image → inlined file part with a data URL', () => {
    const out = resolveInboundMediaParts(
      [text('look'), dataAttachment({ mediaType: 'image/jpeg', name: 'p.jpg' })],
      { readFile: read, prepareImage: passthrough },
    );
    expect(out[0]).toEqual({ type: 'text', text: 'look' });
    const part = out[1] as { type: string; mediaType: string; url: string; filename: string };
    expect(part.type).toBe('file');
    expect(part.mediaType).toBe('image/jpeg');
    expect(part.filename).toBe('p.jpg');
    expect(part.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('downscaled image is inlined as the preparer-returned JPEG', () => {
    // Simulate the preparer downscaling a large PNG to a smaller JPEG.
    const out = resolveInboundMediaParts(
      [dataAttachment({ mediaType: 'image/png', name: 'big.png' })],
      {
        readFile: () => Buffer.alloc(8_000_000),
        prepareImage: () => ({ bytes: Buffer.from('jpg'), mediaType: 'image/jpeg' }),
      },
    );
    const part = out[0] as { type: string; mediaType: string };
    expect(part.type).toBe('file');
    expect(part.mediaType).toBe('image/jpeg');
  });

  it('PDF → inlined file part (document), not run through the image preparer', () => {
    let prepareCalled = false;
    const out = resolveInboundMediaParts(
      [dataAttachment({ mediaType: 'application/pdf', name: 'd.pdf' })],
      {
        readFile: read,
        prepareImage: () => {
          prepareCalled = true;
          return null;
        },
      },
    );
    expect((out[0] as { type: string; mediaType: string }).type).toBe('file');
    expect((out[0] as { mediaType: string }).mediaType).toBe('application/pdf');
    expect(prepareCalled).toBe(false);
  });

  it('unsupported type → a saved-file note, never dropped', () => {
    const out = resolveInboundMediaParts(
      [dataAttachment({ mediaType: 'video/mp4', name: 'clip.mp4', path: '/m/inbound/x/0.mp4' })],
      { readFile: read },
    );
    expect(out).toHaveLength(1);
    const note = out[0] as { type: string; text: string };
    expect(note.type).toBe('text');
    expect(note.text).toContain('clip.mp4');
    expect(note.text).toContain('video/mp4');
    expect(note.text).toContain('/m/inbound/x/0.mp4');
  });

  it('over-size image (after preparation) degrades to a note', () => {
    const out = resolveInboundMediaParts(
      [dataAttachment({ mediaType: 'image/png', name: 'big.png' })],
      { readFile: () => Buffer.alloc(10), prepareImage: passthrough, maxInlineBytes: 4 },
    );
    expect((out[0] as { type: string }).type).toBe('text');
    expect((out[0] as { text: string }).text).toContain('too large');
  });

  it('over-count attachments degrade to notes past the cap', () => {
    const parts = [
      dataAttachment({ mediaType: 'image/png', name: 'a.png' }),
      dataAttachment({ mediaType: 'image/png', name: 'b.png' }),
      dataAttachment({ mediaType: 'image/png', name: 'c.png' }),
    ];
    const out = resolveInboundMediaParts(parts, {
      readFile: read,
      prepareImage: passthrough,
      maxInlineCount: 2,
    });
    expect((out[0] as { type: string }).type).toBe('file');
    expect((out[1] as { type: string }).type).toBe('file');
    expect((out[2] as { type: string }).type).toBe('text');
    expect((out[2] as { text: string }).text).toContain('attachment limit');
  });

  it('an errored (unsaved) attachment becomes a note, not a crash', () => {
    const out = resolveInboundMediaParts(
      [
        dataAttachment({
          path: null,
          error: 'fetch failed',
          mediaType: 'image/jpeg',
          name: 'x.jpg',
        }),
      ],
      { readFile: read },
    );
    expect((out[0] as { type: string }).type).toBe('text');
    expect((out[0] as { text: string }).text).toContain('could not be saved');
  });

  it('HEIC is transcoded to JPEG and inlined (iPhone photo path)', () => {
    const out = resolveInboundMediaParts(
      [
        dataAttachment({
          mediaType: 'image/heic',
          name: 'photo.heic',
          path: '/m/inbound/x/0.heic',
        }),
      ],
      {
        readFile: read,
        prepareImage: () => ({ bytes: Buffer.from('jpegbytes'), mediaType: 'image/jpeg' }),
      },
    );
    const part = out[0] as { type: string; mediaType: string; url: string };
    expect(part.type).toBe('file');
    expect(part.mediaType).toBe('image/jpeg');
    expect(part.url.startsWith('data:image/jpeg;base64,')).toBe(true);
  });

  it('HEIC degrades to a note when conversion is unavailable/fails', () => {
    const out = resolveInboundMediaParts(
      [
        dataAttachment({
          mediaType: 'image/heic',
          name: 'photo.heic',
          path: '/m/inbound/x/0.heic',
        }),
      ],
      { readFile: read, prepareImage: () => null },
    );
    expect((out[0] as { type: string }).type).toBe('text');
    expect((out[0] as { text: string }).text).toContain('could not convert');
  });

  it('an unreadable file becomes a note', () => {
    const out = resolveInboundMediaParts(
      [dataAttachment({ mediaType: 'image/png', name: 'gone.png' })],
      {
        prepareImage: passthrough,
        readFile: () => {
          throw new Error('ENOENT');
        },
      },
    );
    expect((out[0] as { type: string }).type).toBe('text');
    expect((out[0] as { text: string }).text).toContain('could not be read');
  });
});

describe('toModelMessages with media', () => {
  it('inlines an inbound image into the user model message', async () => {
    const row = makeStoredMessage({
      role: 'user',
      payload: {
        id: 'u1',
        role: 'user',
        parts: [text('what is this'), dataAttachment({ mediaType: 'image/png', name: 'p.png' })],
      },
    });
    const out = await toModelMessages([row], false, { readFile: () => Buffer.from('x') });
    expect(out).toHaveLength(1);
    expect(out[0]!.role).toBe('user');
    const content = out[0]!.content as Array<{ type: string }>;
    expect(content.map((c) => c.type)).toEqual(['text', 'file']);
  });

  it('drops media parts from non-user rows (model does not re-ingest outbound media)', async () => {
    const row = makeStoredMessage({
      role: 'assistant',
      payload: {
        id: 'a1',
        role: 'assistant',
        parts: [text('here you go'), dataAttachment({ mediaType: 'image/png', name: 'p.png' })],
      },
    });
    const out = await toModelMessages([row], false, { readFile: () => Buffer.from('x') });
    const content = out[0]!.content as Array<{ type: string }>;
    expect(content.every((c) => c.type !== 'file')).toBe(true);
  });
});
