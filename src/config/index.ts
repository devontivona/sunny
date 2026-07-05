import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Non-secret configuration (D-PS5). Lives in `~/.sunny/config.json`, hand-editable.
 * Secrets are env-only (ANTHROPIC_API_KEY, SENDBLUE_*) and never appear here.
 */
export const ConfigSchema = z.object({
  /** AI SDK model id (D-PS3). Provider-agnostic; Sonnet 5 is the default. */
  modelId: z.string().default('claude-sonnet-5'),
  /** The cheap utility model: powers the interim-progress translator and the
   *  abnormal-turn-end backstop (src/agent/recovery.ts). Defaults to Haiku. */
  utilityModelId: z.string().default('claude-haiku-4-5'),
  /** Extended thinking for conversational turns: `adaptive` (default) or `off`. */
  thinking: z.enum(['adaptive', 'off']).default('adaptive'),
  /** Reasoning effort for agentic turns when thinking is on (D-PS3). */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  /**
   * Interim-progress translator cadence (text delivery mode only). On a multi-step turn a
   * cheap model relays short progress updates to the user: the first fires on the FIRST
   * non-terminal step (an immediate "on it…" beat), then every N steps after (steps 1, 1+N,
   * 1+2N, …). Silence is the translator's default — it declines when there's no
   * user-relevant news. The translator model is `recoveryModelId`.
   */
  translatorEveryNSteps: z.number().int().positive().default(3),
  /**
   * How relayed translator updates render in the model's HISTORY at read time (text mode):
   * `attributed` — as `[progress update relayed to <user>: "…"]` lines, so the model knows
   * what the user already heard and the final reply doesn't repeat it; `excluded` — stripped
   * entirely (the A/B arm). Rows always persist the updates as `data-translator` parts;
   * this toggle is read-time only, so flipping it needs no migration.
   */
  translatorHistory: z.enum(['attributed', 'excluded']).default('attributed'),
  /** Devon's timezone (used by scheduling later). */
  timezone: z.string().default('America/New_York'),
  /** Owner identity allowlist — phone numbers / emails (messaging-gateway D-MG6, task 2.4). */
  owner: z
    .object({
      name: z.string().default('Devon'),
      identities: z.array(z.string()).default([]),
    })
    .default({ name: 'Devon', identities: [] }),
  /**
   * Family roster (multiplayer-family D1): people who message Sunny with the SAME elevated
   * trust tier as the owner. Each entry has a display name and one or more stable identities
   * (phone/email), matched with the same normalization as `owner`. Shaped generally so a
   * future lower-trust `friend` tier is a data change, not a schema change. Identity here is
   * the channel-stable address — no cryptographic pairing yet (that lands in security-permissions).
   */
  family: z
    .array(
      z.object({
        name: z.string(),
        identities: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  /** Whether to answer in authorized group chats (R1: answerable, owner-only actions). */
  allowGroups: z.boolean().default(true),
  /** Recent-window size for the conversation store (task 2.3). */
  recentWindowSize: z.number().int().positive().default(30),
  /** Caps for the always-on core memory files (agent-memory D2). */
  memory: z
    .object({
      userMaxChars: z.number().int().positive().default(8000),
      sunnyMaxChars: z.number().int().positive().default(6000),
      indexMaxChars: z.number().int().positive().default(2000),
    })
    .default({ userMaxChars: 8000, sunnyMaxChars: 6000, indexMaxChars: 2000 }),
  /** Durable `state` repository (runtime-home). Names the owner-controlled PRIVATE
   *  remote that backs `~/.sunny/state/` (memory + credentials + sites). Mirrors how
   *  `skills.repo` bootstraps the skills clone: on a fresh host the state dir is cloned
   *  from here; otherwise it's pushed to here on the periodic sync cadence. Optional —
   *  with no remote, state is still committed locally (history, no offsite backup). */
  state: z
    .object({
      /** PRIVATE state remote (owner/repo or URL). Never public — it carries memory
       *  and `op://` references (no secret values, but still owner-private). */
      repo: z.string().optional(),
    })
    .default({}),
  /** Always-on skills index budget (agent-skills D-SK2) + optional dedicated repo (D-SK8). */
  skills: z
    .object({
      /** Max skills shown in the always-on index (rest are dropped, names retained later). */
      maxSkills: z.number().int().positive().default(20),
      /** Max chars per skill description in the index. */
      descriptionMaxChars: z.number().int().positive().default(280),
      /** Primary canonical skill repo (owner/repo or URL): the WRITABLE store of record
       *  for self-authored skills, cloned to `~/.sunny/skills/authored` (D-SK8). */
      repo: z.string().optional(),
      /** Additional OWNED skill repos (owner/repo or URL): read-only sources cloned to
       *  `~/.sunny/skills/trusted/<slug>` and ff-synced alongside the primary (D-SK8). Add
       *  more anytime; Sunny never writes to these. */
      repos: z.array(z.string()).default([]),
    })
    .default({ maxSkills: 20, descriptionMaxChars: 280, repos: [] }),
  server: z
    .object({
      /** HTTP webhook listener port (task 2.2). */
      port: z.number().int().positive().default(8787),
      /** Inbound webhook path Sendblue POSTs to. */
      webhookPath: z.string().default('/webhooks/sendblue'),
    })
    .default({ port: 8787, webhookPath: '/webhooks/sendblue' }),
});

export type SunnyConfig = z.infer<typeof ConfigSchema> & {
  /** Absolute path to the runtime dir (`~/.sunny`), injected at load time. */
  runtimeDir: string;
};

const DEFAULT_CONFIG_JSON = `{
  "modelId": "claude-sonnet-5",
  "utilityModelId": "claude-haiku-4-5",
  "effort": "high",
  "timezone": "America/New_York",
  "owner": {
    "name": "Devon",
    "identities": []
  },
  "family": [],
  "allowGroups": true,
  "recentWindowSize": 30,
  "memory": {
    "userMaxChars": 8000,
    "sunnyMaxChars": 6000,
    "indexMaxChars": 2000
  },
  "state": {},
  "skills": {
    "maxSkills": 20,
    "descriptionMaxChars": 280
  },
  "server": {
    "port": 8787,
    "webhookPath": "/webhooks/sendblue"
  }
}
`;

/** Resolve the runtime dir (`~/.sunny`, overridable via SUNNY_HOME). A plain
 *  namespace directory — NOT a git repo (runtime-home). `config.json` lives here as
 *  local, unsynced bootstrap; durable state lives in the `state/` repo (see
 *  {@link stateDir}) and skills/media are independent siblings. */
export function runtimeDir(): string {
  return process.env.SUNNY_HOME ?? join(homedir(), '.sunny');
}

/** The `state` repository working tree (`~/.sunny/state`, runtime-home). A git repo
 *  tracking durable, portable state — memory, the credential registry, and sites —
 *  backed by an owner-controlled private remote (`config.state.repo`). A sibling of
 *  `skills/` and `media/`, so no repo nests inside another's tracked tree. */
export function stateDir(runtimeDir: string): string {
  return join(runtimeDir, 'state');
}

/** Site working dirs (e.g. the website-builder skill's output): `~/.sunny/state/sites`,
 *  tracked by the `state` repo. */
export function sitesDir(runtimeDir: string): string {
  return join(stateDir(runtimeDir), 'sites');
}

/**
 * Load `~/.sunny/config.json`, creating the runtime dir and seeding a default
 * config file on first run (D-PS5). `config.json` is the LOCAL, UNSYNCED bootstrap
 * (runtime-home): it names the `state` and `skills` remotes that Sunny clones from,
 * so it must exist before any clone and is never tracked by the `state` repo. The
 * `state/` repo and skill clones are materialized later (initMemory / initSkills).
 */
export function loadConfig(): SunnyConfig {
  const dir = runtimeDir();
  mkdirSync(dir, { recursive: true });

  const configPath = join(dir, 'config.json');
  if (!existsSync(configPath)) {
    writeFileSync(configPath, DEFAULT_CONFIG_JSON, { mode: 0o644 });
  }

  const raw: unknown = JSON.parse(readFileSync(configPath, 'utf8'));
  const parsed = ConfigSchema.parse(raw);
  return { ...parsed, runtimeDir: dir };
}
