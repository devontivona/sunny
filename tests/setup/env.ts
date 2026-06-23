// Make ANTHROPIC_API_KEY available to real-model tests both locally (from .env)
// and in CI (from the secret env). No-op when the key is already set. Only the one
// key is loaded — we deliberately do NOT pull the rest of .env (e.g. the prod
// DATABASE_URL) into the test environment.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

if (!process.env.ANTHROPIC_API_KEY) {
  const envPath = join(process.cwd(), '.env');
  if (existsSync(envPath)) {
    const line = readFileSync(envPath, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('ANTHROPIC_API_KEY='));
    if (line) process.env.ANTHROPIC_API_KEY = line.slice('ANTHROPIC_API_KEY='.length).trim();
  }
}
