import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyMemoryWrite,
  ensureAndLoadPeople,
  MemoryOverflowError,
  memoryPaths,
  personId,
  sanitizePersonId,
  sanitizeTopic,
} from './index.js';
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

  function fakeStore(hits: Array<Partial<import('../gateway/store.js').StoredMessage>>) {
    return {
      recall: async () =>
        hits.map((h) => ({
          messageId: 'x',
          threadId: dm(KATE),
          role: 'user' as const,
          senderId: KATE,
          senderName: 'Kate',
          text: 'hi',
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
    expect(out).toContain('Kate (in the chat with Kate): met you today');
    expect(out).toContain('Devon (in the chat with Devon): you met Kate!');
    expect(out).toContain('(in a group chat): in the group');
  });

  it('returns a no-match message when nothing is found', async () => {
    const config = makeConfig();
    const { execRecall } = await import('../agent/tools/memory.js');
    expect(await execRecall(fakeStore([]), config, 'zzz')).toMatch(/no past messages match/);
  });
});
