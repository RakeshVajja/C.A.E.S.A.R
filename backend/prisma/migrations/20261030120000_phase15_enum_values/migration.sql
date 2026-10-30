-- Phase 15 (Project_plan.md §22.5; decisions #107–#125), part 1 of 2: new enum values only.
-- Kept separate because PostgreSQL does not allow a value added by ALTER TYPE ... ADD VALUE to be
-- used in the same transaction; part 2 uses SCOPUS/WOS in CHECK constraints.

-- AlterEnum
ALTER TYPE "identity_source" ADD VALUE 'SCOPUS';
ALTER TYPE "identity_source" ADD VALUE 'WOS';
ALTER TYPE "publication_source" ADD VALUE 'SCOPUS';
ALTER TYPE "publication_source" ADD VALUE 'WOS';
ALTER TYPE "sync_task_status" ADD VALUE 'NOT_CONFIGURED';
