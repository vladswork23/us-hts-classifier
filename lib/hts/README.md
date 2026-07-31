# US-HTS Classifier Agent — architecture

Complements the top-level [README](../../README.md) (setup, eval methodology,
cost). This file covers internals: schema, tools, env vars.

## Environment variables

Set these in `.env` (see `.env.example` at repo root).

| Var | Purpose | Default |
| --- | --- | --- |
| `HTS_DATABASE_URL` | Local Postgres for the HTS tables. | — (required) |
| `OPENAI_API_KEY` | Powers the agent and the optional embeddings step. | — (required to classify) |
| `HTS_MODEL` | Model id for the agent. Swappable. | `gpt-5-mini` |
| `HTS_REASONING_EFFORT` | Responses API reasoning effort: `minimal` \| `low` \| `medium` \| `high`. | `medium` |

(Other knobs read by the code: `HTS_DB_POOL_MAX`, `HTS_MAX_OUTPUT_TOKENS`,
`HTS_EVAL_N`, `HTS_EVAL_CONCURRENCY`.)

## Setup sequence

```bash
# 1. Generate + apply the HTS schema migrations against HTS_DATABASE_URL
npm run db:generate
npm run db:migrate

# 2. Ingest the data: pull the official HTS, load the codes, pull Section/Chapter Notes
npm run hts:ingest       # = hts:pull && hts:load && hts:notes

# 3. Build the labeled eval set from CBP CROSS rulings (optional — a dated
#    snapshot is already committed under lib/hts/eval/snapshots/)
npm run hts:evalset

# 4. (Optional) Build pgvector embeddings for hybrid search — requires pgvector
npm run hts:embed
```

What each piece does:

- `hts:pull` — downloads the official HTS schedule from USITC (public, no key).
- `hts:load` — loads the codes into `hts_codes`, building the reconstructed
  `description_full` phrase (ancestor descriptions joined with each row) that FTS
  searches against.
- `hts:notes` — ingests the legally-binding Section and Chapter Notes into
  `hts_notes`.
- `hts:evalset` — derives `hts_eval_cases` (product text → correct code) from CBP
  CROSS rulings (public API).
- `hts:embed` — optional; adds the `vector` extension and an `embedding` column for
  hybrid search. Skipping it leaves the agent on pure full-text search.

All of these are `tsx` scripts that load `.env` and close the DB connection on
exit.

> Useful: `npm run db:studio` opens Drizzle Studio against the HTS DB.

## Architecture

**Data layer.** A local Postgres holding `hts_codes`, `hts_notes`,
`hts_rulings_cache`, and `hts_eval_cases`. Heading search is Postgres **full-text
search** (a `to_tsvector('english', description_full)` query, with an `ILIKE`
fallback) over the reconstructed `description_full` text, with an optional pgvector
hybrid path if you ran `hts:embed`.

**Agent.** `classifyHts()` (`lib/hts/classify.ts`) drives the **OpenAI Responses
API** as a tool loop. The model is given the GRI system prompt (`lib/hts/prompt.ts`)
and a set of read tools (`lib/hts/tools.ts`), and ends by calling a terminal tool:

- `search_headings` — FTS for candidate headings/subheadings (start here).
- `get_notes` — the Section + Chapter Notes for a chapter (GRI 1; decides most
  borderline cases).
- `expand_code` — list a code's children to drill 4 → 6 → 8 → 10 digits (GRI 6).
- `search_rulings` — query CBP CROSS **live** for how Customs classified similar
  goods (cached into `hts_rulings_cache`).
- `get_overlays` — flag Chapter 99 / Section 301 / Section 232 add-on duties.
- `submit_classification` — **terminal** tool that returns the structured result
  (`HtsClassifyResult`: code, GRI path, hierarchy, alternatives, supporting rulings,
  duty rates, confidence, and review flags).

CROSS is used both **live** (the `search_rulings` tool) and as the source for the
**eval set** (`hts_eval_cases`) — see the top-level README for how those two uses
differ and why that matters for reproducibility.

## Accuracy expectations

Picking the exact **10-digit** HTS line is genuinely hard, even for strong models —
the 9–10 digit statistical suffix is often a coin toss between near-identical lines.
Treat the agent as a strong assistant, not an authority — see the eval numbers in
the top-level README.

- Lean on `confidence` / `confidence_pct` and **`needs_human_review`** — the prompt
  is tuned to flag uncertainty rather than feign confidence.
- The 4- and 6-digit levels are far more reliable than the full 10.
- For higher accuracy, swap `HTS_MODEL` to a stronger model and raise
  `HTS_REASONING_EFFORT`. The default `gpt-5-mini` is the cheap baseline these
  eval numbers were run against.

## Notes

- **Model is swappable** via `HTS_MODEL` (or the `model` option on `classifyHts`);
  the agent calls the OpenAI **Responses API** directly via `fetch`, not an SDK,
  so swapping models needs no other code change.
- The loop chains turns with **`previous_response_id`** so the model's reasoning
  carries across tool calls — that is the main reason this is on the Responses API
  rather than Chat Completions.
- `lib/hts/db/client.ts` is lazy: importing it never opens a connection. The first
  query is what needs `HTS_DATABASE_URL`.
