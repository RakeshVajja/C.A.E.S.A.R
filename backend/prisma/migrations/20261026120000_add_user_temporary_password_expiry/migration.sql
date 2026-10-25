-- Emailed temporary passwords expire (decision #102). Additive and nullable: no table, no rewrite
-- of existing data beyond the backfill below; still 9 tables.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "temporary_password_expires_at" TIMESTAMPTZ(3);

-- Backfill: professor accounts that have not yet replaced their temporary password get the
-- standard 7-day window from the moment the migration runs, so nobody is locked out at once.
-- Activated accounts and the administrator keep NULL (no temporary password in use).
UPDATE "users"
SET "temporary_password_expires_at" = CURRENT_TIMESTAMP + INTERVAL '7 days'
WHERE "role" = 'PROFESSOR' AND "must_change_password" = true;
