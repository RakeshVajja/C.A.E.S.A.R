-- Phase 15 (Project_plan.md §22.5; decisions #107–#125), part 2 of 2: schema foundation.
-- Five new tables (14 in total), new columns on existing tables, and the hand-written constraints
-- and backfills at the end. Canonical publication fields and matching are unchanged.
-- Existing identities get verification_method PRE_PHASE15 from the column default (their
-- verification provenance was not recorded); existing runs keep provider_coverage NULL.

-- CreateEnum
CREATE TYPE "sync_run_kind" AS ENUM ('PUBLICATION_DISCOVERY', 'JOURNAL_METRICS');

-- CreateEnum
CREATE TYPE "sync_task_kind" AS ENUM ('IDENTITY_DISCOVERY', 'JOURNAL_METRICS');

-- CreateEnum
CREATE TYPE "identity_verification_method" AS ENUM ('API_PREVIEW', 'MANUAL_PROFILE', 'PRE_PHASE15');

-- CreateEnum
CREATE TYPE "journal_issn_kind" AS ENUM ('PRINT', 'ELECTRONIC', 'PREVIOUS');

-- CreateEnum
CREATE TYPE "jcr_rank_metric" AS ENUM ('JIF', 'JCI');

-- AlterTable
ALTER TABLE "external_identities" ADD COLUMN     "verification_evidence_url" TEXT,
ADD COLUMN     "verification_method" "identity_verification_method" NOT NULL DEFAULT 'PRE_PHASE15',
ADD COLUMN     "verified_by_user_id" UUID;

-- AlterTable
ALTER TABLE "publications" ADD COLUMN     "curation" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "journal_id" UUID;

-- AlterTable
ALTER TABLE "publication_source_records" ADD COLUMN     "entry_basis" TEXT,
ADD COLUMN     "entry_evidence" TEXT,
ADD COLUMN     "issns" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "sync_runs" ADD COLUMN     "jcr_data_update" DATE,
ADD COLUMN     "journals_checked" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "kind" "sync_run_kind" NOT NULL DEFAULT 'PUBLICATION_DISCOVERY',
ADD COLUMN     "provider_coverage" JSONB,
ADD COLUMN     "snapshots_added" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sync_tasks" ADD COLUMN     "journal_id" UUID,
ADD COLUMN     "kind" "sync_task_kind" NOT NULL DEFAULT 'IDENTITY_DISCOVERY',
ADD COLUMN     "snapshots_added" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "source" DROP NOT NULL;

-- CreateTable
CREATE TABLE "citation_observations" (
    "id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "provider" "publication_source" NOT NULL,
    "database" TEXT,
    "count" INTEGER NOT NULL,
    "observed_at" TIMESTAMPTZ(3) NOT NULL,
    "sync_task_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "citation_observations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journals" (
    "id" UUID NOT NULL,
    "jcr_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "jcr_title" TEXT,
    "iso_title" TEXT,
    "publisher_name" TEXT,
    "first_issue_year" INTEGER,
    "frequency" INTEGER,
    "language" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "journals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_issns" (
    "id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "issn" CHAR(9) NOT NULL,
    "kind" "journal_issn_kind" NOT NULL,
    "valid_from_year" INTEGER,
    "valid_to_year" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_issns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_metric_snapshots" (
    "id" UUID NOT NULL,
    "journal_id" UUID NOT NULL,
    "jcr_year" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "jcr_data_update" DATE,
    "retrieved_at" TIMESTAMPTZ(3) NOT NULL,
    "sync_task_id" UUID,
    "total_cites" INTEGER,
    "jif_text" TEXT,
    "jif_without_self_text" TEXT,
    "jif_5_years" DOUBLE PRECISION,
    "immediacy_index" DOUBLE PRECISION,
    "jci" DOUBLE PRECISION,
    "average_jif_percentile" DOUBLE PRECISION,
    "suppressed" BOOLEAN,
    "on_hold" BOOLEAN,
    "delisted" BOOLEAN,
    "jif_value" DOUBLE PRECISION,
    "jif_without_self_value" DOUBLE PRECISION,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "journal_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "journal_category_metrics" (
    "id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "metric" "jcr_rank_metric" NOT NULL,
    "category_name" TEXT NOT NULL,
    "category_code" TEXT,
    "edition" TEXT NOT NULL DEFAULT '',
    "rank_text" TEXT,
    "rank" INTEGER,
    "rank_total" INTEGER,
    "quartile" TEXT,
    "percentile" DOUBLE PRECISION,

    CONSTRAINT "journal_category_metrics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "citation_observations_source_record_id_observed_at_idx" ON "citation_observations"("source_record_id", "observed_at");

-- CreateIndex
CREATE INDEX "citation_observations_provider_observed_at_idx" ON "citation_observations"("provider", "observed_at");

-- CreateIndex
CREATE INDEX "citation_observations_sync_task_id_idx" ON "citation_observations"("sync_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "citation_observations_source_record_id_sync_task_id_key" ON "citation_observations"("source_record_id", "sync_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "journals_jcr_id_key" ON "journals"("jcr_id");

-- CreateIndex
CREATE INDEX "journal_issns_issn_idx" ON "journal_issns"("issn");

-- CreateIndex
CREATE UNIQUE INDEX "journal_issns_journal_id_issn_key" ON "journal_issns"("journal_id", "issn");

-- CreateIndex
CREATE INDEX "journal_metric_snapshots_journal_id_jcr_year_retrieved_at_idx" ON "journal_metric_snapshots"("journal_id", "jcr_year", "retrieved_at");

-- CreateIndex
CREATE INDEX "journal_metric_snapshots_sync_task_id_idx" ON "journal_metric_snapshots"("sync_task_id");

-- CreateIndex
CREATE UNIQUE INDEX "journal_metric_snapshots_journal_id_jcr_year_revision_key" ON "journal_metric_snapshots"("journal_id", "jcr_year", "revision");

-- CreateIndex
CREATE UNIQUE INDEX "journal_category_metrics_snapshot_id_metric_category_name_e_key" ON "journal_category_metrics"("snapshot_id", "metric", "category_name", "edition");

-- CreateIndex
CREATE INDEX "external_identities_verified_by_user_id_idx" ON "external_identities"("verified_by_user_id");

-- CreateIndex
CREATE INDEX "publications_journal_id_idx" ON "publications"("journal_id");

-- CreateIndex
CREATE INDEX "publication_source_records_issns_idx" ON "publication_source_records" USING GIN ("issns");

-- CreateIndex
CREATE INDEX "sync_runs_kind_started_at_idx" ON "sync_runs"("kind", "started_at");

-- CreateIndex
CREATE INDEX "sync_tasks_journal_id_idx" ON "sync_tasks"("journal_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_tasks_sync_run_id_journal_id_key" ON "sync_tasks"("sync_run_id", "journal_id");

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_verified_by_user_id_fkey" FOREIGN KEY ("verified_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publications" ADD CONSTRAINT "publications_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_tasks" ADD CONSTRAINT "sync_tasks_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citation_observations" ADD CONSTRAINT "citation_observations_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "publication_source_records"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "citation_observations" ADD CONSTRAINT "citation_observations_sync_task_id_fkey" FOREIGN KEY ("sync_task_id") REFERENCES "sync_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_issns" ADD CONSTRAINT "journal_issns_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_metric_snapshots" ADD CONSTRAINT "journal_metric_snapshots_journal_id_fkey" FOREIGN KEY ("journal_id") REFERENCES "journals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_metric_snapshots" ADD CONSTRAINT "journal_metric_snapshots_sync_task_id_fkey" FOREIGN KEY ("sync_task_id") REFERENCES "sync_tasks"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "journal_category_metrics" ADD CONSTRAINT "journal_category_metrics_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "journal_metric_snapshots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Hand-written constraints (not expressible in the Prisma schema) ─────────────────────────────

-- SyncTask shape (decision #123): identity tasks have a source and no journal; journal-metrics tasks
-- have neither a source nor an identity. identity_id / journal_id may be NULL in history rows.
ALTER TABLE "sync_tasks" ADD CONSTRAINT "sync_tasks_kind_shape_check" CHECK (
  ("kind" = 'IDENTITY_DISCOVERY' AND "source" IS NOT NULL AND "journal_id" IS NULL)
  OR ("kind" = 'JOURNAL_METRICS' AND "source" IS NULL AND "identity_id" IS NULL)
);

-- Citation observations come only from Scopus and Web of Science (decision #111).
ALTER TABLE "citation_observations" ADD CONSTRAINT "citation_observations_provider_check"
  CHECK ("provider" IN ('SCOPUS', 'WOS'));
ALTER TABLE "citation_observations" ADD CONSTRAINT "citation_observations_count_check"
  CHECK ("count" >= 0);

-- Journal ISSNs are stored normalized ("NNNN-NNNX").
ALTER TABLE "journal_issns" ADD CONSTRAINT "journal_issns_issn_format_check"
  CHECK ("issn" ~ '^[0-9]{4}-[0-9]{3}[0-9X]$');
ALTER TABLE "journal_issns" ADD CONSTRAINT "journal_issns_validity_check"
  CHECK ("valid_from_year" IS NULL OR "valid_to_year" IS NULL OR "valid_from_year" <= "valid_to_year");

-- Snapshot identity (decision #122): revisions start at 1; the hash is lower-case hex SHA-256.
ALTER TABLE "journal_metric_snapshots" ADD CONSTRAINT "journal_metric_snapshots_revision_check"
  CHECK ("revision" >= 1);
ALTER TABLE "journal_metric_snapshots" ADD CONSTRAINT "journal_metric_snapshots_payload_hash_check"
  CHECK ("payload_hash" ~ '^[0-9a-f]{64}$');

-- Category metrics: quartile Q1–Q4 when present; positive ranks. No allowlist on "edition":
-- unfamiliar edition identifiers are stored as returned and reported for review.
ALTER TABLE "journal_category_metrics" ADD CONSTRAINT "journal_category_metrics_quartile_check"
  CHECK ("quartile" IS NULL OR "quartile" IN ('Q1', 'Q2', 'Q3', 'Q4'));
ALTER TABLE "journal_category_metrics" ADD CONSTRAINT "journal_category_metrics_rank_check"
  CHECK (("rank" IS NULL OR "rank" >= 1) AND ("rank_total" IS NULL OR "rank_total" >= 1)
         AND ("rank" IS NULL OR "rank_total" IS NULL OR "rank" <= "rank_total"));

-- Entry basis and evidence belong to MANUAL records only (decision #125).
ALTER TABLE "publication_source_records" ADD CONSTRAINT "publication_source_records_entry_basis_check"
  CHECK ("source" = 'MANUAL' OR ("entry_basis" IS NULL AND "entry_evidence" IS NULL));

-- Provider coverage snapshot (decision #117): an object on discovery runs, absent on JCR runs.
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_provider_coverage_check" CHECK (
  ("provider_coverage" IS NULL OR jsonb_typeof("provider_coverage") = 'object')
  AND ("kind" = 'PUBLICATION_DISCOVERY' OR "provider_coverage" IS NULL)
);

-- Curation is a JSON object keyed by field (decision #125).
ALTER TABLE "publications" ADD CONSTRAINT "publications_curation_object_check"
  CHECK (jsonb_typeof("curation") = 'object');

-- ─── Backfills (no canonical field changes) ──────────────────────────────────────────────────────

-- Publications curated before Phase 15 were protected as a whole record (#90); every canonical
-- field is recorded as PRE_PHASE15 so the field-level rule (#125) keeps exactly that protection.
UPDATE "publications"
SET "curation" = jsonb_build_object(
  'title',                '{"basis": "PRE_PHASE15"}'::jsonb,
  'year',                 '{"basis": "PRE_PHASE15"}'::jsonb,
  'venue',                '{"basis": "PRE_PHASE15"}'::jsonb,
  'type_family',          '{"basis": "PRE_PHASE15"}'::jsonb,
  'author_names_display', '{"basis": "PRE_PHASE15"}'::jsonb,
  'doi',                  '{"basis": "PRE_PHASE15"}'::jsonb
)
WHERE "is_curated" = true;

-- Manual entries made before Phase 15 cannot derive from Scopus, WoS or JCR (none were ingested).
UPDATE "publication_source_records"
SET "entry_basis" = 'PRE_PHASE15'
WHERE "source" = 'MANUAL' AND "entry_basis" IS NULL;
