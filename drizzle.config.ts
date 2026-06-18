import { defineConfig } from 'drizzle-kit';

// DATABASE_URL is env-only; load it before running drizzle-kit (e.g. `node --env-file=.env`).
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://sunny:sunny@localhost:5544/sunny',
  },
});
