import { Langfuse } from 'langfuse';

/**
 * Lazy Langfuse Cloud client for the HTS agent's tracing/observability.
 *
 * Follows the same pattern as `db/client.ts` and `embeddings.ts`: importing
 * this module never talks to the network, and the rest of the agent degrades
 * gracefully (no traces, but no errors either) when the env vars are absent —
 * Langfuse is optional instrumentation, not a hard dependency to classify.
 */

let _client: Langfuse | null = null;

export function langfuseEnabled(): boolean {
  return Boolean(process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY);
}

export function getLangfuse(): Langfuse {
  if (!_client) {
    _client = new Langfuse({
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      // Cloud only: EU (default) or US region. Set LANGFUSE_BASEURL to
      // "https://us.cloud.langfuse.com" for the US region.
      baseUrl: process.env.LANGFUSE_BASEURL || 'https://cloud.langfuse.com',
    });
  }
  return _client;
}

/** Flush queued events before the process exits (CLI scripts, eval runs). */
export async function flushLangfuse(): Promise<void> {
  if (_client) await _client.flushAsync();
}
