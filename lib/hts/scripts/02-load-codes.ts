import 'dotenv/config';

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { closeHtsDb, getHtsClient, getHtsDb } from '@/lib/hts/db/client';
import { htsCodes, type NewHtsCodeRow } from '@/lib/hts/db/schema';

/**
 * 02-load-codes — load the per-chapter USITC HTS exports into `hts_codes`.
 *
 * Input: data/hts/json/chapter_NN.json (one JSON array per chapter, produced by
 * the earlier pipeline step from the USITC `exportList?format=JSON` endpoint).
 * Each element is a tariff line in file order:
 *   { htsno, indent, description, superior, units[], general, special, other,
 *     footnotes[], quotaQuantity, additionalDuties }
 *
 * The export is a flat list whose real meaning comes from `indent`: a row's
 * full description is its own text prefixed by every shallower-indent ancestor.
 * We walk the rows IN ORDER, maintaining an indent-stack, to reconstruct
 * `descriptionFull`. Pure grouping rows (htsno === '') are kept — they are
 * needed both as ancestors and so expand_code can walk the tree.
 */

const JSON_DIR = path.join(process.cwd(), 'data', 'hts', 'json');
const BATCH_SIZE = 500;

/** Shape of one element in a chapter JSON array (USITC export). */
interface RawHtsRow {
  htsno?: string;
  indent?: string | number;
  description?: string;
  superior?: string | boolean | null;
  units?: unknown;
  general?: string;
  special?: string;
  other?: string;
  footnotes?: unknown;
  quotaQuantity?: string;
  additionalDuties?: string;
}

/** Normalize a possibly-empty text field to `string | null`. */
function textOrNull(value: string | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : value;
}

/** Read and JSON-parse a chapter file, or return null if it does not exist. */
async function readChapterFile(chapter: string): Promise<RawHtsRow[] | null> {
  const file = path.join(JSON_DIR, `chapter_${chapter}.json`);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected a JSON array in ${file}, got ${typeof parsed}`);
  }
  return parsed as RawHtsRow[];
}

async function insertBatch(batch: NewHtsCodeRow[]): Promise<void> {
  if (batch.length === 0) return;
  await getHtsDb().insert(htsCodes).values(batch);
}

async function loadCodes(): Promise<void> {
  const sql = getHtsClient();

  // Idempotent: clear the table (and reset the serial id) before reloading.
  await sql`TRUNCATE hts_codes RESTART IDENTITY`;
  console.log('Truncated hts_codes.');

  let totalInserted = 0;
  let sortOrder = 0; // GLOBAL across all chapters — preserves file order for tree walks.
  let batch: NewHtsCodeRow[] = [];

  for (let n = 1; n <= 99; n++) {
    const chapter = String(n).padStart(2, '0');
    const rows = await readChapterFile(chapter);
    if (rows === null) continue; // skip missing chapters (e.g. 77 is reserved/empty)

    // Indent-stack of ancestor descriptions for this chapter.
    const ancestors: string[] = [];
    let chapterCount = 0;

    for (const row of rows) {
      const indent = Number(row.indent ?? 0);
      const safeIndent = Number.isFinite(indent) && indent >= 0 ? indent : 0;
      const description = row.description ?? '';

      // Maintain the indent-stack: this row owns slot `safeIndent`; anything
      // deeper than it is no longer an ancestor.
      ancestors[safeIndent] = description;
      ancestors.length = safeIndent + 1;
      const descriptionFull = ancestors
        .slice(0, safeIndent + 1)
        .filter(Boolean)
        .join(' > ');

      const htsno = row.htsno ?? '';
      const digits = htsno.replace(/\D/g, '');
      const heading = digits.length >= 4 ? digits.slice(0, 4) : null;
      const superior = row.superior === 'true' || row.superior === true;

      const units = Array.isArray(row.units) ? row.units : null;
      const footnotes = Array.isArray(row.footnotes) ? row.footnotes : null;

      batch.push({
        htsno,
        indent: safeIndent,
        description,
        descriptionFull,
        chapter, // 2-digit chapter from the FILENAME, not derived from htsno.
        heading,
        superior,
        units: units ?? undefined,
        general: textOrNull(row.general),
        special: textOrNull(row.special),
        other: textOrNull(row.other),
        footnotes: footnotes ?? undefined,
        quotaQuantity: textOrNull(row.quotaQuantity),
        additionalDuties: textOrNull(row.additionalDuties),
        rev: null,
        sortOrder: sortOrder++,
      });

      chapterCount++;

      if (batch.length >= BATCH_SIZE) {
        await insertBatch(batch);
        totalInserted += batch.length;
        batch = [];
      }
    }

    console.log(`Chapter ${chapter}: ${chapterCount} rows queued.`);
  }

  // Flush the tail.
  if (batch.length > 0) {
    await insertBatch(batch);
    totalInserted += batch.length;
    batch = [];
  }

  // Full-text search index over the reconstructed descriptions.
  await sql`CREATE INDEX IF NOT EXISTS hts_codes_fts_idx ON hts_codes USING GIN (to_tsvector('english', description_full))`;
  console.log('Created FTS index hts_codes_fts_idx.');

  console.log(`Done. Inserted ${totalInserted} rows into hts_codes.`);
}

loadCodes()
  .then(async () => {
    await closeHtsDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('02-load-codes failed:', error);
    try {
      await closeHtsDb();
    } catch {
      // ignore close errors on the failure path
    }
    process.exit(1);
  });
