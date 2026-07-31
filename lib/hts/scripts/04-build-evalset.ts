import 'dotenv/config';

import { getHtsClient, closeHtsDb } from '@/lib/hts/db/client';

/**
 * 04-build-evalset.ts
 *
 * Builds a labeled evaluation set for the US-HTS classifier by mining CBP CROSS
 * rulings. For a fixed list of diverse, everyday product terms we query the
 * public CROSS search API, keep only rulings that carry a plausible HTS code,
 * dedupe across terms, and upsert them into `hts_eval_cases` as
 * (product_text -> correct_code) pairs.
 *
 *   npx tsx lib/hts/scripts/04-build-evalset.ts
 *
 * Requires HTS_DATABASE_URL (loaded via dotenv above). Polite to the public API:
 * a small delay between calls and a hard fetch timeout.
 */

const CROSS_SEARCH_URL = 'https://rulings.cbp.gov/api/search';
const PAGE_SIZE = 50;
const PAGES_PER_TERM = 2;
const REQUEST_DELAY_MS = 250;
const FETCH_TIMEOUT_MS = 20000;
const TARGET_CASES = 500;

/** Diverse, everyday product terms spanning many HTS chapters. */
const PRODUCT_TERMS: string[] = [
  'water bottle',
  't-shirt',
  'LED lamp',
  'steel bolt',
  'phone case',
  'wooden chair',
  'coffee maker',
  'running shoes',
  'plastic toy',
  'ceramic mug',
  'bicycle',
  'handbag',
  'dog food',
  'solar panel',
  'kitchen knife',
  'wooden table',
  'jacket',
  'headphones',
  'tire',
  'battery',
  'glass jar',
  'notebook',
  'lipstick',
  'industrial valve',
  'water pump',
  'toy car',
  'blanket',
  'desk lamp',
];

interface CrossRuling {
  rulingNumber?: string;
  subject?: string;
  tariffs?: string[];
  rulingDate?: string;
  collection?: string;
  categories?: unknown;
}

interface CrossSearchResponse {
  rulings?: CrossRuling[];
  totalHits?: number;
}

/** An eval case ready to be inserted. */
interface EvalCase {
  rulingNumber: string;
  productText: string;
  correctCode: string;
  allCodes: string[];
  rulingDate: Date | null;
  collection: string | null;
}

const HTS_CODE_RE = /^\d{4}\.?\d/;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPage(term: string, page: number): Promise<CrossRuling[]> {
  const url =
    `${CROSS_SEARCH_URL}?term=${encodeURIComponent(term)}` +
    `&collection=ALL&pageSize=${PAGE_SIZE}&page=${page}&sortBy=RELEVANCE`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!resp.ok) {
      console.warn(`  ! "${term}" page ${page}: HTTP ${resp.status} — skipping`);
      return [];
    }
    const data = (await resp.json()) as CrossSearchResponse;
    return Array.isArray(data?.rulings) ? data.rulings : [];
  } catch (e) {
    console.warn(`  ! "${term}" page ${page}: ${(e as Error)?.message ?? e} — skipping`);
    return [];
  }
}

/** Returns true if a raw ruling is a usable labeled case. */
function isUsable(r: CrossRuling): boolean {
  if (!r.rulingNumber) return false;
  if (!Array.isArray(r.tariffs) || r.tariffs.length === 0) return false;
  const first = r.tariffs[0];
  if (typeof first !== 'string' || !HTS_CODE_RE.test(first.trim())) return false;
  if (!r.subject || !r.subject.trim()) return false;
  return true;
}

async function buildEvalSet(): Promise<void> {
  const byRulingNumber = new Map<string, EvalCase>();

  outer: for (const term of PRODUCT_TERMS) {
    console.log(`Searching CROSS for "${term}"…`);
    for (let page = 1; page <= PAGES_PER_TERM; page++) {
      const rulings = await fetchPage(term, page);
      for (const r of rulings) {
        if (!isUsable(r)) continue;
        const rulingNumber = r.rulingNumber!.trim();
        if (byRulingNumber.has(rulingNumber)) continue;
        const tariffs = (r.tariffs as string[]).map((t) => t.trim());
        byRulingNumber.set(rulingNumber, {
          rulingNumber,
          productText: r.subject!.trim(),
          correctCode: tariffs[0],
          allCodes: tariffs,
          rulingDate: r.rulingDate ? new Date(r.rulingDate) : null,
          collection: r.collection ?? null,
        });
      }
      await sleep(REQUEST_DELAY_MS);

      // Stop early once we have enough distinct cases.
      if (byRulingNumber.size >= TARGET_CASES) {
        console.log(`Reached target of ${TARGET_CASES} cases — stopping fetch early.`);
        break outer;
      }
    }
  }

  const cases = [...byRulingNumber.values()];
  console.log(`Collected ${cases.length} distinct usable rulings. Inserting…`);

  if (cases.length === 0) {
    console.log('No cases to insert.');
    return;
  }

  const sql = getHtsClient();
  let inserted = 0;
  for (const c of cases) {
    const rows = await sql`
      INSERT INTO hts_eval_cases
        (ruling_number, product_text, correct_code, all_codes, ruling_date, collection, source)
      VALUES
        (${c.rulingNumber}, ${c.productText}, ${c.correctCode}, ${sql.json(c.allCodes)}, ${
          c.rulingDate
        }, ${c.collection}, ${'CROSS'})
      ON CONFLICT (ruling_number) DO NOTHING
      RETURNING id`;
    if (rows.length > 0) inserted += 1;
  }

  console.log(
    `Done. ${cases.length} cases collected, ${inserted} newly inserted ` +
      `(${cases.length - inserted} already present).`,
  );
}

buildEvalSet()
  .then(async () => {
    await closeHtsDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('build-evalset failed:', error);
    await closeHtsDb().catch(() => {});
    process.exit(1);
  });
