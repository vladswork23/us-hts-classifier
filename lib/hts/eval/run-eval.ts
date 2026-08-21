import 'dotenv/config';

import { getHtsClient, closeHtsDb } from '@/lib/hts/db/client';
import { classifyHts } from '@/lib/hts/classify';
import { langfuseEnabled, getLangfuse, flushLangfuse } from '@/lib/hts/langfuse';

/**
 * Evaluate the HTS classifier against the labeled CROSS eval set.
 *
 * Reads cases from hts_eval_cases, runs classifyHts() over a small promise pool,
 * and scores predicted-vs-correct at HTS digit prefixes 2/4/6/8/10. Prints a
 * per-case line and a SUMMARY of accuracy@L plus average cost / time / rounds /
 * tool calls.
 *
 *   npx tsx lib/hts/eval/run-eval.ts            # HTS_EVAL_N or 50 cases
 *   npx tsx lib/hts/eval/run-eval.ts 20         # override N to 20
 *   HTS_EVAL_CONCURRENCY=5 npx tsx lib/hts/eval/run-eval.ts
 */

/** The digit-prefix levels we score accuracy at. */
const LEVELS = [2, 4, 6, 8, 10] as const;
type Level = (typeof LEVELS)[number];

interface EvalCaseRow {
  ruling_number: string;
  product_text: string;
  correct_code: string;
  all_codes: unknown;
}

/** All codes the ruling assigned, digits-only, primary first. */
function labelCodes(c: EvalCaseRow): string[] {
  const all = Array.isArray(c.all_codes) ? (c.all_codes as unknown[]) : [];
  const out = [c.correct_code, ...all.map(String)].map(digitsOnly).filter(Boolean);
  return [...new Set(out)];
}

interface CaseResult {
  rulingNumber: string;
  correctCode: string;
  predictedCode: string;
  /** Digits-only correct code, for denominator decisions. */
  correctDigits: string;
  /** Deepest level matched (0 if none / error / shallower than 2). */
  deepestMatch: number;
  /** Strict: predicted hs_code vs the ruling's PRIMARY code only. */
  matchedStrict: Record<Level, boolean>;
  /** Predicted hs_code vs ANY code the ruling assigned (label-set metric —
   * rulings often classify several items; tariffs[0] is not the only truth). */
  matched: Record<Level, boolean>;
  /** Candidate set (hs_code + alternatives) vs ANY ruling code. */
  matchedAny: Record<Level, boolean>;
  confidence: string;
  rounds: number;
  cost: number;
  processingTime: number;
  toolCalls: number;
  verified: boolean;
  error?: string;
}

/** Strip everything but digits so "6109.10.00.04" -> "6109100004". */
function digitsOnly(code: string | null | undefined): string {
  return (code ?? '').replace(/\D/g, '');
}

/** A case matches at level L if both codes have >= L digits and agree on the first L. */
function matchesAtLevel(predDigits: string, correctDigits: string, level: number): boolean {
  if (predDigits.length < level || correctDigits.length < level) return false;
  return predDigits.slice(0, level) === correctDigits.slice(0, level);
}

/** Run `worker` over `items` with at most `concurrency` in flight, preserving input order. */
async function promisePool<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length || 1));

  async function runner(): Promise<void> {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: limit }, () => runner()));
  return results;
}

function pct(n: number, d: number): string {
  if (d === 0) return 'n/a';
  return `${((n / d) * 100).toFixed(1)}%`;
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(5)}`;
}

async function run(): Promise<void> {
  const argN = Number(process.argv[2]);
  const N = Number.isFinite(argN) && argN > 0 ? argN : Number(process.env.HTS_EVAL_N || 50);
  const concurrency = Number(process.env.HTS_EVAL_CONCURRENCY || 3);

  const sql = getHtsClient();
  // Groups every case's trace under one run in the Langfuse UI (Sessions view).
  // No-op when Langfuse isn't configured.
  const runId = `eval-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  if (langfuseEnabled()) console.log(`Langfuse session: ${runId}`);

  // Case selection (deterministic):
  // - label must still exist verbatim in the loaded HTS schedule (over half the
  //   mined CROSS labels are decades old and use stale statistical suffixes —
  //   scoring against those penalizes correct current codes);
  // - no Chapter 98/99 labels (special provisions depend on import
  //   circumstances, unknowable from the product text);
  // - 10-digit labels only, recent-first (recent rulings cite the current
  //   schedule and have cleaner subject lines);
  // - at most 2 cases per 6-digit label, so one over-mined product (e.g.
  //   "plastic water bottle" -> 3924.10.4000 eight times) can't dominate.
  const cases = (await sql`
    WITH labeled AS (
      SELECT e.ruling_number, e.product_text, e.correct_code, e.all_codes, e.ruling_date,
             regexp_replace(e.correct_code, '[^0-9]', '', 'g') AS label_digits
      FROM hts_eval_cases e
      WHERE e.correct_code NOT LIKE '98%'
        AND e.correct_code NOT LIKE '99%'
        AND length(regexp_replace(e.correct_code, '[^0-9]', '', 'g')) >= 10
        AND EXISTS (
          SELECT 1 FROM hts_codes h
          WHERE regexp_replace(h.htsno, '[^0-9]', '', 'g') = regexp_replace(e.correct_code, '[^0-9]', '', 'g')
        )
    ),
    ranked AS (
      SELECT *, row_number() OVER (
        PARTITION BY substring(label_digits, 1, 6)
        ORDER BY ruling_date DESC, ruling_number
      ) AS rn
      FROM labeled
    )
    SELECT ruling_number, product_text, correct_code, all_codes
    FROM ranked
    WHERE rn <= 2
    ORDER BY ruling_date DESC, ruling_number
    LIMIT ${N}
  `) as unknown as EvalCaseRow[];

  if (cases.length === 0) {
    console.error('No eval cases found in hts_eval_cases. Seed the eval set first.');
    process.exit(1);
  }

  console.log(`Running eval over ${cases.length} case(s), concurrency=${concurrency}\n`);

  const results = await promisePool<EvalCaseRow, CaseResult>(
    cases,
    concurrency,
    async (c) => {
      const correctDigits = digitsOnly(c.correct_code);
      const labels = labelCodes(c);
      const base: CaseResult = {
        rulingNumber: c.ruling_number,
        correctCode: c.correct_code,
        predictedCode: '',
        correctDigits,
        deepestMatch: 0,
        matchedStrict: { 2: false, 4: false, 6: false, 8: false, 10: false },
        matched: { 2: false, 4: false, 6: false, 8: false, 10: false },
        matchedAny: { 2: false, 4: false, 6: false, 8: false, 10: false },
        confidence: '',
        rounds: 0,
        cost: 0,
        processingTime: 0,
        toolCalls: 0,
        verified: false,
      };

      try {
        const { result, usage } = await classifyHts(c.product_text, { sessionId: runId });
        const predDigits = digitsOnly(result.hs_code);
        // The candidate set the product would surface: primary code + alternatives.
        const candidateDigits = [result.hs_code, ...(result.alternatives || []).map((a) => a.code)]
          .map(digitsOnly)
          .filter(Boolean);
        let deepest = 0;
        for (const level of LEVELS) {
          base.matchedStrict[level] = matchesAtLevel(predDigits, correctDigits, level);
          const ok = labels.some((l) => matchesAtLevel(predDigits, l, level));
          base.matched[level] = ok;
          if (ok) deepest = level;
          base.matchedAny[level] = candidateDigits.some((d) =>
            labels.some((l) => matchesAtLevel(d, l, level)),
          );
        }
        // Attach the ground-truth eval scores to this case's trace — this is
        // the reference-based metric (predicted digit-prefix vs the CROSS
        // label), sitting right on the same trace the agent produced, next to
        // the objective calibration score classifyHts() already recorded.
        if (usage.traceId) {
          const lf = getLangfuse();
          lf.score({ traceId: usage.traceId, name: 'deepest_match_level', value: deepest });
          lf.score({
            traceId: usage.traceId,
            name: 'accuracy_at_10',
            value: base.matched[10] ? 1 : 0,
          });
        }
        return {
          ...base,
          predictedCode: result.hs_code,
          deepestMatch: deepest,
          confidence: result.confidence,
          rounds: usage.rounds,
          cost: usage.cost,
          processingTime: usage.processingTime,
          toolCalls: usage.toolCalls,
          verified: usage.verified,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`  [ERROR] ${c.ruling_number}: ${msg}`);
        // Counted as a miss at every level (matched stays all-false).
        return { ...base, error: msg };
      }
    },
  );

  // Per-case lines.
  for (const r of results) {
    const predDisplay = r.error ? `ERROR (${r.error.slice(0, 60)})` : r.predictedCode || '(none)';
    const levelDisplay = r.deepestMatch > 0 ? `@${r.deepestMatch}` : 'miss';
    console.log(
      `${r.rulingNumber} | ${r.correctCode} vs ${predDisplay} | ` +
        `${levelDisplay} | conf=${r.confidence || 'n/a'} | ` +
        `rounds=${r.rounds} | cost=${fmtUsd(r.cost)}`,
    );
  }

  // Accuracy@L: denominator = cases whose correct_code has >= L digits.
  const hitsStrict: Record<Level, number> = { 2: 0, 4: 0, 6: 0, 8: 0, 10: 0 };
  const hits: Record<Level, number> = { 2: 0, 4: 0, 6: 0, 8: 0, 10: 0 };
  const hitsAny: Record<Level, number> = { 2: 0, 4: 0, 6: 0, 8: 0, 10: 0 };
  const denom: Record<Level, number> = { 2: 0, 4: 0, 6: 0, 8: 0, 10: 0 };
  for (const r of results) {
    for (const level of LEVELS) {
      if (r.correctDigits.length >= level) {
        denom[level]++;
        if (r.matchedStrict[level]) hitsStrict[level]++;
        if (r.matched[level]) hits[level]++;
        if (r.matchedAny[level]) hitsAny[level]++;
      }
    }
  }

  const total = results.length;
  const errors = results.filter((r) => r.error).length;
  const sum = (sel: (r: CaseResult) => number) => results.reduce((acc, r) => acc + sel(r), 0);
  const avg = (sel: (r: CaseResult) => number) => (total === 0 ? 0 : sum(sel) / total);

  console.log('\n=== SUMMARY ===');
  console.log(`N: ${total} (errors: ${errors})`);
  console.log('(primary metric = predicted code vs ANY code the ruling assigned)');
  for (const level of LEVELS) {
    console.log(
      `accuracy@${level}: ${pct(hits[level], denom[level])} (${hits[level]}/${denom[level]})` +
        `   |  strict vs tariffs[0]: ${pct(hitsStrict[level], denom[level])}` +
        `   |  incl. alternatives: ${pct(hitsAny[level], denom[level])} (${hitsAny[level]}/${denom[level]})`,
    );
  }
  const verifiedCount = results.filter((r) => r.verified).length;
  if (verifiedCount) console.log(`verifier ran on: ${verifiedCount}/${total} cases`);
  console.log(`avg cost: ${fmtUsd(avg((r) => r.cost))}`);
  console.log(`avg processingTime: ${avg((r) => r.processingTime).toFixed(0)} ms`);
  console.log(`avg rounds: ${avg((r) => r.rounds).toFixed(2)}`);
  console.log(`avg toolCalls: ${avg((r) => r.toolCalls).toFixed(2)}`);

  await flushLangfuse();
}

run()
  .then(async () => {
    await closeHtsDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Eval run failed:', error);
    try {
      await closeHtsDb();
    } catch {
      // ignore close errors during failure exit
    }
    process.exit(1);
  });
