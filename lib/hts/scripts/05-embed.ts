import 'dotenv/config';

/**
 * 05-embed.ts — OPTIONAL pgvector hybrid-search enhancement.
 *
 * This step is NOT required for the classifier to work: the agent's
 * `search_headings` tool runs on Postgres full-text search (FTS) alone. This
 * script merely prepares per-row embeddings of `description_full` so that a
 * future change can add vector / hybrid search.
 *
 * Wiring vector search into `lib/hts/tools.ts` `search_headings` (e.g. blending
 * `ts_rank` with `embedding <=> query_embedding`) is a deliberate FOLLOW-UP and
 * is intentionally not done here.
 *
 * Requirements:
 *   - HTS_DATABASE_URL pointing at a local Postgres that has the `pgvector`
 *     extension AVAILABLE (so `CREATE EXTENSION vector` can succeed).
 *   - OPENAI_API_KEY set. If it is missing, this script skips cleanly (exit 0)
 *     rather than failing the pipeline.
 *
 * Run: npx tsx lib/hts/scripts/05-embed.ts
 */

import OpenAI from 'openai';
import { getHtsClient, closeHtsDb } from '@/lib/hts/db/client';

const EMBED_MODEL = 'text-embedding-3-small';
const EMBED_DIM = 1536;
const BATCH_SIZE = 100;

interface PendingRow {
  id: number;
  description_full: string;
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.log(
      '[05-embed] skipping — OPENAI_API_KEY not set. This step is optional; ' +
        'the classifier works on full-text search alone.',
    );
    process.exit(0);
  }

  const sql = getHtsClient();
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // Ensure pgvector extension and the embedding column exist. The dimension is
  // fixed (text-embedding-3-small => 1536) so it's a literal, not a parameter.
  console.log('[05-embed] ensuring pgvector extension and embedding column...');
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`ALTER TABLE hts_codes ADD COLUMN IF NOT EXISTS embedding vector(1536)`;

  // Rows that need embedding: real HTS lines (non-empty htsno) without one yet.
  const pending = (await sql`
    SELECT id, description_full
    FROM hts_codes
    WHERE htsno <> '' AND embedding IS NULL
    ORDER BY id ASC
  `) as unknown as PendingRow[];

  if (pending.length === 0) {
    console.log('[05-embed] nothing to embed — all eligible rows already have embeddings.');
    await ensureIndex(sql);
    await finish();
    return;
  }

  console.log(
    `[05-embed] ${pending.length} rows to embed (model=${EMBED_MODEL}, batch=${BATCH_SIZE}).`,
  );

  let embedded = 0;
  const totalBatches = Math.ceil(pending.length / BATCH_SIZE);

  for (let start = 0; start < pending.length; start += BATCH_SIZE) {
    const batch = pending.slice(start, start + BATCH_SIZE);
    const batchNum = Math.floor(start / BATCH_SIZE) + 1;

    // The OpenAI embeddings endpoint rejects empty strings; fall back to a
    // single space so the indices in `res.data` line up with `batch`.
    const inputs = batch.map((r) => r.description_full?.trim() || ' ');

    const res = await openai.embeddings.create({
      model: EMBED_MODEL,
      input: inputs,
    });

    for (let i = 0; i < batch.length; i++) {
      const vec = res.data[i]?.embedding;
      if (!vec || vec.length !== EMBED_DIM) {
        console.warn(
          `[05-embed] unexpected embedding for id=${batch[i].id} (len=${vec?.length ?? 'none'}); skipping row.`,
        );
        continue;
      }
      const literal = '[' + vec.join(',') + ']';
      await sql`UPDATE hts_codes SET embedding = ${literal}::vector WHERE id = ${batch[i].id}`;
      embedded++;
    }

    console.log(
      `[05-embed] batch ${batchNum}/${totalBatches} done — embedded ${embedded}/${pending.length}.`,
    );

    // Be polite to the OpenAI API between batches.
    if (start + BATCH_SIZE < pending.length) {
      await delay(250);
    }
  }

  await ensureIndex(sql);
  console.log(`[05-embed] complete — embedded ${embedded} rows.`);
  await finish();
}

async function ensureIndex(sql: ReturnType<typeof getHtsClient>) {
  console.log('[05-embed] ensuring HNSW cosine index...');
  // HNSW (graph-based, no k-means) is robust on large sets. ivfflat's
  // ElkanKmeans can fail with 54000 (program_limit_exceeded) when
  // maintenance_work_mem is low; HNSW avoids that. Bump the mem for the build.
  await sql`SET maintenance_work_mem = '512MB'`;
  await sql`
    CREATE INDEX IF NOT EXISTS hts_codes_embedding_idx
    ON hts_codes USING hnsw (embedding vector_cosine_ops)
  `;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function finish() {
  await closeHtsDb();
  process.exit(0);
}

main().catch(async (error) => {
  console.error('[05-embed] failed:', error);
  await closeHtsDb().catch(() => {});
  process.exit(1);
});
