CREATE TABLE "hts_ruling_searches" (
	"id" serial PRIMARY KEY NOT NULL,
	"query_key" text NOT NULL,
	"output" text NOT NULL,
	"fetched_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "hts_ruling_searches_key_idx" ON "hts_ruling_searches" USING btree ("query_key");