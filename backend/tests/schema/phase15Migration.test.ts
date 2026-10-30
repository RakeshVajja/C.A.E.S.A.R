import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Static checks of the Phase 15.2 migrations (Project_plan.md §22.5). They read the SQL files only;
 * applying the migrations is a separate, owner-approved step.
 */

const migrations = path.resolve(__dirname, '../../prisma/migrations');
const read = (name: string) => fs.readFileSync(path.join(migrations, name, 'migration.sql'), 'utf8');
const enumValues = read('20261030120000_phase15_enum_values');
const foundation = read('20261030120100_phase15_schema_foundation');
const schema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
const statements = (sql: string) =>
  sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

describe('Phase 15.2 migrations', () => {
  it('adds new enum values in their own migration, and nothing else there', () => {
    const stmts = statements(enumValues);
    expect(stmts).toEqual([
      `ALTER TYPE "identity_source" ADD VALUE 'SCOPUS'`,
      `ALTER TYPE "identity_source" ADD VALUE 'WOS'`,
      `ALTER TYPE "publication_source" ADD VALUE 'SCOPUS'`,
      `ALTER TYPE "publication_source" ADD VALUE 'WOS'`,
      `ALTER TYPE "sync_task_status" ADD VALUE 'NOT_CONFIGURED'`,
    ]);
    expect(foundation).not.toMatch(/ADD VALUE/);
  });

  it('creates exactly the five approved tables (14 in total)', () => {
    const created = [...foundation.matchAll(/CREATE TABLE "([a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(created).toEqual(['citation_observations', 'journal_category_metrics', 'journal_issns', 'journal_metric_snapshots', 'journals']);
    expect([...schema.matchAll(/^model \w+/gm)]).toHaveLength(14);
  });

  it('enforces the SyncTask kind shape and one task per journal per run', () => {
    expect(foundation).toMatch(/"sync_tasks_kind_shape_check" CHECK \(\s*\("kind" = 'IDENTITY_DISCOVERY' AND "source" IS NOT NULL AND "journal_id" IS NULL\)\s*OR \("kind" = 'JOURNAL_METRICS' AND "source" IS NULL AND "identity_id" IS NULL\)/);
    expect(foundation).toMatch(/CREATE UNIQUE INDEX "sync_tasks_sync_run_id_journal_id_key" ON "sync_tasks"\("sync_run_id", "journal_id"\)/);
    expect(foundation).toMatch(/ALTER COLUMN "source" DROP NOT NULL/);
  });

  it('keeps JCR edition non-null without an allowlist, and checks quartiles', () => {
    expect(foundation).toMatch(/"edition" TEXT NOT NULL DEFAULT ''/);
    expect(foundation).toMatch(/UNIQUE INDEX "journal_category_metrics_snapshot_id_metric_category_name_e_key" ON "journal_category_metrics"\("snapshot_id", "metric", "category_name", "edition"\)/);
    expect(foundation).not.toMatch(/"edition" IN/);
    expect(foundation).toMatch(/"quartile" IS NULL OR "quartile" IN \('Q1', 'Q2', 'Q3', 'Q4'\)/);
  });

  it('identifies snapshots by journal, JCR year and revision', () => {
    expect(foundation).toMatch(/UNIQUE INDEX "journal_metric_snapshots_journal_id_jcr_year_revision_key" ON "journal_metric_snapshots"\("journal_id", "jcr_year", "revision"\)/);
    expect(foundation).toMatch(/"payload_hash" ~ '\^\[0-9a-f\]\{64\}\$'/);
  });

  it('limits citation observations to Scopus and WoS and restricts entry basis to MANUAL records', () => {
    expect(foundation).toMatch(/CHECK \("provider" IN \('SCOPUS', 'WOS'\)\)/);
    expect(foundation).toMatch(/CHECK \("source" = 'MANUAL' OR \("entry_basis" IS NULL AND "entry_evidence" IS NULL\)\)/);
  });

  it('stores a provider-coverage snapshot only on discovery runs', () => {
    expect(foundation).toMatch(/ADD COLUMN\s+"provider_coverage" JSONB,/);
    expect(foundation).toMatch(/"sync_runs_provider_coverage_check" CHECK \(\s*\("provider_coverage" IS NULL OR jsonb_typeof\("provider_coverage"\) = 'object'\)\s*AND \("kind" = 'PUBLICATION_DISCOVERY' OR "provider_coverage" IS NULL\)/);
  });

  it('records existing identities as PRE_PHASE15 instead of inventing verification provenance', () => {
    expect(foundation).toMatch(/CREATE TYPE "identity_verification_method" AS ENUM \('API_PREVIEW', 'MANUAL_PROFILE', 'PRE_PHASE15'\)/);
    expect(foundation).toMatch(/"verification_method" "identity_verification_method" NOT NULL DEFAULT 'PRE_PHASE15'/);
    expect(foundation).not.toMatch(/UPDATE "external_identities"/);
  });

  it('drops nothing and changes no column type; the only relaxation is sync_tasks.source', () => {
    const stmts = statements(foundation);
    expect(stmts.filter((s) => /\bDROP\b/.test(s))).toEqual([expect.stringMatching(/^ALTER TABLE "sync_tasks" ADD COLUMN[\s\S]*ALTER COLUMN "source" DROP NOT NULL$/)]);
    expect(foundation).not.toMatch(/SET DATA TYPE|ALTER COLUMN "\w+" TYPE/);
  });

  it('backfills only curation and entry basis, never canonical publication fields', () => {
    const updates = statements(foundation).filter((s) => s.startsWith('UPDATE'));
    expect(updates).toHaveLength(2);
    expect(updates[0]).toMatch(/^UPDATE "publications"\s+SET "curation" = jsonb_build_object\(/);
    expect(updates[0]).toMatch(/WHERE "is_curated" = true$/);
    expect(updates[1]).toMatch(/^UPDATE "publication_source_records"\s+SET "entry_basis" = 'PRE_PHASE15'\s+WHERE "source" = 'MANUAL' AND "entry_basis" IS NULL$/);
    for (const field of ['title', 'year', 'venue', 'type_family', 'author_names_display', 'doi']) {
      expect(updates[0]).toContain(`'${field}',`);
    }
  });
});
