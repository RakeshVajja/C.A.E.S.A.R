-- AlterTable
ALTER TABLE "users" ADD COLUMN     "password_reset_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "password_reset_code_hash" TEXT,
ADD COLUMN     "password_reset_expires_at" TIMESTAMPTZ(3),
ADD COLUMN     "password_reset_last_sent_at" TIMESTAMPTZ(3),
ADD COLUMN     "password_reset_send_count" INTEGER NOT NULL DEFAULT 0;
