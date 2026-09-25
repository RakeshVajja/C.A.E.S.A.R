-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('ADMIN', 'PROFESSOR');

-- CreateEnum
CREATE TYPE "identity_source" AS ENUM ('OPENALEX', 'DBLP', 'ORCID');

-- CreateEnum
CREATE TYPE "publication_source" AS ENUM ('OPENALEX', 'DBLP', 'ORCID', 'MANUAL');

-- CreateEnum
CREATE TYPE "type_family" AS ENUM ('PREPRINT', 'CONFERENCE', 'JOURNAL', 'BOOK_CHAPTER', 'BOOK', 'OTHER');

-- CreateEnum
CREATE TYPE "publication_status" AS ENUM ('ACTIVE', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "match_method" AS ENUM ('DOI', 'TITLE_YEAR', 'NEW_PUBLICATION', 'ADMIN');

-- CreateEnum
CREATE TYPE "verification_status" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "relationship_origin" AS ENUM ('DISCOVERED', 'MANUAL', 'ADMIN');

-- CreateEnum
CREATE TYPE "duplicate_candidate_status" AS ENUM ('OPEN', 'MERGED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "sync_trigger" AS ENUM ('MANUAL', 'SCHEDULED');

-- CreateEnum
CREATE TYPE "sync_run_status" AS ENUM ('RUNNING', 'SUCCESS', 'PARTIAL_SUCCESS', 'FAILED');

-- CreateEnum
CREATE TYPE "sync_task_status" AS ENUM ('PENDING', 'RUNNING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "user_role" NOT NULL,
    "must_change_password" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professors" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "name" TEXT NOT NULL,
    "department" TEXT,
    "designation" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "professors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "external_identities" (
    "id" UUID NOT NULL,
    "professor_id" UUID NOT NULL,
    "source" "identity_source" NOT NULL,
    "external_id" TEXT NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "external_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publications" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "normalized_title" TEXT NOT NULL,
    "year" INTEGER,
    "venue" TEXT,
    "type_family" "type_family" NOT NULL,
    "author_names_display" TEXT,
    "doi" TEXT,
    "status" "publication_status" NOT NULL DEFAULT 'ACTIVE',
    "is_curated" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "publication_source_records" (
    "id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "source" "publication_source" NOT NULL,
    "external_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "normalized_title" TEXT NOT NULL,
    "doi" TEXT,
    "year" INTEGER,
    "venue" TEXT,
    "type_family" "type_family" NOT NULL,
    "raw_metadata" JSONB,
    "match_method" "match_method" NOT NULL,
    "match_detail" TEXT,
    "created_by_user_id" UUID,
    "first_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "publication_source_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "professor_publications" (
    "id" UUID NOT NULL,
    "professor_id" UUID NOT NULL,
    "publication_id" UUID NOT NULL,
    "status" "verification_status" NOT NULL DEFAULT 'PENDING',
    "origin" "relationship_origin" NOT NULL,
    "discovered_via_identity_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decided_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "professor_publications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_candidates" (
    "id" UUID NOT NULL,
    "publication_a_id" UUID,
    "publication_b_id" UUID,
    "reason" TEXT NOT NULL,
    "status" "duplicate_candidate_status" NOT NULL DEFAULT 'OPEN',
    "resolved_by_user_id" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "duplicate_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "trigger" "sync_trigger" NOT NULL,
    "triggered_by_user_id" UUID,
    "status" "sync_run_status" NOT NULL DEFAULT 'RUNNING',
    "tasks_total" INTEGER NOT NULL DEFAULT 0,
    "tasks_succeeded" INTEGER NOT NULL DEFAULT 0,
    "tasks_failed" INTEGER NOT NULL DEFAULT 0,
    "records_fetched" INTEGER NOT NULL DEFAULT 0,
    "records_new" INTEGER NOT NULL DEFAULT 0,
    "records_updated" INTEGER NOT NULL DEFAULT 0,
    "links_created" INTEGER NOT NULL DEFAULT 0,
    "candidates_created" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_tasks" (
    "id" UUID NOT NULL,
    "sync_run_id" UUID NOT NULL,
    "identity_id" UUID,
    "source" "identity_source" NOT NULL,
    "status" "sync_task_status" NOT NULL DEFAULT 'PENDING',
    "records_fetched" INTEGER NOT NULL DEFAULT 0,
    "records_new" INTEGER NOT NULL DEFAULT 0,
    "records_updated" INTEGER NOT NULL DEFAULT 0,
    "links_created" INTEGER NOT NULL DEFAULT 0,
    "candidates_created" INTEGER NOT NULL DEFAULT 0,
    "warnings" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "sync_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "professors_user_id_key" ON "professors"("user_id");

-- CreateIndex
CREATE INDEX "external_identities_professor_id_idx" ON "external_identities"("professor_id");

-- CreateIndex
CREATE UNIQUE INDEX "external_identities_source_external_id_key" ON "external_identities"("source", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "publications_doi_key" ON "publications"("doi");

-- CreateIndex
CREATE INDEX "publications_normalized_title_idx" ON "publications"("normalized_title");

-- CreateIndex
CREATE INDEX "publications_year_idx" ON "publications"("year");

-- CreateIndex
CREATE INDEX "publication_source_records_publication_id_idx" ON "publication_source_records"("publication_id");

-- CreateIndex
CREATE INDEX "publication_source_records_doi_idx" ON "publication_source_records"("doi");

-- CreateIndex
CREATE INDEX "publication_source_records_normalized_title_idx" ON "publication_source_records"("normalized_title");

-- CreateIndex
CREATE UNIQUE INDEX "publication_source_records_source_external_id_key" ON "publication_source_records"("source", "external_id");

-- CreateIndex
CREATE INDEX "professor_publications_professor_id_status_idx" ON "professor_publications"("professor_id", "status");

-- CreateIndex
CREATE INDEX "professor_publications_publication_id_idx" ON "professor_publications"("publication_id");

-- CreateIndex
CREATE INDEX "professor_publications_discovered_via_identity_id_idx" ON "professor_publications"("discovered_via_identity_id");

-- CreateIndex
CREATE UNIQUE INDEX "professor_publications_professor_id_publication_id_key" ON "professor_publications"("professor_id", "publication_id");

-- CreateIndex
CREATE INDEX "duplicate_candidates_publication_b_id_idx" ON "duplicate_candidates"("publication_b_id");

-- CreateIndex
CREATE INDEX "duplicate_candidates_status_idx" ON "duplicate_candidates"("status");

-- CreateIndex
CREATE UNIQUE INDEX "duplicate_candidates_publication_a_id_publication_b_id_key" ON "duplicate_candidates"("publication_a_id", "publication_b_id");

-- CreateIndex
CREATE INDEX "sync_runs_started_at_idx" ON "sync_runs"("started_at");

-- CreateIndex
CREATE INDEX "sync_tasks_sync_run_id_idx" ON "sync_tasks"("sync_run_id");

-- CreateIndex
CREATE INDEX "sync_tasks_identity_id_idx" ON "sync_tasks"("identity_id");

-- AddForeignKey
ALTER TABLE "professors" ADD CONSTRAINT "professors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "external_identities" ADD CONSTRAINT "external_identities_professor_id_fkey" FOREIGN KEY ("professor_id") REFERENCES "professors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_source_records" ADD CONSTRAINT "publication_source_records_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "publication_source_records" ADD CONSTRAINT "publication_source_records_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professor_publications" ADD CONSTRAINT "professor_publications_professor_id_fkey" FOREIGN KEY ("professor_id") REFERENCES "professors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professor_publications" ADD CONSTRAINT "professor_publications_publication_id_fkey" FOREIGN KEY ("publication_id") REFERENCES "publications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professor_publications" ADD CONSTRAINT "professor_publications_discovered_via_identity_id_fkey" FOREIGN KEY ("discovered_via_identity_id") REFERENCES "external_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "professor_publications" ADD CONSTRAINT "professor_publications_decided_by_user_id_fkey" FOREIGN KEY ("decided_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_publication_a_id_fkey" FOREIGN KEY ("publication_a_id") REFERENCES "publications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_publication_b_id_fkey" FOREIGN KEY ("publication_b_id") REFERENCES "publications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_tasks" ADD CONSTRAINT "sync_tasks_sync_run_id_fkey" FOREIGN KEY ("sync_run_id") REFERENCES "sync_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_tasks" ADD CONSTRAINT "sync_tasks_identity_id_fkey" FOREIGN KEY ("identity_id") REFERENCES "external_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Hand-written: constraints Prisma cannot express in schema.prisma.
-- A duplicate pair is stored once, in canonical order (a < b), and never pairs a publication with itself.
ALTER TABLE "duplicate_candidates"
  ADD CONSTRAINT "duplicate_candidates_ordered_pair_check"
  CHECK ("publication_a_id" < "publication_b_id");
