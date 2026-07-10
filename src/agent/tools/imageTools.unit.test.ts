import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sendImageToModelOutput, type SendImageOutput } from './sendImageSpec.js';
import { viewImageToModelOutput, type ViewImageOutput } from './viewImageSpec.js';
import { buildImagePreview, readImageForViewing } from './imagePreview.js';

/**
 * Image tool results (image-send-integrity, 2026-07-10): the model must SEE what it
 * sent/produced (vision content in the tool result) and must get a REAL error when a
 * send failed — never the old lying bare 'delivered'.
 */

// Minimal valid PNG signature + body byte — sniffs as image/png, small enough that
// prepareImageForModel inlines it as-is (no ImageMagick dependency in tests).
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

describe('sendImageToModelOutput', () => {
  it('maps a failed send to an error the model can act on', () => {
    const out: SendImageOutput = { status: 'not_sent', error: 'no file exists at /x.jpg' };
    expect(sendImageToModelOutput({ output: out })).toEqual({
      type: 'error-text',
      value: 'IMAGE NOT SENT: no file exists at /x.jpg',
    });
  });

  it('shows the delivered image (vision content) and names the durable path in TEXT', () => {
    const out: SendImageOutput = {
      status: 'delivered',
      media: { path: '/m/outbound/tok.jpg', mediaType: 'image/jpeg', name: 'scene.jpg' },
      preview: { data: 'aGVsbG8=', mediaType: 'image/jpeg' },
    };
    const mapped = sendImageToModelOutput({ output: out });
    expect(mapped.type).toBe('content');
    const value = (mapped as { value: Array<Record<string, unknown>> }).value;
    expect(value[0]).toMatchObject({ type: 'text' });
    // The durable path must live in the text — it is all that survives the persist boundary.
    expect((value[0] as { text: string }).text).toContain('/m/outbound/tok.jpg');
    expect(value[1]).toEqual({
      type: 'file',
      data: { type: 'data', data: 'aGVsbG8=' },
      mediaType: 'image/jpeg',
    });
  });

  it('degrades to text naming the passthrough URL when no preview could be built', () => {
    const out: SendImageOutput = {
      status: 'delivered',
      media: { url: 'https://x/y.png', mediaType: 'image/*', name: 'y.png' },
    };
    expect(sendImageToModelOutput({ output: out })).toEqual({
      type: 'text',
      value: 'Image delivered (y.png, from https://x/y.png).',
    });
  });

  it('passes a legacy string output through', () => {
    expect(sendImageToModelOutput({ output: 'delivered' })).toEqual({
      type: 'text',
      value: 'delivered',
    });
  });
});

describe('viewImageToModelOutput', () => {
  it('maps an error output to error-text', () => {
    const out: ViewImageOutput = { status: 'error', error: 'no file exists at /x.png' };
    expect(viewImageToModelOutput({ output: out })).toEqual({
      type: 'error-text',
      value: 'no file exists at /x.png',
    });
  });

  it('returns vision content with the path/size in text', () => {
    const out: ViewImageOutput = {
      status: 'ok',
      path: '/img/a.png',
      mediaType: 'image/png',
      size: 9,
      preview: { data: 'aGVsbG8=', mediaType: 'image/png' },
    };
    const mapped = viewImageToModelOutput({ output: out });
    expect(mapped.type).toBe('content');
    const value = (mapped as { value: Array<Record<string, unknown>> }).value;
    expect((value[0] as { text: string }).text).toContain('/img/a.png');
    expect(value[1]).toMatchObject({ type: 'file', mediaType: 'image/png' });
  });

  it('notes a stripped preview instead of pretending the image is attached', () => {
    const out: ViewImageOutput = {
      status: 'ok',
      path: '/img/a.png',
      mediaType: 'image/png',
      size: 9,
      previewStripped: true,
    };
    const mapped = viewImageToModelOutput({ output: out });
    expect(mapped.type).toBe('text');
    expect((mapped as { value: string }).value).toContain('view_image');
  });
});

describe('readImageForViewing / buildImagePreview', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sunny-view-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns ok + preview for a real image file', async () => {
    const path = join(dir, 'a.png');
    writeFileSync(path, PNG);
    const out = await readImageForViewing(path, { timeoutMs: 500 });
    expect(out).toMatchObject({ status: 'ok', path, mediaType: 'image/png', size: PNG.length });
    // Small already-ingestible image passes through un-recoded.
    expect((out as { preview: { data: string } }).preview.data).toBe(PNG.toString('base64'));
  });

  it('errors on a missing file with the gate message', async () => {
    const out = await readImageForViewing(join(dir, 'nope.png'), { timeoutMs: 200 });
    expect(out.status).toBe('error');
    expect((out as { error: string }).error).toMatch(/no file exists/);
  });

  it('refuses a non-image file, pointing at file_read', async () => {
    const path = join(dir, 'notes.txt');
    writeFileSync(path, 'hello');
    const out = await readImageForViewing(path, { timeoutMs: 200 });
    expect(out.status).toBe('error');
    expect((out as { error: string }).error).toContain('not an image');
  });

  it('buildImagePreview sniffs a real type through a generic declared one', () => {
    const preview = buildImagePreview(PNG, 'application/octet-stream');
    expect(preview).toMatchObject({ mediaType: 'image/png' });
  });
});
