-- Company-scoped answer library: '' = GLOBAL (all pre-existing rows become
-- global). A company-scoped answer resolves only for its company; a global
-- answer resolves for any company but loses to a company-scoped match.
ALTER TABLE "answers" ADD COLUMN "company" text DEFAULT '' NOT NULL;--> statement-breakpoint
-- Dedupe before the unique index: the previous upsert was check-then-insert
-- (no constraint), so concurrent saves could have left duplicate
-- normalized_label rows. Keep the newest row per label (created_at, id as
-- tiebreak); every pre-migration row is global, so labels alone collide.
DELETE FROM "answers" a USING "answers" b
WHERE a."normalized_label" = b."normalized_label"
  AND a."id" <> b."id"
  AND (
    coalesce(a."created_at", '-infinity'::timestamptz) < coalesce(b."created_at", '-infinity'::timestamptz)
    OR (
      coalesce(a."created_at", '-infinity'::timestamptz) = coalesce(b."created_at", '-infinity'::timestamptz)
      AND a."id" < b."id"
    )
  );--> statement-breakpoint
CREATE UNIQUE INDEX "answers_company_normalized_label_uq" ON "answers" USING btree ("company","normalized_label");
