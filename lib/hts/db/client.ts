import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

/**
 * Isolated database layer for the US-HTS classifier.
 *
 * This is DELIBERATELY separate from `lib/db/drizzle.ts` (the Supabase /
 * POSTGRES_URL connection the live app uses). It connects to a LOCAL Postgres
 * via HTS_DATABASE_URL and is fully lazy: importing this module never opens a
 * connection and never throws. That guarantees the existing Vercel deploy —
 * which has no local DB and no HTS_DATABASE_URL — is completely unaffected.
 *
 * Nothing in this folder may import `@/lib/db/drizzle` or `@/lib/db/queries`.
 * Conversely the existing app must never import this module. Keep the two DB
 * worlds fully disjoint.
 */

export function htsConfigured(): boolean {
  return Boolean(process.env.HTS_DATABASE_URL);
}

const globalForHts = globalThis as unknown as {
  __htsPgClient?: ReturnType<typeof postgres>;
  __htsDrizzleDb?: ReturnType<typeof drizzle<typeof schema>>;
};

function createClient() {
  const url = process.env.HTS_DATABASE_URL;
  if (!url) {
    throw new Error(
      'HTS_DATABASE_URL is not set. The HTS classifier uses its own local Postgres ' +
        'database, separate from the app Supabase connection. Set HTS_DATABASE_URL in ' +
        '.env — see lib/hts/README.md.',
    );
  }
  const isDev = process.env.NODE_ENV !== 'production';
  const poolMax = Number(process.env.HTS_DB_POOL_MAX || (isDev ? 1 : 5));

  return postgres(url, {
    onnotice: () => {},
    max: poolMax,
    idle_timeout: 20,
    connect_timeout: 15,
    // No `prepare: false` here: this is plain local Postgres, not a pgbouncer
    // pool, so prepared statements are fine and faster.
  });
}

/** Raw postgres-js client — use for FTS / pgvector / DDL via tagged-template SQL. */
export function getHtsClient() {
  if (!globalForHts.__htsPgClient) {
    globalForHts.__htsPgClient = createClient();
  }
  return globalForHts.__htsPgClient;
}

/** Drizzle instance — use for typed CRUD against the schema in ./schema.ts. */
export function getHtsDb() {
  if (!globalForHts.__htsDrizzleDb) {
    globalForHts.__htsDrizzleDb = drizzle(getHtsClient(), { schema });
  }
  return globalForHts.__htsDrizzleDb;
}

/** Close the connection (call at the end of one-off tsx scripts so the process exits). */
export async function closeHtsDb() {
  if (globalForHts.__htsPgClient) {
    await globalForHts.__htsPgClient.end({ timeout: 5 });
    globalForHts.__htsPgClient = undefined;
    globalForHts.__htsDrizzleDb = undefined;
  }
}
