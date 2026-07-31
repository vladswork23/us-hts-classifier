import { getHtsClient } from './db/client';
import { chapterOf, sectionForChapter } from './sections';
import { RESULT_SCHEMA } from './prompt';
import type { ResponsesFunctionTool } from './types';
import { embeddingsEnabled, embedOne, toVectorLiteral } from './embeddings';

/**
 * Agent tools for the HTS classifier, in the OpenAI Responses "flat" function
 * shape. The five data tools read the local HTS Postgres (and live CBP CROSS);
 * `submit_classification` is the terminal tool the agent calls to return its
 * structured answer (handled by the loop in classify.ts, not executed here).
 */

function clampLimit(v: unknown, def: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return def;
  return Math.min(Math.floor(n), max);
}

// Cached check: does hts_codes have a populated `embedding` column? (Added by
// the optional 05-embed step.) Null = unknown; resolved once per process.
let _hasEmbeddings: boolean | null = null;
async function hasEmbeddings(sql: ReturnType<typeof getHtsClient>): Promise<boolean> {
  if (_hasEmbeddings !== null) return _hasEmbeddings;
  try {
    const r = await sql`SELECT 1 FROM hts_codes WHERE embedding IS NOT NULL LIMIT 1`;
    _hasEmbeddings = r.length > 0;
  } catch {
    _hasEmbeddings = false; // column doesn't exist yet
  }
  return _hasEmbeddings;
}

/**
 * Reciprocal Rank Fusion: blend two ranked candidate lists by htsno. An item's
 * score is sum of 1/(k + rank) across the lists it appears in, so items ranked
 * highly by EITHER retriever (or both) float to the top. With one non-empty list
 * this preserves that list's order, so it's safe when vector search is absent.
 */
function rrfMerge(a: any[], b: any[], limit: number, k = 60): any[] {
  const acc = new Map<string, { row: any; s: number }>();
  const add = (list: any[]) =>
    list.forEach((r, i) => {
      const key = r.htsno;
      const e = acc.get(key) || { row: r, s: 0 };
      e.s += 1 / (k + i + 1);
      acc.set(key, e);
    });
  add(a);
  add(b);
  return [...acc.values()].sort((x, y) => y.s - x.s).slice(0, limit).map((e) => e.row);
}

// ---------------------------------------------------------------- search_headings
async function searchHeadings(args: { query?: string; limit?: number }): Promise<string> {
  const query = (args.query || '').trim();
  if (!query) return 'Provide a `query` describing the product.';
  const limit = clampLimit(args.limit, 20, 40);
  const sql = getHtsClient();

  // Typed as any[] so the OR/regex fallbacks below can reassign (incl. []).
  let rows: any[] = await sql`
    SELECT htsno, chapter, description_full,
           ts_rank(to_tsvector('english', description_full), plainto_tsquery('english', ${query})) AS rank
    FROM hts_codes
    WHERE htsno <> ''
      AND to_tsvector('english', description_full) @@ plainto_tsquery('english', ${query})
    ORDER BY rank DESC, char_length(htsno) ASC
    LIMIT ${limit}`;

  // plainto_tsquery ANDs every term, so long descriptive queries often match
  // nothing. Fall back progressively to OR-semantics so any salient term hits.
  if (rows.length === 0) {
    const words = query
      .split(/\s+/)
      .map((w) => w.replace(/[^a-z0-9]/gi, ''))
      .filter((w) => w.length >= 3)
      .slice(0, 8);

    if (words.length) {
      // Tier 2: full-text OR — rows matching ANY term, ranked by relevance.
      const orQuery = words.join(' | ');
      try {
        rows = await sql`
          SELECT htsno, chapter, description_full,
                 ts_rank(to_tsvector('english', description_full), to_tsquery('english', ${orQuery})) AS rank
          FROM hts_codes
          WHERE htsno <> ''
            AND to_tsvector('english', description_full) @@ to_tsquery('english', ${orQuery})
          ORDER BY rank DESC, char_length(htsno) ASC
          LIMIT ${limit}`;
      } catch {
        rows = [];
      }

      // Tier 3: case-insensitive regex on any single word (last resort).
      if (rows.length === 0) {
        const rx = words.join('|');
        try {
          rows = await sql`
            SELECT htsno, chapter, description_full, 0 AS rank
            FROM hts_codes
            WHERE htsno <> '' AND description_full ~* ${rx}
            ORDER BY char_length(htsno) ASC
            LIMIT ${limit}`;
        } catch {
          rows = [];
        }
      }
    }
  }

  // Hybrid retrieval: blend the FTS candidates above with semantic (vector)
  // candidates via RRF. Vector search can surface the right heading when the
  // product is described in words that don't keyword-match the tariff text
  // (e.g. "yoga pants" vs "trousers ... of synthetic fibers"). It also rescues
  // the case where FTS found nothing. Silently degrades to FTS-only if the
  // embedding column/key is absent.
  if (embeddingsEnabled() && (await hasEmbeddings(sql))) {
    let vecRows: any[] = [];
    try {
      const qvec = toVectorLiteral(await embedOne(query));
      vecRows = await sql`
        SELECT htsno, chapter, description_full,
               (1 - (embedding <=> ${qvec}::vector)) AS rank
        FROM hts_codes
        WHERE htsno <> '' AND embedding IS NOT NULL
        ORDER BY embedding <=> ${qvec}::vector
        LIMIT ${limit}`;
    } catch {
      vecRows = [];
    }
    if (vecRows.length) rows = rrfMerge(rows, vecRows, limit);
  }

  if (rows.length === 0) {
    return `No HTS lines matched "${query}". Try broader or different keywords (material, function, common name).`;
  }
  const lines = rows.map(
    (r: any) => `${r.htsno}  [ch ${r.chapter}]  ${truncate(r.description_full, 160)}`,
  );
  return `Candidate HTS lines for "${query}" (drill in with expand_code, read get_notes before committing):\n` + lines.join('\n');
}

// ------------------------------------------------------------------- expand_code
async function expandCode(args: { code?: string }): Promise<string> {
  const code = (args.code || '').trim();
  if (!code) return 'Provide a `code` (e.g. "6109", "6109.10", or "6109.10.00").';
  const sql = getHtsClient();

  const nodeRows = await sql`
    SELECT indent, sort_order FROM hts_codes WHERE htsno = ${code} ORDER BY sort_order LIMIT 1`;
  if (nodeRows.length === 0) {
    return `Code "${code}" was not found as a heading/subheading. Use search_headings to find valid codes, or pass a 4/6/8-digit code.`;
  }
  const node = nodeRows[0] as { indent: number; sort_order: number };

  const boundaryRows = await sql`
    SELECT COALESCE(MIN(sort_order), 2147483647) AS boundary
    FROM hts_codes
    WHERE sort_order > ${node.sort_order} AND indent <= ${node.indent}`;
  const boundary = Number((boundaryRows[0] as any).boundary);

  // Show the next two indent levels so coded children under bare grouping rows
  // ("Horses:", "Other:") are still visible.
  const rows = await sql`
    SELECT htsno, indent, description, general
    FROM hts_codes
    WHERE sort_order > ${node.sort_order} AND sort_order < ${boundary}
      AND indent <= ${node.indent + 2}
    ORDER BY sort_order
    LIMIT 80`;

  if (rows.length === 0) {
    return `"${code}" has no sub-lines here — it is likely a 10-digit statistical leaf. This is a terminal code.`;
  }
  const lines = rows.map((r: any) => {
    const pad = '  '.repeat(Math.max(0, r.indent - node.indent - 1));
    const label = r.htsno ? r.htsno : '(group)';
    const rate = r.general ? `  {general: ${r.general}}` : '';
    return `${pad}${label}  ${truncate(r.description, 120)}${rate}`;
  });
  return `Children of ${code} (compare same-level options per GRI 6):\n` + lines.join('\n');
}

// --------------------------------------------------------------------- get_notes
async function getNotes(args: { chapter?: string }): Promise<string> {
  const ch = chapterOf(args.chapter || '');
  if (!ch) return 'Provide a `chapter` or code (e.g. "61" or "6109.10").';
  const sql = getHtsClient();
  const sec = sectionForChapter(ch);

  const chapterRows = await sql`
    SELECT title, note_text FROM hts_notes WHERE scope = 'chapter' AND chapter = ${ch} LIMIT 1`;
  const sectionRows = sec
    ? await sql`SELECT title, note_text FROM hts_notes WHERE scope = 'section' AND ref = ${sec.roman} LIMIT 1`
    : [];

  if (chapterRows.length === 0 && sectionRows.length === 0) {
    return `No Section/Chapter Notes are loaded for chapter ${ch}${
      sec ? ` (Section ${sec.roman})` : ''
    }. Run \`npm run hts:notes\` to ingest them. Classifying without notes is less reliable — flag needs_human_review if a note could be decisive.`;
  }

  const parts: string[] = [];
  if (sec && sectionRows.length) {
    parts.push(
      `=== Section ${sec.roman} Notes — ${sectionRows[0].title || sec.title} ===\n${sectionRows[0].note_text}`,
    );
  }
  if (chapterRows.length) {
    parts.push(
      `=== Chapter ${ch} Notes — ${chapterRows[0].title || ''} ===\n${chapterRows[0].note_text}`,
    );
  }
  return parts.join('\n\n');
}

// ------------------------------------------------------------------ get_overlays
async function getOverlays(args: { code?: string }): Promise<string> {
  const code = (args.code || '').trim();
  const ch = chapterOf(code);
  if (!ch) return 'Provide the chosen `code` to check for Chapter 99 / 301 / 232 overlays.';
  const digits = code.replace(/\D/g, '');
  const heading = digits.slice(0, 4);
  const sql = getHtsClient();

  const selfRows = await sql`
    SELECT footnotes, additional_duties FROM hts_codes WHERE htsno = ${code} LIMIT 1`;
  const ch99 = await sql`
    SELECT htsno, description_full
    FROM hts_codes
    WHERE chapter = '99'
      AND (description_full ILIKE ${'%' + heading + '%'} OR description_full ILIKE ${'%chapter ' + ch + '%'})
    ORDER BY char_length(htsno) ASC
    LIMIT 12`;

  const parts: string[] = [];
  const self = selfRows[0] as any;
  if (self?.additional_duties) parts.push(`Additional duties on ${code}: ${self.additional_duties}`);
  if (self?.footnotes) {
    const fn = typeof self.footnotes === 'string' ? self.footnotes : JSON.stringify(self.footnotes);
    if (fn && fn !== '[]' && fn !== 'null') parts.push(`Footnotes on ${code}: ${truncate(fn, 400)}`);
  }
  if (ch99.length) {
    parts.push(
      `Possible Chapter 99 overlays (VERIFY applicability — these are hints, not confirmed):\n` +
        ch99.map((r: any) => `${r.htsno}  ${truncate(r.description_full, 140)}`).join('\n'),
    );
  }
  if (parts.length === 0) {
    return `No obvious Chapter 99 / 301 / 232 overlay found for ${code}. Note: overlay tariffs change frequently — verify against the current HTS and USTR actions.`;
  }
  return parts.join('\n\n');
}

// ----------------------------------------------------------------- search_rulings
async function searchRulings(args: { query?: string; limit?: number }): Promise<string> {
  const query = (args.query || '').trim();
  if (!query) return 'Provide a `query` describing the product to find CBP CROSS precedent.';
  const limit = clampLimit(args.limit, 8, 15);
  const sql = getHtsClient();
  const queryKey = `${query.toLowerCase().replace(/\s+/g, ' ').trim()}|${limit}`;

  // 1. Serve from the search cache (30-day TTL) — repeated queries cost nothing.
  try {
    const cached: any[] = await sql`
      SELECT output FROM hts_ruling_searches
      WHERE query_key = ${queryKey} AND fetched_at > now() - interval '30 days'
      LIMIT 1`;
    if (cached.length) return cached[0].output;
  } catch {
    /* cache table may not exist yet — fall through to live fetch */
  }

  // 2. Live fetch. Transient failures are returned but NOT cached.
  let data: any;
  try {
    const url = `https://rulings.cbp.gov/api/search?term=${encodeURIComponent(
      query,
    )}&collection=ALL&pageSize=${limit}&page=1&sortBy=RELEVANCE`;
    const resp = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    if (!resp.ok) return `CROSS lookup failed (HTTP ${resp.status}). Proceed using the schedule and notes.`;
    data = await resp.json();
  } catch (e: any) {
    return `CROSS lookup error: ${e?.message || e}. Proceed using the schedule and notes.`;
  }

  const rulings: any[] = Array.isArray(data?.rulings) ? data.rulings : [];

  let output: string;
  if (rulings.length === 0) {
    output = `No CBP CROSS rulings found for "${query}".`;
  } else {
    // Pull full text for the top rulings (in parallel) so the model sees the
    // actual classification language, not just the subject line. The decisive
    // sentences in a ruling are the "The applicable subheading ... will be
    // <code> ... rate of duty ..." paragraphs — extract those; fall back to a
    // lead excerpt for the top ruling.
    const detailCount = Math.min(3, rulings.length);
    const snippets = await Promise.all(
      rulings.slice(0, detailCount).map(async (r: any, i: number) => {
        try {
          const resp = await fetch(
            `https://rulings.cbp.gov/api/ruling/${encodeURIComponent(r.rulingNumber)}`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) },
          );
          if (!resp.ok) return '';
          const rd = await resp.json();
          const text = (rd?.text || '').replace(/\r/g, '\n').replace(/\n{2,}/g, '\n').trim();
          if (!text) return '';
          cacheRuling(r, text).catch(() => {});
          const holdings = extractHoldings(text);
          if (holdings) return `\n\nRuling ${r.rulingNumber} holding(s):\n${holdings}`;
          // No "applicable subheading" sentence found — give a lead excerpt
          // for the top ruling only.
          return i === 0 ? `\n\nTop ruling ${r.rulingNumber} excerpt:\n${truncate(text, 1200)}` : '';
        } catch {
          return '';
        }
      }),
    );

    const lines = rulings.map((r: any) => {
      const year = r.rulingDate ? String(r.rulingDate).slice(0, 4) : '????';
      const tariffs =
        Array.isArray(r.tariffs) && r.tariffs.length ? r.tariffs.join(', ') : '(no code listed)';
      return `${r.rulingNumber} [${year}, ${r.collection}] -> ${tariffs} : ${truncate(r.subject || '', 140)}`;
    });

    output =
      `CBP CROSS precedent for "${query}" (${data.totalHits ?? rulings.length} hits; codes are what CBP actually assigned — verify the analogy. ` +
      `NOTE: older rulings may cite statistical suffixes that no longer exist — confirm the final 10-digit line against the current schedule with expand_code):\n` +
      lines.join('\n') +
      snippets.join('');
  }

  // 3. Cache successful results (incl. a valid "no rulings" answer); best-effort.
  try {
    await sql`
      INSERT INTO hts_ruling_searches (query_key, output)
      VALUES (${queryKey}, ${output})
      ON CONFLICT (query_key) DO UPDATE SET output = EXCLUDED.output, fetched_at = now()`;
  } catch {
    /* best-effort */
  }

  return output;
}

/**
 * Pull the decisive "The applicable subheading for X will be <code> ... rate of
 * duty will be ..." passages out of a ruling's full text. Windowed rather than
 * sentence-split because HTS codes contain periods. Returns '' if none found.
 */
function extractHoldings(text: string): string {
  const windows: string[] = [];
  const re = /applicable subheading/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && windows.length < 3) {
    // Start at the line break before the match, but never more than ~100 chars
    // back — otherwise a newline-free ruling text would anchor the window at 0
    // and the truncation below would cut it off before the holding itself.
    const start = Math.max(text.lastIndexOf('\n', m.index) + 1, m.index - 100);
    windows.push(truncate(text.slice(start, m.index + 450).replace(/\s+/g, ' ').trim(), 560));
    re.lastIndex = m.index + 450;
  }
  return windows.map((w) => `- ${w}`).join('\n');
}

async function cacheRuling(r: any, fullText: string): Promise<void> {
  const sql = getHtsClient();
  const rulingDate = r.rulingDate ? new Date(r.rulingDate) : null;
  await sql`
    INSERT INTO hts_rulings_cache (ruling_number, subject, tariffs, ruling_date, collection, full_text)
    VALUES (${r.rulingNumber}, ${r.subject ?? null}, ${sql.json(r.tariffs ?? [])}, ${rulingDate}, ${
    r.collection ?? null
  }, ${fullText || null})
    ON CONFLICT (ruling_number) DO UPDATE
      SET subject = EXCLUDED.subject, tariffs = EXCLUDED.tariffs,
          full_text = EXCLUDED.full_text, fetched_at = now()`;
}

function truncate(s: string, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ------------------------------------------------------------------ ground a code
/**
 * Validate a final HTS code against the loaded schedule and return its
 * authoritative description + duty rates. Matches on digits only (the model may
 * emit the code dotted or undotted). When the exact code is not present (a
 * common failure mode is a hallucinated 9-10 digit statistical suffix), returns
 * `valid: false` plus the nearest real codes that share the 8-digit prefix, so
 * the caller can flag the answer for review and suggest corrections.
 */
export async function groundFinalCode(hsCode: string): Promise<{
  valid: boolean;
  htsno?: string;
  description?: string;
  general?: string | null;
  special?: string | null;
  other?: string | null;
  nearest: string[];
  /** The single 10-digit statistical line implied by the code, when it is
   * unambiguous (the code is valid-but-short, or its suffix is wrong but the
   * 8-digit line has exactly one 10-digit child). Safe to auto-apply. */
  completion?: string;
}> {
  const digits = (hsCode || '').replace(/\D/g, '');
  if (digits.length < 6) return { valid: false, nearest: [] };
  const sql = getHtsClient();

  // The 10-digit statistical lines under a digit prefix (used to auto-complete
  // a short or stale-suffix code when only one current line exists).
  const tenDigitUnder = async (prefix: string): Promise<string[]> => {
    const rows: any[] = await sql`
      SELECT htsno FROM hts_codes
      WHERE htsno <> ''
        AND regexp_replace(htsno, '[^0-9]', '', 'g') LIKE ${prefix + '%'}
        AND length(regexp_replace(htsno, '[^0-9]', '', 'g')) = 10
      ORDER BY htsno
      LIMIT 12`;
    return rows.map((r) => r.htsno);
  };

  const exact: any[] = await sql`
    SELECT htsno, description_full, general, special, other
    FROM hts_codes
    WHERE htsno <> '' AND regexp_replace(htsno, '[^0-9]', '', 'g') = ${digits}
    LIMIT 1`;
  if (exact.length) {
    let completion: string | undefined;
    if (digits.length < 10) {
      const tens = await tenDigitUnder(digits);
      if (tens.length === 1) completion = tens[0];
    }
    return {
      valid: true,
      htsno: exact[0].htsno,
      description: exact[0].description_full,
      general: exact[0].general,
      special: exact[0].special,
      other: exact[0].other,
      nearest: [],
      completion,
    };
  }

  // Not found — surface the real codes under the same 8-digit (then 6-digit)
  // line. If the 8-digit line has exactly one current 10-digit child, the
  // intended statistical line is unambiguous: offer it as a completion.
  for (const plen of [8, 6]) {
    if (digits.length < plen) continue;
    const prefix = digits.slice(0, plen);
    const near: any[] = await sql`
      SELECT htsno FROM hts_codes
      WHERE htsno <> '' AND regexp_replace(htsno, '[^0-9]', '', 'g') LIKE ${prefix + '%'}
      ORDER BY htsno
      LIMIT 10`;
    if (near.length) {
      let completion: string | undefined;
      if (plen === 8) {
        const tens = await tenDigitUnder(prefix);
        if (tens.length === 1) completion = tens[0];
      }
      return { valid: false, nearest: near.map((r) => r.htsno), completion };
    }
  }
  return { valid: false, nearest: [] };
}

// --------------------------------------------------------------------- dispatch
/** Execute a data tool by name. Throws for unknown names and for submit_classification. */
export async function runDataTool(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case 'search_headings':
      return searchHeadings(args as any);
    case 'expand_code':
      return expandCode(args as any);
    case 'get_notes':
      return getNotes(args as any);
    case 'get_overlays':
      return getOverlays(args as any);
    case 'search_rulings':
      return searchRulings(args as any);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ----------------------------------------------------------------- tool schemas
export const htsToolDefs: ResponsesFunctionTool[] = [
  {
    type: 'function',
    name: 'search_headings',
    description:
      'Full-text search the US HTS for candidate headings/subheadings matching a product description. Start here; returns codes with their full descriptions.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Product description or key terms (material, function, common name).' },
        limit: { type: 'integer', description: 'Max rows (default 20, max 40).' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'get_notes',
    description:
      'Return the legally-binding Section and Chapter Notes for a chapter. ALWAYS call this before committing to a heading — notes include/exclude goods and decide most borderline cases (GRI 1).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        chapter: { type: 'string', description: 'A chapter ("61") or any code ("6109.10"); the chapter is derived.' },
      },
      required: ['chapter'],
    },
  },
  {
    type: 'function',
    name: 'expand_code',
    description:
      'List the children of a heading/subheading so you can drill 4 -> 6 -> 8 -> 10 digits, comparing only same-level options (GRI 6).',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'A heading/subheading code, e.g. "6109", "6109.10", or "6109.10.00".' },
      },
      required: ['code'],
    },
  },
  {
    type: 'function',
    name: 'search_rulings',
    description:
      'Search CBP CROSS for how Customs actually classified similar products. Each result carries the HTS code CBP assigned. Persuasive precedent — verify the analogy; not binding.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Product description or key terms.' },
        limit: { type: 'integer', description: 'Max rulings (default 8, max 15).' },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'get_overlays',
    description:
      'Check Chapter 99 / Section 301 / Section 232 additional duties that may apply ON TOP of the base code for a chosen HTS code.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        code: { type: 'string', description: 'The chosen HTS code to check for overlay duties.' },
      },
      required: ['code'],
    },
  },
  {
    type: 'function',
    name: 'submit_classification',
    description:
      'Submit the FINAL structured HTS classification. Call this exactly once, after gathering evidence with the other tools and reading the relevant notes.',
    parameters: RESULT_SCHEMA as unknown as Record<string, unknown>,
    strict: true,
  },
];
