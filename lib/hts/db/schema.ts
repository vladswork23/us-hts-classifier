import {
  pgTable,
  serial,
  text,
  integer,
  boolean,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Schema for the LOCAL HTS Postgres database (HTS_DATABASE_URL).
 *
 * This schema is migrated independently of the app's Supabase schema. Use:
 *   npm run db:generate
 *   npm run db:migrate
 *
 * Full-text search (a GIN index over description_full) and the optional pgvector
 * `embedding` column are created with raw SQL by the data-pipeline scripts, NOT
 * here — that keeps the base schema free of the `vector` extension so the agent
 * works with zero embedding setup, and adds vector search only when enabled.
 */

export const htsCodes = pgTable(
  'hts_codes',
  {
    id: serial('id').primaryKey(),
    // The HTS number, e.g. "0101.21.00.10". Empty string for pure grouping rows
    // (a header that only introduces indented children).
    htsno: text('htsno').notNull().default(''),
    indent: integer('indent').notNull().default(0),
    // The row's own description text.
    description: text('description').notNull().default(''),
    // Reconstructed description: every shallower-indent ancestor's text joined
    // with this row's text. This is the human-meaningful phrase and the FTS target.
    descriptionFull: text('description_full').notNull().default(''),
    chapter: text('chapter').notNull(), // '01'..'99'
    heading: text('heading'), // 4-digit heading when derivable, else null
    superior: boolean('superior').notNull().default(false),
    units: jsonb('units'),
    general: text('general'), // Column 1 general (MFN) duty rate
    special: text('special'), // FTA / preferential rates
    other: text('other'), // Column 2 rate
    footnotes: jsonb('footnotes'),
    quotaQuantity: text('quota_quantity'),
    additionalDuties: text('additional_duties'),
    rev: text('rev'), // HTS revision tag this row was ingested from
    sortOrder: integer('sort_order').notNull().default(0), // preserves file order for tree walks
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    htsnoIdx: index('hts_codes_htsno_idx').on(t.htsno),
    chapterIdx: index('hts_codes_chapter_idx').on(t.chapter),
    headingIdx: index('hts_codes_heading_idx').on(t.heading),
  }),
);

export const htsNotes = pgTable(
  'hts_notes',
  {
    id: serial('id').primaryKey(),
    scope: text('scope').notNull(), // 'section' | 'chapter'
    ref: text('ref').notNull(), // section roman numeral (e.g. 'I') or chapter '01'
    chapter: text('chapter'), // chapter number for chapter notes; null for section notes
    title: text('title'),
    noteText: text('note_text').notNull().default(''), // the extracted legal notes
    source: text('source'), // source PDF filename
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    scopeRefIdx: index('hts_notes_scope_ref_idx').on(t.scope, t.ref),
    chapterIdx: index('hts_notes_chapter_idx').on(t.chapter),
  }),
);

/** Best-effort cache of CBP CROSS rulings fetched live by the search_rulings tool. */
export const htsRulingsCache = pgTable(
  'hts_rulings_cache',
  {
    id: serial('id').primaryKey(),
    rulingNumber: text('ruling_number').notNull(),
    subject: text('subject'),
    tariffs: jsonb('tariffs'), // string[] of assigned HTS codes
    rulingDate: timestamp('ruling_date'),
    collection: text('collection'),
    fullText: text('full_text'),
    fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
  },
  (t) => ({
    rulingNumberIdx: uniqueIndex('hts_rulings_cache_number_idx').on(t.rulingNumber),
  }),
);

/** Labeled evaluation cases derived from CBP CROSS rulings (product text -> correct code). */
export const htsEvalCases = pgTable(
  'hts_eval_cases',
  {
    id: serial('id').primaryKey(),
    rulingNumber: text('ruling_number').notNull(),
    productText: text('product_text').notNull(),
    correctCode: text('correct_code').notNull(), // primary assigned tariff
    allCodes: jsonb('all_codes'), // string[] of all tariffs in the ruling
    rulingDate: timestamp('ruling_date'),
    collection: text('collection'),
    source: text('source').notNull().default('CROSS'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => ({
    rulingNumberIdx: uniqueIndex('hts_eval_cases_number_idx').on(t.rulingNumber),
  }),
);

/** Cache of CROSS *search* results, keyed by normalized "query|limit". Lets the
 * search_rulings tool serve repeated queries instantly without a live HTTP call. */
export const htsRulingSearches = pgTable(
  'hts_ruling_searches',
  {
    id: serial('id').primaryKey(),
    queryKey: text('query_key').notNull(),
    output: text('output').notNull(), // the formatted tool output, incl. top-ruling snippet
    fetchedAt: timestamp('fetched_at').notNull().defaultNow(),
  },
  (t) => ({
    queryKeyIdx: uniqueIndex('hts_ruling_searches_key_idx').on(t.queryKey),
  }),
);

export type HtsCodeRow = typeof htsCodes.$inferSelect;
export type NewHtsCodeRow = typeof htsCodes.$inferInsert;
export type HtsNoteRow = typeof htsNotes.$inferSelect;
export type HtsEvalCaseRow = typeof htsEvalCases.$inferSelect;
