import OpenAI from 'openai';

/**
 * Shared embedding helper for the HTS classifier's optional hybrid search.
 *
 * Uses OpenAI `text-embedding-3-small` (1536-dim) via the `openai` SDK the app
 * already depends on — this is the ONE place the HTS code calls OpenAI through
 * the SDK (the agent loop in classify.ts uses raw fetch to the Responses API).
 * OpenRouter is not used here: it does not expose embeddings well, and `05-embed`
 * + `search_headings` both need the same model, so we go straight to OpenAI.
 *
 * If OPENAI_API_KEY is absent, callers should skip embedding and fall back to
 * full-text search — `embeddingsEnabled()` gates that.
 */

export const EMBED_MODEL = 'text-embedding-3-small';
export const EMBED_DIM = 1536;

let _client: OpenAI | null = null;

function client(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY is not set — cannot embed.');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

export function embeddingsEnabled(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

/** Embed a single string. Empty input is sent as a space (the API rejects ''). */
export async function embedOne(text: string): Promise<number[]> {
  const res = await client().embeddings.create({
    model: EMBED_MODEL,
    input: text.trim() || ' ',
  });
  return res.data[0].embedding as number[];
}

/** Embed a batch; result order matches input order. Empty strings -> ' '. */
export async function embedMany(texts: string[]): Promise<number[][]> {
  const res = await client().embeddings.create({
    model: EMBED_MODEL,
    input: texts.map((t) => t.trim() || ' '),
  });
  return res.data.map((d) => d.embedding as number[]);
}

/** Format a vector for a pgvector literal: [0.1,0.2,...] (cast `::vector` in SQL). */
export function toVectorLiteral(v: number[]): string {
  return '[' + v.join(',') + ']';
}
