import { describe, expect, it } from 'vitest';
import { parseTranslatorUpdate } from './translator.js';

/**
 * Translator decline parsing (2026-07-05 incident): Haiku emitted update text PLUS the
 * decline sentinel in one output, and the old prefix-only check let the combined blob —
 * sentinel included — reach the user. An interim update is disposable, so the sentinel
 * is a POISON PILL: any occurrence anywhere means the model meant to decline, and the
 * whole output is dropped. (Deliberately the opposite of stripNoReply, where a final
 * reply's content must never be swallowed.)
 */
describe('parseTranslatorUpdate', () => {
  it('a clean update passes through trimmed', () => {
    expect(parseTranslatorUpdate('  Pulling the feed apart now.  ')).toBe(
      'Pulling the feed apart now.',
    );
  });

  it('a bare sentinel means silence', () => {
    expect(parseTranslatorUpdate('<no-update/>')).toBe('');
    expect(parseTranslatorUpdate('  <no-update/>  ')).toBe('');
  });

  it('text combined with the sentinel is DROPPED entirely (the incident shape)', () => {
    expect(parseTranslatorUpdate('Still working through the sources. <no-update/>')).toBe('');
    expect(parseTranslatorUpdate('<no-update/> but FYI the feed is slow')).toBe('');
  });

  it('fuzzy variants all count as declining', () => {
    for (const v of [
      '<no-update>',
      '< no-update />',
      '<NO-UPDATE/>',
      '<no_update/>',
      '<no update>',
      'NO_UPDATE',
      'no text yet — NO_UPDATE',
    ]) {
      expect(parseTranslatorUpdate(v)).toBe('');
    }
  });

  it('empty output means silence', () => {
    expect(parseTranslatorUpdate('')).toBe('');
    expect(parseTranslatorUpdate('   ')).toBe('');
  });

  it('ordinary prose containing the word "update" is not a decline', () => {
    expect(parseTranslatorUpdate('Quick update: two sources are paywalled.')).toBe(
      'Quick update: two sources are paywalled.',
    );
  });
});
