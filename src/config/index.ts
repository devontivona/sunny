import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Non-secret configuration (D-PS5). Lives in `~/.sunny/config.json`, hand-editable.
 * Secrets are env-only (ANTHROPIC_API_KEY, SENDBLUE_*) and never appear here.
 */
const ConfigSchema = z.object({
  /** AI SDK model id (D-PS3). Provider-agnostic; Opus 4.8 is the default. */
  modelId: z.string().default('claude-opus-4-8'),
  /** Reasoning effort for agentic turns (D-PS3). */
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  /** Devon's timezone (used by scheduling later). */
  timezone: z.string().default('America/New_York'),
  /** Owner identity allowlist — phone numbers / emails (messaging-gateway D-MG6, task 2.4). */
  owner: z
    .object({
      name: z.string().default('Devon'),
      identities: z.array(z.string()).default([]),
    })
    .default({ name: 'Devon', identities: [] }),
  /** Whether to answer in authorized group chats (R1: answerable, owner-only actions). */
  allowGroups: z.boolean().default(true),
  /** Recent-window size for the trivial conversation store (task 2.3). */
  recentWindowSize: z.number().int().positive().default(30),
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
  "modelId": "claude-opus-4-8",
  "effort": "high",
  "timezone": "America/New_York",
  "owner": {
    "name": "Devon",
    "identities": []
  },
  "allowGroups": true,
  "recentWindowSize": 30,
  "server": {
    "port": 8787,
    "webhookPath": "/webhooks/sendblue"
  }
}
`;

/** Resolve the runtime dir (`~/.sunny`, overridable via SUNNY_HOME). */
export function runtimeDir(): string {
  return process.env.SUNNY_HOME ?? join(homedir(), '.sunny');
}

/**
 * Load `~/.sunny/config.json`, creating the runtime dir and seeding a default
 * config file on first run (D-PS5). The single `~/.sunny` git repo for
 * memory/skills is created later (Phase 2); for now we just need the dir + config.
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
