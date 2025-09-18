-- CreateTable
CREATE TABLE "public"."RateLimit" (
    "id" SERIAL NOT NULL,
    "apiKeyId" INTEGER NOT NULL,
    "eventType" "public"."EventType" NOT NULL,
    "limit" INTEGER NOT NULL,
    "windowSeconds" INTEGER NOT NULL,
    "used" INTEGER NOT NULL DEFAULT 0,
    "windowResetAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RateLimit_apiKeyId_eventType_idx" ON "public"."RateLimit"("apiKeyId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "RateLimit_apiKeyId_eventType_key" ON "public"."RateLimit"("apiKeyId", "eventType");

-- AddForeignKey
ALTER TABLE "public"."RateLimit" ADD CONSTRAINT "RateLimit_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "public"."ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
