import 'dotenv/config';

import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * 01-pull-hts.ts — Pull all 99 HTS chapters from USITC and write the raw JSON
 * to disk. NO database involved: this is a pure fetch-to-disk step that later
 * scripts ingest. We deliberately do NOT import the HTS db client here.
 *
 * Per-chapter endpoint (NN = zero-padded chapter 01..99):
 *   https://hts.usitc.gov/reststop/exportList?from=NN00&to=NN99&format=JSON&styles=false
 *
 * Each response is a JSON array of rows shaped like:
 *   { htsno, indent, description, superior, units, general, special, other,
 *     footnotes, quotaQuantity, additionalDuties }
 *
 * Chapter 77 is reserved in the nomenclature and returns an (essentially) empty
 * array — that is expected; we still write the file and log 0 rows.
 *
 * Run with:  npx tsx lib/hts/scripts/01-pull-hts.ts
 */

/** A single exported HTS row. Loose typing — we persist the raw payload as-is. */
interface HtsExportRow {
  htsno: string;
  indent: string | number;
  description: string;
  superior: string | null;
  units: string[] | null;
  general: string;
  special: string;
  other: string;
  footnotes: unknown[] | null;
  quotaQuantity: string | null;
  additionalDuties: string | null;
  [key: string]: unknown;
}

const OUT_DIR = path.join('data', 'hts', 'json');
const REQUEST_TIMEOUT_MS = 60_000;
const DELAY_BETWEEN_CHAPTERS_MS = 300;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Zero-pad a chapter number to 2 digits, e.g. 1 -> "01", 77 -> "77". */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function chapterUrl(chapter: string): string {
  return (
    'https://hts.usitc.gov/reststop/exportList' +
    `?from=${chapter}00&to=${chapter}99&format=JSON&styles=false`
  );
}

async function fetchChapter(chapter: string): Promise<HtsExportRow[]> {
  const res = await fetch(chapterUrl(chapter), {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} for chapter ${chapter}`);
  }
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) {
    throw new Error(
      `Unexpected response for chapter ${chapter}: expected a JSON array, got ${typeof data}`,
    );
  }
  return data as HtsExportRow[];
}

async function main(): Promise<void> {
  await fs.mkdir(OUT_DIR, { recursive: true });

  let total = 0;

  for (let n = 1; n <= 99; n++) {
    const chapter = pad2(n);
    const rows = await fetchChapter(chapter);
    const outPath = path.join(OUT_DIR, `chapter_${chapter}.json`);

    // Write the raw JSON payload exactly as received (re-serialized).
    await fs.writeFile(outPath, JSON.stringify(rows, null, 2), 'utf8');

    total += rows.length;
    if (chapter === '77') {
      console.log(`Chapter ${chapter}: ${rows.length} rows (reserved chapter — empty expected)`);
    } else {
      console.log(`Chapter ${chapter}: ${rows.length} rows -> ${outPath}`);
    }

    if (n < 99) {
      await sleep(DELAY_BETWEEN_CHAPTERS_MS);
    }
  }

  console.log(`Done. Wrote ${total} total HTS rows across 99 chapters to ${OUT_DIR}.`);
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('HTS pull failed:', error);
    process.exit(1);
  });
