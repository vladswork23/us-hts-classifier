import type { Config } from 'drizzle-kit';

/**
 * Drizzle config for the local HTS Postgres database (HTS_DATABASE_URL).
 *
 *   pnpm hts:db:generate
 *   pnpm hts:db:migrate
 */
export default {
  schema: './lib/hts/db/schema.ts',
  out: './lib/hts/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.HTS_DATABASE_URL!,
  },
  verbose: true,
} satisfies Config;
