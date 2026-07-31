CREATE TABLE "hts_codes" (
	"id" serial PRIMARY KEY NOT NULL,
	"htsno" text DEFAULT '' NOT NULL,
	"indent" integer DEFAULT 0 NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"description_full" text DEFAULT '' NOT NULL,
	"chapter" text NOT NULL,
	"heading" text,
	"superior" boolean DEFAULT false NOT NULL,
	"units" jsonb,
	"general" text,
	"special" text,
	"other" text,
	"footnotes" jsonb,
	"quota_quantity" text,
	"additional_duties" text,
	"rev" text,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hts_eval_cases" (
	"id" serial PRIMARY KEY NOT NULL,
	"ruling_number" text NOT NULL,
	"product_text" text NOT NULL,
	"correct_code" text NOT NULL,
	"all_codes" jsonb,
	"ruling_date" timestamp,
	"collection" text,
	"source" text DEFAULT 'CROSS' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hts_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"scope" text NOT NULL,
	"ref" text NOT NULL,
	"chapter" text,
	"title" text,
	"note_text" text DEFAULT '' NOT NULL,
	"source" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hts_rulings_cache" (
	"id" serial PRIMARY KEY NOT NULL,
	"ruling_number" text NOT NULL,
	"subject" text,
	"tariffs" jsonb,
	"ruling_date" timestamp,
	"collection" text,
	"full_text" text,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "hts_codes_htsno_idx" ON "hts_codes" USING btree ("htsno");--> statement-breakpoint
CREATE INDEX "hts_codes_chapter_idx" ON "hts_codes" USING btree ("chapter");--> statement-breakpoint
CREATE INDEX "hts_codes_heading_idx" ON "hts_codes" USING btree ("heading");--> statement-breakpoint
CREATE UNIQUE INDEX "hts_eval_cases_number_idx" ON "hts_eval_cases" USING btree ("ruling_number");--> statement-breakpoint
CREATE INDEX "hts_notes_scope_ref_idx" ON "hts_notes" USING btree ("scope","ref");--> statement-breakpoint
CREATE INDEX "hts_notes_chapter_idx" ON "hts_notes" USING btree ("chapter");--> statement-breakpoint
CREATE UNIQUE INDEX "hts_rulings_cache_number_idx" ON "hts_rulings_cache" USING btree ("ruling_number");