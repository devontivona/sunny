import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normalize } from '../src/gateway/auth.js';
import { parseDuration } from '../src/scheduler/index.js';
import { sanitizeTopic } from '../src/memory/index.js';

/**
 * Property-based tests for the pure normalizers (design D15 / task 4.9).
 *
 * Randomness is reserved for wide-input invariants here, where fast-check
 * *shrinks* any failure to a minimal, reproducible counterexample — the opposite
 * of unseeded faker. The value assertions elsewhere stay on explicit builders.
 */

describe('normalize (property)', () => {
  it('is idempotent: normalize(normalize(x)) === normalize(x)', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(normalize(normalize(s))).toBe(normalize(s));
      }),
    );
  });

  it('a phone-like input (digits, no @) normalizes to `+` then digits only', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[-() +0-9]*[0-9][-() +0-9]*$/), (s) => {
        const out = normalize(s);
        // Phone path keeps only digits and `+`, and guarantees a leading `+`.
        expect(out.startsWith('+')).toBe(true);
        expect(out).toMatch(/^\+[0-9+]*$/);
      }),
    );
  });
});

describe('parseDuration (property)', () => {
  it('round-trips a positive integer count for every unit', () => {
    const units: Array<[string, number]> = [
      ['s', 1000],
      ['m', 60_000],
      ['h', 3_600_000],
      ['d', 86_400_000],
    ];
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 100_000 }), fc.constantFrom(...units), (n, [u, ms]) => {
        expect(parseDuration(`${n}${u}`)).toBe(n * ms);
      }),
    );
  });

  it('throws on anything that is not <digits><s|m|h|d>', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !/^\s*\d+\s*[smhd]\s*$/.test(s)),
        (s) => {
          expect(() => parseDuration(s)).toThrow();
        },
      ),
    );
  });
});

describe('sanitizeTopic (property)', () => {
  it('output never contains `/` or `..` and matches the safe slug charset', () => {
    fc.assert(
      fc.property(fc.string(), (name) => {
        let slug: string;
        try {
          slug = sanitizeTopic(name);
        } catch {
          return; // empty/unsafe names throw — nothing unsafe escapes
        }
        expect(slug).not.toContain('/');
        expect(slug).not.toContain('..');
        expect(slug).toMatch(/^[a-z0-9_-]+$/);
      }),
    );
  });
});
