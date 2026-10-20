-- Remove rows that would violate the new foreign keys
DELETE FROM "AIGenerationResult" WHERE "userId" NOT IN (SELECT "id" FROM "User");
DELETE FROM "TTSJob" WHERE "userId" IS NOT NULL AND "userId" NOT IN (SELECT "id" FROM "User");
UPDATE "WebhookSubscription" SET "userId" = NULL WHERE "userId" IS NOT NULL AND "userId" NOT IN (SELECT "id" FROM "User");
UPDATE "AuditLog" SET "userId" = NULL WHERE "userId" NOT IN (SELECT "id" FROM "User");

-- AuditLog.userId becomes nullable so SetNull can apply
ALTER TABLE "AuditLog" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AIGenerationResult" ADD CONSTRAINT "AIGenerationResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WebhookSubscription" ADD CONSTRAINT "WebhookSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TTSJob" ADD CONSTRAINT "TTSJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
