-- CreateTable
CREATE TABLE "public"."ApiKeyEmail" (
    "id" SERIAL NOT NULL,
    "email" TEXT NOT NULL,
    "apiKeyId" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKeyEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApiKeyEmail_email_idx" ON "public"."ApiKeyEmail"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKeyEmail_email_apiKeyId_key" ON "public"."ApiKeyEmail"("email", "apiKeyId");

-- AddForeignKey
ALTER TABLE "public"."ApiKeyEmail" ADD CONSTRAINT "ApiKeyEmail_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "public"."ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
