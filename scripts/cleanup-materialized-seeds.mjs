#!/usr/bin/env node
/**
 * One-time cleanup (portability, task 5.1): the old seed mechanism materialized the
 * shipped skills into the authored skills repo (`~/.sunny/skills/authored/skills/`).
 * Those skills are now the read-only `builtin` tier (agent/builtin/skills/), so an
 * untouched materialized copy is pure residue — worse, it SHADOWS its builtin as a
 * stale "fork" the owner never made. This script deletes copies that are
 * byte-identical to ANY version the seeds ever shipped (28 revisions hashed below,
 * plus two hand-verified entries: the delegation fork whose one lesson was upstreamed
 * into the builtin, and the stale pre-runtime-home skill-authoring copy);
 * anything the owner or agent actually edited is left in place as an intentional
 * fork. Dry-run by default; `--apply` deletes + commits + pushes. Delete this
 * script once it has been run against the live authored repo.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

// name -> repo-relative file -> sha256 of every version ever shipped in seeds.ts.
const SHIPPED = {
  "dreaming": {
    "SKILL.md": [
      "11c716d95ab330d81be301e56ffff92827ad57dca1f35e69750ac4e386c337fd",
      "4dac1c7f4ec4e251fe7d0df9e375212d9fecb5f98b572bbdc962e6a84a84bbdc",
      "84f95207c87008311637190f4200a4c68fbbf124a681fb0b8ea847c35e14b4be",
      "c6bd054d720473b7de82d7ad8ded06cf73f1f31cce4bc5015e6c64e85042c5cb"
    ]
  },
  "coding": {
    "SKILL.md": [
      "bbd8ecd0a57d55c4d22a0f25531692bee6eef405f92e8bf5b984064d93e89288"
    ]
  },
  "delegation": {
    "SKILL.md": [
      "26b51739c113a82ad16070a7c4bc80e360fcc0f3314263afcd36351707e67eb9",
      "2b4739043610a171392738ae307805b53a1d390333ad076e3104df95f5affd92",
      "2c7f85bbd80b6abd6d6d5d7535ad9c4d51a5b318c62087b36fbef340f86d064a",
      "47453ee9f47c9ece3e5c25056633b195524adecd3b8744630490c87134f37f23",
      "5945705f8a1c37375071088675758b48b1a453c61b701fbe9df476551a4f0d5a",
      "b230cd40b2ba009dfeff52b90a8ba9a4e0ce429720bb31e62cfecd3c82fe4583",
      "bbae6054ad3093f8bbb49a345674f7f4c1d4d702df23dcf4f7ee96e8733ebf43",
      "c0ea30ada3669531515b5c5c86c7bf425c3d5fae64b7a65cf25944a38a75816a",
      "d97ff61e1542bbc7ea9dd6c97758f2e08c4f5551a871f980f7df1761bc505e48",
      "f9422df19daccd7b09f70d60807b28ae9387bdff49fca407697966bd224135d1"
    ]
  },
  "find-skills": {
    "SKILL.md": [
      "24e50d2ca56b8995ba26058c91a2cdeb6d22910cacacdba7dea2d74016c84195",
      "37f27a24a3720c8db98a7697c34ba19147f230dcdb3088a0c7c0ae9ce78bacf6",
      "73f7e9134753d40ecbab2daca5219be645704edc092d21beaefeff71da555d8d",
      "d27292b97fe498309d5c86f58265a72c5c997f039671f94d54590e735c33a0c7",
      "db445594522fdd4679094b03cacd4ec71ac38e863611b9774a9274a761065ebd"
    ]
  },
  "skill-authoring": {
    "SKILL.md": [
      "2aab36141beb7c46d2c3f387b3650d514aea5752fbec927e72f41a3a6fce71c3",
      "4845cbcefb4955a390cde24e7f97a64a51cf90c0149abeab96afa7be70929f88",
      "6060036ab52b098bc69e2782e240a146c25cf209af98c5bab3d0903249f5f610",
      "7e9e8d53218e62960d633754cc56505b77dae26d01c86b19fd7bbfb00cfb87f1",
      "80e1facdbea0b130ce26d87570d8649bf90ccd0a3a98b784faeeb2b65bcfbfe3",
      "8983ee459012160ee35295db034b67d50ea7e1838ccfe426dfacc83b1b781d87",
      "ae94f94f522d71512a60fa709851b976b30391448a328f6fab2029f5028b549e"
    ],
    "scripts/skill.mjs": [
      "0d64ce56dd2763fb4b4a5b544a919bd8832c519e6eab52e1f59cbafabcbcf9a6",
      "1ea64ec454e0e7d44239ca66fbf81c4b4bb0127076027578b9b659cfab50a677",
      "b3e02ddbfeb6510fadd7f8115581a2115d00f578ef7f26761640c3660bebf90c",
      "d69a5e5e2e8685c9a3e8d54ffe7416fc0b2d5dcafbe16ff349244cf3c8588c61"
    ]
  }
};

const apply = process.argv.includes('--apply');
const runtimeDir = process.env.SUNNY_HOME ?? join(homedir(), '.sunny');
const skillsRoot = join(runtimeDir, 'skills', 'authored', 'skills');

if (!existsSync(skillsRoot)) {
  console.log(`nothing to do: ${skillsRoot} does not exist`);
  process.exit(0);
}

const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

const toDelete = [];
for (const [name, files] of Object.entries(SHIPPED)) {
  const dir = join(skillsRoot, name);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    console.log(`- ${name}: not materialized (nothing to clean)`);
    continue;
  }
  const present = walk(dir).map((p) => relative(dir, p));
  const verdicts = present.map((rel) => {
    const shipped = files[rel];
    if (!shipped) return { rel, ok: false, why: 'file the seeds never shipped' };
    const ok = shipped.includes(sha(join(dir, rel)));
    return { rel, ok, why: ok ? 'matches a shipped version' : 'MODIFIED vs every shipped version' };
  });
  const clean = verdicts.every((v) => v.ok);
  if (clean) {
    toDelete.push(name);
    console.log(`- ${name}: never customized -> DELETE (builtin serves it now)`);
  } else {
    console.log(`- ${name}: KEEP as intentional fork (shadows the builtin):`);
    for (const v of verdicts.filter((v) => !v.ok)) console.log(`    ${v.rel}: ${v.why}`);
  }
}

if (toDelete.length === 0) {
  console.log('\nnothing deletable.');
  process.exit(0);
}
if (!apply) {
  console.log(`\ndry-run: would delete ${toDelete.length} skill(s): ${toDelete.join(', ')}`);
  console.log('re-run with --apply to delete + commit + push.');
  process.exit(0);
}

const authoredRoot = join(runtimeDir, 'skills', 'authored');
const git = (...args) =>
  execFileSync('git', ['-C', authoredRoot, ...args], { stdio: ['ignore', 'inherit', 'inherit'] });
for (const name of toDelete) git('rm', '-r', '-q', join('skills', name));
git(
  '-c', 'user.name=Sunny', '-c', 'user.email=sunny@sunny.invalid',
  'commit', '-q', '-m',
  'skills: remove materialized seed copies (now the builtin tier in the sunny repo)',
);
try {
  git('push', '--quiet');
  console.log(`\ndeleted ${toDelete.length} skill(s), committed, and pushed.`);
} catch {
  console.log(`\ndeleted ${toDelete.length} skill(s) and committed; PUSH FAILED - push manually.`);
}
