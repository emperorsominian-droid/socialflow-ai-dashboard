-- AlterTable
ALTER TABLE "CreditLog" ADD COLUMN "referenceId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "CreditLog_userId_action_referenceId_key" ON "CreditLog"("userId", "action", "referenceId");
