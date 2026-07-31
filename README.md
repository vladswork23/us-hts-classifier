# US-HTS Classifier Agent

> Published mainly for the eval pipeline: how the eval set is mined from public
> data, how accuracy is measured per digit level, and what the numbers do and
> do not support.

An LLM agent that determines the correct **US HTS (HTSUS)** code for a product.
It does not guess from memory: it reasons over the official tariff schedule, the
legally-binding **Section/Chapter Notes**, and **CBP CROSS** ruling precedent,
applying the **General Rules of Interpretation (GRI 1–6)** in order to drill from
chapter → heading → subheading → 8-digit rate line → 10-digit statistical suffix.

> The HS is the 6-digit international code; the HTSUS extends it to 10 digits for
> US imports. This project targets the full 10-digit US code.

This was extracted from a larger internal product. It has **no web app, no
billing, no auth** — just the classification agent, its data layer, and its
eval pipeline.

## Prerequisites

- Node.js, and a local Postgres you can create a database in:
  ```bash
  createdb hts
  ```
- **Optional:** the `pgvector` extension, only if you want hybrid vector search
  (the `npm run hts:embed` step). The base agent works with **zero** embedding
  setup — the data layer uses Postgres full-text search out of the box.
- An OpenAI API key (billed — see "Cost" below).

## Setup

```bash
npm install
cp .env.example .env   # fill in HTS_DATABASE_URL and OPENAI_API_KEY

npm run db:generate && npm run db:migrate   # create the schema
npm run hts:ingest                          # pull HTS + notes from USITC (public, no key)
npm run hts:evalset                         # optional: mine a fresh eval set from CBP CROSS
```

`npm run hts:ingest` downloads ~20MB of official USITC data straight into
`data/hts/` (gitignored — see `data/hts/README.md` for the exact endpoints
used). Nothing under `data/hts/` is committed to this repo; it's fetched fresh
from the public source.

## Running the agent

```ts
import { classifyHts } from './lib/hts/classify';

const { result, usage } = await classifyHts('men\'s cotton knit t-shirt, short sleeve');
console.log(result.hs_code, result.confidence, usage.cost);
```

`classifyHts()` drives the OpenAI **Responses API** as a tool loop: the model
gets the GRI system prompt and read tools (`search_headings`, `get_notes`,
`expand_code`, `search_rulings`, `get_overlays`) and ends by calling a terminal
`submit_classification` tool. See `lib/hts/README.md` for the full
architecture.

## Eval pipeline — how the accuracy numbers are produced

This is the part worth reading closely if you're deciding whether to trust the
numbers below.

**Where the eval set comes from.** `lib/hts/scripts/04-build-evalset.ts` mines
[CBP CROSS](https://rulings.cbp.gov/), the public database of US Customs
ruling letters, via its public search API. For a fixed list of everyday
product terms it pulls rulings, keeps only ones that carry a plausible HTS
code, and stores them as `(product description → correct code)` pairs in
`hts_eval_cases`. This is fully reproducible from public data — anyone can run
`npm run hts:evalset` and mine their own set from the same public API.

**Case selection for a run** (`lib/hts/eval/run-eval.ts`) is deterministic SQL:
drop Chapter 98/99 (special provisions that depend on import circumstances,
not product text), drop labels whose code no longer exists in the current
schedule (~half of mined CROSS labels cite stale statistical suffixes — that
penalizes correct current answers), keep only 10-digit labels, and cap at 2
cases per 6-digit label so one over-mined product can't dominate the sample.

**What "reproducible" does and doesn't mean here.** The method is public and
scripted end to end — no manual or undocumented steps. But two honest caveats:

1. **CROSS is a live public database.** It gets new rulings and can be revised;
   re-mining today's set won't byte-for-byte match a set mined next month. The
   *methodology* reproduces; the *exact case list* drifts over time. That's why
   we commit dated snapshots (below) instead of just the script.
2. **Running the eval costs money.** It calls the OpenAI API per case, with
   several tool-call rounds each. There is no mock/offline mode.

**Committed snapshot** (`lib/hts/eval/snapshots/`): a mined eval set and a live
run's results, both dated, so you can inspect the exact numbers below **without
running anything or spending anything**:

- `eval-set.2026-07-31.json` — 89 cases selected by the SQL above, from a CROSS
  mine of ~520 candidate rulings.
- `eval-results.2026-07-31.json` — the actual `classifyHts()` output for each
  of those 89 cases, plus the summary below.

**Results, gpt-5-mini, `HTS_REASONING_EFFORT=medium`, N=89, 2026-07-31**
(primary metric: predicted code vs. *any* code the ruling assigned):

| Level | Accuracy | Strict (vs. primary code only) | Incl. alternatives |
|---|---|---|---|
| 2-digit (chapter) | 73.0% | 68.5% | 88.8% |
| 4-digit (heading) | 59.6% | 53.9% | 79.8% |
| 6-digit (HS subheading) | 44.9% | 41.6% | 59.6% |
| 8-digit (US rate line) | 38.2% | 36.0% | 47.2% |
| 10-digit (statistical suffix) | 32.6% | 31.5% | 39.3% |

0 errors across 89 cases. Avg cost/case: $0.059. Avg rounds: 8.03.

**Read this as**: the full 10-digit line is genuinely hard — even a
CROSS-precedent-aware GPT-5-mini agent gets it right roughly a third of the
time, and the "correct" answer itself is sometimes a judgment call between
near-identical statistical suffixes (see `deepestMatch: 'miss'` cases in the
snapshot — several are close misses, not wild swings). The 4- and 6-digit
levels, which is what most classification decisions actually turn on, are far
more reliable. Don't take this as a production-ready oracle; treat it as a
research prototype with `needs_human_review` flags for a reason.

To rerun yourself (after `npm run hts:evalset`):

```bash
HTS_EVAL_N=50 HTS_EVAL_CONCURRENCY=4 npm run hts:eval
```

## Cost

Classifying one product averages ~$0.06 on `gpt-5-mini` at 8 tool-call rounds
(see snapshot above). Running the full eval set is a few dollars, not cents —
budget accordingly before rerunning it at scale. Swap `HTS_MODEL` for a
cheaper or stronger model at any time (see `.env.example`); nothing else needs
to change since the agent calls the OpenAI Responses API directly.

## Known limitations

- **Single run, n=89.** gpt-5-mini is nondeterministic enough that identical
  code can swing ±10-15 points between runs at small n. The numbers above are
  one run, not an average. Treating any single figure here as the accuracy of
  this agent would be wrong.
- **What would make these trustworthy:** n≥150 and at least 3 runs averaged,
  with variance reported alongside the mean. That is the next thing on this repo.
- **CROSS labels are not ground truth.** A ruling's code is correct for the
  circumstances of that ruling. Several `deepestMatch: 'miss'` cases in the
  snapshot are defensible alternative classifications, not errors.

## License

MIT — see [LICENSE](LICENSE).

## More detail

`lib/hts/README.md` has the full architecture writeup: data layer, migrations,
tool definitions, and per-step description of the ingest pipeline.
