import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyMemoryWrite,
  ensureAndLoadPeople,
  indexHasTopicLine,
  MemoryOverflowError,
  memoryPaths,
  personId,
  sanitizePersonId,
  sanitizeTopic,
} from './index.js';
import { normalize } from '../gateway/auth.js';
import { makeConfig } from '../../tests/factories.js';

describe('sanitizeTopic', () => {
  it('slugs a normal name', () => {
    expect(sanitizeTopic('Travel Plans')).toBe('travel-plans');
  });

  it('strips path-traversal and separators (no `/`, no `..`)', () => {
    expect(sanitizeTopic('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeTopic('a/b/c')).toBe('a-b-c');
  });

  it('throws when nothing safe remains', () => {
    expect(() => sanitizeTopic('/////')).toThrow(/invalid topic name/);
  });

  // Slug consolidation (fix/code-review-sweep): sanitizeTopic now shares `sanitizeSlug`, which
  // ADDS a leading `.trim()` it previously lacked. Behavior-equivalent (the char-class replace
  // already collapsed surrounding whitespace to trimmed dashes), pinned here so it stays so.
  it('trims surrounding whitespace to the same slug (shared sanitizeSlug)', () => {
    expect(sanitizeTopic('  Travel Plans  ')).toBe('travel-plans');
    expect(sanitizeTopic('Travel Plans')).toBe('travel-plans');
    expect(() => sanitizeTopic('   ')).toThrow(/invalid topic name/);
  });

  it('keeps the resolved topic path inside the topics dir', () => {
    const paths = memoryPaths('/tmp/sunny-x');
    expect(paths.topic('../../escape')).toBe(`${paths.topicsDir}/escape.md`);
  });
});

describe('applyMemoryWrite — computeNext semantics', () => {
  function freshConfig() {
    return makeConfig(); // fresh temp runtime dir per call
  }

  it('add: appends content with a trailing newline', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: '- Likes tea' });
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: '- Lives in NYC' });
    const body = readFileSync(memoryPaths(config.runtimeDir).USER, 'utf8');
    expect(body).toBe('- Likes tea\n- Lives in NYC\n');
  });

  it('add: rejects empty content', async () => {
    const config = freshConfig();
    await expect(
      applyMemoryWrite(config, { file: 'USER', action: 'add', content: '   ' }),
    ).rejects.toThrow(/add requires content/);
  });

  it('replace with target: substitutes the matched substring', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'SUNNY', action: 'add', content: 'tone: formal' });
    await applyMemoryWrite(config, {
      file: 'SUNNY',
      action: 'replace',
      target: 'formal',
      content: 'warm',
    });
    expect(readFileSync(memoryPaths(config.runtimeDir).SUNNY, 'utf8')).toBe('tone: warm\n');
  });

  it('replace with target: inserts $-sequences in content verbatim (no pattern expansion)', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: 'PLACEHOLDER end' });
    // These are String.prototype.replace special patterns: $& (whole match), $` /
    // $' (text before/after), $$ (literal $), $1 (group). Model-supplied content
    // containing them must be inserted literally, not expanded into file content.
    const content = "literal $& $` $$ $' $1 done";
    await applyMemoryWrite(config, {
      file: 'USER',
      action: 'replace',
      target: 'PLACEHOLDER',
      content,
    });
    expect(readFileSync(memoryPaths(config.runtimeDir).USER, 'utf8')).toBe(`${content} end\n`);
  });

  it('replace without target: full-file replace (consolidation primitive)', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'INDEX', action: 'add', content: 'old line' });
    await applyMemoryWrite(config, { file: 'INDEX', action: 'replace', content: 'fresh body' });
    expect(readFileSync(memoryPaths(config.runtimeDir).INDEX, 'utf8')).toBe('fresh body\n');
  });

  it('replace: throws when the target is absent', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: 'hello' });
    await expect(
      applyMemoryWrite(config, { file: 'USER', action: 'replace', target: 'absent', content: 'x' }),
    ).rejects.toThrow(/replace target not found/);
  });

  it('remove: deletes the matched substring', async () => {
    const config = freshConfig();
    await applyMemoryWrite(config, { file: 'USER', action: 'add', content: 'keep DROP keep' });
    await applyMemoryWrite(config, { file: 'USER', action: 'remove', target: ' DROP' });
    expect(readFileSync(memoryPaths(config.runtimeDir).USER, 'utf8')).toBe('keep keep\n');
  });

  it('routes a topic doc to topics/ (unbounded) via topic:<name>', async () => {
    const config = freshConfig();
    const res = await applyMemoryWrite(config, {
      file: 'topic:Travel Plans',
      action: 'add',
      content: 'flight booked',
    });
    expect(res).toMatch(/topics\/travel-plans\.md/);
    expect(readFileSync(memoryPaths(config.runtimeDir).topic('Travel Plans'), 'utf8')).toBe(
      'flight booked\n',
    );
  });

  it('rejects an unknown core file', async () => {
    const config = freshConfig();
    await expect(
      applyMemoryWrite(config, { file: 'NOPE', action: 'add', content: 'x' }),
    ).rejects.toThrow(/unknown memory file/);
  });
});

describe('topic-INDEX invariant (context-lifecycle)', () => {
  it('a fresh topic write appends a stub INDEX line in the same write', async () => {
    const config = makeConfig();
    const res = await applyMemoryWrite(config, {
      file: 'topic:comet-financial',
      action: 'add',
      content: 'advisor notes',
    });
    expect(res).toMatch(/INDEX line added for "comet-financial"/);
    const index = readFileSync(memoryPaths(config.runtimeDir).INDEX, 'utf8');
    expect(index).toContain('- comet-financial: (stub');
  });

  it('an existing INDEX line is left untouched (no duplicate stub)', async () => {
    const config = makeConfig();
    await applyMemoryWrite(config, {
      file: 'INDEX',
      action: 'add',
      content: '- travel-plans: upcoming trips, bookings',
    });
    await applyMemoryWrite(config, {
      file: 'topic:Travel Plans',
      action: 'add',
      content: 'flight booked',
    });
    const index = readFileSync(memoryPaths(config.runtimeDir).INDEX, 'utf8');
    expect(index).toBe('- travel-plans: upcoming trips, bookings\n');
  });

  it('slug matching is token-bounded — `work` does not match `network`', () => {
    expect(indexHasTopicLine('- network: infra notes', 'work')).toBe(false);
    expect(indexHasTopicLine('- work: job stuff', 'work')).toBe(true);
    expect(indexHasTopicLine('see topics/work.md', 'work')).toBe(true);
  });

  it('INDEX at cap: the stub is skipped (best-effort) and the topic write still succeeds', async () => {
    const config = makeConfig({
      memory: { userMaxChars: 8000, sunnyMaxChars: 6000, indexMaxChars: 30 },
    });
    await applyMemoryWrite(config, { file: 'INDEX', action: 'add', content: 'x'.repeat(25) });
    const res = await applyMemoryWrite(config, {
      file: 'topic:big-topic',
      action: 'add',
      content: 'body',
    });
    expect(res).toMatch(/ok: add on topics\/big-topic\.md/);
    expect(res).toMatch(/WARNING: INDEX\.md is at its cap/);
    const index = readFileSync(memoryPaths(config.runtimeDir).INDEX, 'utf8');
    expect(index).not.toContain('big-topic');
  });
});

describe('core-file overflow', () => {
  it('throws MemoryOverflowError when a capped core file exceeds its cap', async () => {
    const config = makeConfig({
      memory: { userMaxChars: 20, sunnyMaxChars: 6000, indexMaxChars: 2000 },
    });
    await expect(
      applyMemoryWrite(config, {
        file: 'USER',
        action: 'add',
        content: 'x'.repeat(50),
      }),
    ).rejects.toBeInstanceOf(MemoryOverflowError);
  });

  it('topic docs are unbounded (no overflow)', async () => {
    const config = makeConfig({
      memory: { userMaxChars: 20, sunnyMaxChars: 20, indexMaxChars: 20 },
    });
    await expect(
      applyMemoryWrite(config, { file: 'topic:big', action: 'add', content: 'y'.repeat(500) }),
    ).resolves.toMatch(/ok:/);
  });
});

describe('per-person profile docs (multiplayer-family D3)', () => {
  it('personId slugs phones and emails to a stable, filesystem-safe id', () => {
    expect(personId('+1 (719) 314-6820')).toBe('17193146820'); // digits only
    expect(personId('+17193146820')).toBe('17193146820'); // formatting-stable
    expect(personId('kate@example.com')).toBe('kate-example-com');
  });

  // Consolidation safety net (fix/code-review-sweep): personId now canonicalizes through the SAME
  // shared `normalize` the authorizer uses. The on-disk key MUST NOT change for common inputs, or
  // existing person docs would be orphaned. Enumerate representative phone/email variants and pin
  // the exact prior output; also assert personId === slug(normalize(...)) so the two can't drift.
  it('personId output is unchanged after normalizing through the shared canonicalizer', () => {
    const slug = (s: string) => s.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const cases: Array<[string, string]> = [
      ['+1 (719) 314-6820', '17193146820'],
      ['+17193146820', '17193146820'],
      ['1 719 314 6820', '17193146820'],
      ['(719) 314-6820', '7193146820'],
      ['  Kate@Example.COM ', 'kate-example-com'],
      ['kate@example.com', 'kate-example-com'],
    ];
    for (const [input, expected] of cases) {
      expect(personId(input)).toBe(expected);
      // The write-target guard and the derived id agree, so a fresh id round-trips unchanged.
      expect(sanitizePersonId(personId(input))).toBe(expected);
      // personId is exactly the slug of the shared normalized identity.
      expect(personId(input)).toBe(slug(normalize(input)));
    }
  });

  it('sanitizePersonId strips path traversal in a write target', () => {
    expect(sanitizePersonId('../../etc/passwd')).toBe('etc-passwd');
  });

  it('keeps the resolved person path inside the people dir', () => {
    const paths = memoryPaths('/tmp/sunny-x');
    expect(paths.person('../../escape')).toBe(`${paths.peopleDir}/escape.md`);
  });

  it('ensureAndLoadPeople auto-creates a seeded doc on first contact and loads it', async () => {
    const config = makeConfig();
    const id = personId('+17193146820');
    const docs = await ensureAndLoadPeople(config, [
      { id, name: 'Kate', identity: '+17193146820' },
    ]);
    expect(existsSync(memoryPaths(config.runtimeDir).person(id))).toBe(true);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.content).toContain('Kate');
    expect(docs[0]!.content).toContain('+17193146820');
  });

  it('writes a fact about a person to people:<id>, not USER', async () => {
    const config = makeConfig();
    const id = personId('+17193146820');
    await ensureAndLoadPeople(config, [{ id, name: 'Kate', identity: '+17193146820' }]);
    const res = await applyMemoryWrite(config, {
      file: `people:${id}`,
      action: 'add',
      content: '- Vegetarian',
    });
    expect(res).toMatch(/ok:/);
    const paths = memoryPaths(config.runtimeDir);
    expect(readFileSync(paths.person(id), 'utf8')).toContain('- Vegetarian');
    // USER.md is untouched by a person-fact write.
    const user = existsSync(paths.USER) ? readFileSync(paths.USER, 'utf8') : '';
    expect(user).not.toContain('Vegetarian');
  });

  it('person docs are capped like USER (overflow forces consolidation)', async () => {
    const config = makeConfig({
      memory: { userMaxChars: 20, sunnyMaxChars: 6000, indexMaxChars: 2000 },
    });
    await expect(
      applyMemoryWrite(config, { file: 'people:kate', action: 'add', content: 'z'.repeat(50) }),
    ).rejects.toBeInstanceOf(MemoryOverflowError);
  });
});

describe('execRecall — cross-thread attribution (multiplayer-family)', () => {
  const OWNER = '+15551230000';
  const KATE = '+17193146820';
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  const dm = (num: string) => `sendblue:${b64('+16452438873')}:${b64(num)}`;
  const group = `sendblue:${b64('+16452438873')}:g:${b64('grp1')}`;

  function fakeStore(hits: Array<Partial<import('../gateway/store.js').RecallHit>>) {
    return {
      recall: async () =>
        hits.map((h) => ({
          messageId: 'x',
          threadId: dm(KATE),
          role: 'user' as const,
          senderId: KATE,
          senderName: 'Kate',
          text: 'hi',
          snippet: h.text ?? 'hi',
          payload: null,
          timestamp: new Date('2026-06-28T00:00:00Z'),
          isOwner: false,
          ...h,
        })),
    } as unknown as import('../gateway/store.js').ConversationStore;
  }

  it('labels DM hits by the roster name and a group hit generically', async () => {
    const config = makeConfig({
      owner: { name: 'Devon', identities: [OWNER] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    const { execRecall } = await import('../agent/tools/memory.js');
    const out = await execRecall(
      fakeStore([
        { threadId: dm(KATE), senderName: 'Kate', text: 'met you today' },
        { threadId: dm(OWNER), senderName: 'Devon', text: 'you met Kate!' },
        { threadId: group, senderName: 'Kate', text: 'in the group' },
      ]),
      config,
      'kate',
    );
    expect(out).toContain('Kate (in the chat with Kate) [id:x]: met you today');
    expect(out).toContain('Devon (in the chat with Devon) [id:x]: you met Kate!');
    expect(out).toContain('(in a group chat) [id:x]: in the group');
  });

  it('renders attachment names + saved paths on a hit (attachment permanence)', async () => {
    const config = makeConfig({
      owner: { name: 'Devon', identities: [OWNER] },
      family: [{ name: 'Kate', identities: [KATE] }],
    });
    const { execRecall } = await import('../agent/tools/memory.js');
    const out = await execRecall(
      fakeStore([
        {
          text: 'here is the statement',
          payload: {
            parts: [
              { type: 'text', text: 'here is the statement' },
              {
                type: 'data-attachment',
                data: {
                  path: '/home/x/.sunny/media/inbound/x/0.pdf',
                  mediaType: 'application/pdf',
                  kind: 'file',
                  name: 'statement.pdf',
                  size: 1234,
                  direction: 'inbound',
                },
              },
            ],
          },
        },
      ]),
      config,
      'statement',
    );
    expect(out).toContain('attachment: statement.pdf (application/pdf)');
    expect(out).toContain('saved at /home/x/.sunny/media/inbound/x/0.pdf');
  });

  it('returns a no-match message when nothing is found', async () => {
    const config = makeConfig();
    const { execRecall } = await import('../agent/tools/memory.js');
    expect(await execRecall(fakeStore([]), config, 'zzz')).toMatch(/no past messages match/);
  });
});

describe('execRecallExpand — deep-fetch one row (context-lifecycle)', () => {
  const KATE = '+17193146820';
  const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  const dm = (num: string) => `sendblue:${b64('+16452438873')}:${b64(num)}`;

  function storeWith(row: Partial<import('../gateway/store.js').StoredMessage> | null) {
    return {
      messageById: async () =>
        row && {
          messageId: 'x',
          threadId: dm(KATE),
          role: 'assistant' as const,
          senderId: 'sunny',
          senderName: 'Sunny',
          text: 'flat text',
          payload: null,
          timestamp: new Date('2026-06-28T00:00:00Z'),
          isOwner: false,
          ...row,
        },
    } as unknown as import('../gateway/store.js').ConversationStore;
  }

  it('renders the full row: text, tool calls with outputs, attachment paths', async () => {
    const config = makeConfig();
    const { execRecallExpand } = await import('../agent/tools/memory.js');
    const out = await execRecallExpand(
      storeWith({
        payload: {
          parts: [
            { type: 'text', text: 'read your statement' },
            {
              type: 'tool-bash',
              toolCallId: 'c1',
              state: 'output-available',
              input: { command: 'pdftotext statement.pdf -' },
              output: 'total due: $412.50',
            },
            {
              type: 'data-attachment',
              data: { name: 'statement.pdf', mediaType: 'application/pdf', path: '/m/in/x/0.pdf' },
            },
          ],
        },
      }),
      config,
      'x',
    );
    expect(out).toContain('[id:x]');
    expect(out).toContain('read your statement');
    expect(out).toContain('[tool bash]');
    expect(out).toContain('total due: $412.50');
    expect(out).toContain('attachment: statement.pdf (application/pdf) — saved at /m/in/x/0.pdf');
  });

  it('caps the rendered row length (~20k)', async () => {
    const config = makeConfig();
    const { execRecallExpand } = await import('../agent/tools/memory.js');
    const out = await execRecallExpand(
      storeWith({
        payload: {
          parts: Array.from({ length: 20 }, (_, i) => ({
            type: 'text',
            text: `${i} ${'y'.repeat(4000)}`,
          })),
        },
      }),
      config,
      'x',
    );
    expect(out.length).toBeLessThan(21_000);
    expect(out).toContain('truncated at');
  });

  it('reports an unknown id actionably', async () => {
    const config = makeConfig();
    const { execRecallExpand } = await import('../agent/tools/memory.js');
    expect(await execRecallExpand(storeWith(null), config, 'nope')).toMatch(
      /no stored message with id/,
    );
  });
});
