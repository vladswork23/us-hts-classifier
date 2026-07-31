import 'dotenv/config';

import { extractText, getDocumentProxy } from 'unpdf';

import { closeHtsDb, getHtsClient, getHtsDb } from '@/lib/hts/db/client';
import { htsNotes } from '@/lib/hts/db/schema';
import { HTS_SECTIONS } from '@/lib/hts/sections';

/**
 * 03-pull-notes.ts — download the per-chapter USITC HTS PDFs and extract the
 * legal Section / Chapter Notes (the front matter that precedes each chapter's
 * rate table) into the `hts_notes` table.
 *
 * Run:  npx tsx lib/hts/scripts/03-pull-notes.ts
 *
 * NOTE ON HEURISTICS: the USITC PDFs are not structured data — the boundaries
 * of the Notes block are found by regex/text heuristics below. These regexes
 * (`NOTE_START_RE`, `TABLE_START_RE`, the section/chapter title detection, and
 * the 10k-char cap) are best-effort and WILL need tuning after the user reviews
 * the per-chapter captured-char-count log this script prints. Treat any chapter
 * that logs a suspiciously small (or maxed-out) char count as a likely miss.
 */

// USITC reststop file endpoint. The chapter number is NOT zero-padded and the
// space before it is encoded as '+'. HEAD lies about content-length, so we GET.
const FILE_ENDPOINT = 'https://hts.usitc.gov/reststop/file';
const REQUEST_DELAY_MS = 300;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_NOTE_CHARS = 10_000;

// Chapter 77 is reserved in the nomenclature — its PDF is essentially empty.
const RESERVED_CHAPTERS = new Set<number>([77]);

// First sign of a "Note(s)" heading.
const NOTE_START_RE = /\bNotes?\b/;
// Strong, reliable markers that the tariff RATE TABLE has begun: its column
// headers. These phrases appear once, right after the notes front matter, and
// (unlike a bare 4-digit number, which occurs inside notes as cross-references)
// effectively never appear in note prose. "Additional U.S. Notes" sit BEFORE
// these headers, so cutting here keeps them and drops the table.
const TABLE_BOUNDARY_RE =
  /(Units?\s+of\s+Quantity|Stat(?:istical)?\s*\.?\s*Suffix|Heading\s*\/\s*Subheading)/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface ExtractedNotes {
  chapterTitle: string;
  chapterNotes: string;
  sectionTitle: string | null;
  sectionNotes: string | null;
}

/** Fetch one chapter's PDF and return its merged text, or null on failure / empty. */
async function fetchChapterText(chapter: number): Promise<string | null> {
  // Encode 'Chapter N' with the space as '+'. encodeURIComponent gives %20, so
  // build the query manually to satisfy the endpoint's '+'-for-space contract.
  const filename = `Chapter+${chapter}`;
  const url = `${FILE_ENDPOINT}?release=currentRelease&filename=${filename}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { Accept: 'application/octet-stream,application/pdf,*/*' },
    });
  } catch (err) {
    console.warn(`  ch${chapter}: fetch failed — ${(err as Error).message}`);
    return null;
  }

  if (!resp.ok) {
    console.warn(`  ch${chapter}: HTTP ${resp.status} ${resp.statusText}`);
    return null;
  }

  const ab = await resp.arrayBuffer();
  // Reserved chapters (e.g. 77) come back as a near-empty / 1-byte PDF.
  if (ab.byteLength < 1024) {
    console.log(`  ch${chapter}: PDF only ${ab.byteLength} bytes — treating as empty.`);
    return null;
  }

  try {
    const pdf = await getDocumentProxy(new Uint8Array(ab));
    const { text } = await extractText(pdf, { mergePages: true });
    return text;
  } catch (err) {
    console.warn(`  ch${chapter}: PDF parse failed — ${(err as Error).message}`);
    return null;
  }
}

/**
 * Heuristic extraction of the Section and Chapter Notes from a chapter PDF's
 * merged text. The front matter ordering in a "first chapter of a section" PDF
 * is: [Section <roman> ... Notes] then [Chapter NN ... Notes] then the table.
 */
function extractNotes(
  rawText: string,
  chapter: number,
  isSectionLead: boolean,
  sectionRoman: string | null,
  sectionTitle: string | null,
): ExtractedNotes {
  const text = rawText.replace(/\r\n?/g, '\n');

  // --- Locate the "Chapter NN" heading ---
  const chapterRe = new RegExp(`Chapter\\s+${chapter}\\b`, 'i');
  const chapMatch = text.match(chapterRe);
  const chapIdx = chapMatch?.index ?? -1;

  // Chapter title: the descriptive text right after "Chapter N" (same line, else
  // the next non-empty, non-"Notes" line).
  let chapterTitle = `Chapter ${chapter}`;
  if (chapIdx >= 0) {
    const after = text
      .slice(chapIdx)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    const sameLine = after[0]?.replace(chapterRe, '').trim();
    if (sameLine) chapterTitle = sameLine;
    else if (after[1] && !/^Notes?$/i.test(after[1])) chapterTitle = after[1];
  }

  // --- Chapter notes: from the first "Note" after the chapter heading, up to
  // the rate-table column headers (TABLE_BOUNDARY_RE). ---
  const fromChapter = chapIdx >= 0 ? text.slice(chapIdx) : text;
  const noteRel = fromChapter.search(NOTE_START_RE);
  const notesRegion = noteRel >= 0 ? fromChapter.slice(noteRel) : fromChapter;
  const boundaryRel = notesRegion.search(TABLE_BOUNDARY_RE);
  let chapterNotes = (boundaryRel >= 0 ? notesRegion.slice(0, boundaryRel) : notesRegion).trim();
  chapterNotes = chapterNotes.slice(0, MAX_NOTE_CHARS);

  // --- Section notes (only for the first chapter of a section): the block from
  // "Section <roman>" up to the "Chapter N" heading, from its first Note. ---
  let sectionNotes: string | null = null;
  if (isSectionLead && sectionRoman) {
    const sectionRe = new RegExp(`Section\\s+${sectionRoman}\\b`, 'i');
    const sMatch = text.match(sectionRe);
    if (sMatch?.index != null) {
      const sStart = sMatch.index;
      const sEnd = chapIdx > sStart ? chapIdx : text.length;
      const sectionBlock = text.slice(sStart, sEnd);
      const sNoteRel = sectionBlock.search(NOTE_START_RE);
      let sNotes = (sNoteRel >= 0 ? sectionBlock.slice(sNoteRel) : sectionBlock).trim();
      const sBoundary = sNotes.search(TABLE_BOUNDARY_RE);
      if (sBoundary >= 0) sNotes = sNotes.slice(0, sBoundary).trim();
      sectionNotes = sNotes.slice(0, MAX_NOTE_CHARS);
    }
  }

  return {
    chapterTitle,
    chapterNotes,
    sectionTitle: isSectionLead ? sectionTitle : null,
    sectionNotes,
  };
}

async function main() {
  const sql = getHtsClient();
  const db = getHtsDb();

  console.log('Truncating hts_notes…');
  await sql`TRUNCATE TABLE hts_notes RESTART IDENTITY`;

  // Map: chapter number -> the section whose `from` equals it (section lead).
  const sectionLeadByChapter = new Map<number, (typeof HTS_SECTIONS)[number]>();
  for (const s of HTS_SECTIONS) sectionLeadByChapter.set(s.from, s);

  let inserted = 0;
  let skipped = 0;

  for (let chapter = 1; chapter <= 99; chapter++) {
    const ref = String(chapter).padStart(2, '0');

    if (RESERVED_CHAPTERS.has(chapter)) {
      console.log(`ch${chapter} (reserved): skipped.`);
      skipped++;
      continue;
    }

    const text = await fetchChapterText(chapter);
    // Be polite to the public USITC endpoint.
    await sleep(REQUEST_DELAY_MS);

    if (!text) {
      console.log(`ch${chapter}: no text extracted — skipped.`);
      skipped++;
      continue;
    }

    const sectionLead = sectionLeadByChapter.get(chapter) ?? null;
    const extracted = extractNotes(
      text,
      chapter,
      Boolean(sectionLead),
      sectionLead?.roman ?? null,
      sectionLead?.title ?? null,
    );

    // Insert the section note row first (so section notes precede chapter notes
    // in id order), then the chapter note row.
    if (sectionLead && extracted.sectionNotes) {
      await db.insert(htsNotes).values({
        scope: 'section',
        ref: sectionLead.roman,
        chapter: null,
        title: extracted.sectionTitle,
        noteText: extracted.sectionNotes,
        source: `Chapter ${chapter}`,
      });
      inserted++;
      console.log(
        `ch${chapter}: section ${sectionLead.roman} notes — ${extracted.sectionNotes.length} chars.`,
      );
    }

    await db.insert(htsNotes).values({
      scope: 'chapter',
      ref,
      chapter: ref,
      title: extracted.chapterTitle,
      noteText: extracted.chapterNotes,
      source: `Chapter ${chapter}`,
    });
    inserted++;
    console.log(
      `ch${chapter}: chapter notes — ${extracted.chapterNotes.length} chars — "${extracted.chapterTitle}".`,
    );
  }

  console.log(`\nDone. Inserted ${inserted} note row(s); skipped ${skipped} chapter(s).`);
}

main()
  .then(async () => {
    await closeHtsDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('03-pull-notes failed:', error);
    await closeHtsDb().catch(() => {});
    process.exit(1);
  });
