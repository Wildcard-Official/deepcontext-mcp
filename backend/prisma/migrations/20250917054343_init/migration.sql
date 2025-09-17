-- CreateEnum
CREATE TYPE "public"."EventType" AS ENUM ('TURBOPUFFER_QUERY', 'TURBOPUFFER_UPSERT', 'JINA_EMBEDDINGS', 'JINA_RERANK', 'TURBOPUFFER_NAMESPACE_QUERY', 'TURBOPUFFER_NAMESPACE_UPSERT', 'TURBOPUFFER_NAMESPACE_CLEAR', 'TURBOPUFFER_NAMESPACE_EXISTS', 'TURBOPUFFER_HYBRID', 'TURBOPUFFER_CHUNKS_IDS', 'TURBOPUFFER_CHUNKS_DELETE');

-- CreateTable
CREATE TABLE "public"."ApiKey" (
    "id" SERIAL NOT NULL,
    "hash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Namespace" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "rootPath" TEXT,
    "apiKeyId" INTEGER NOT NULL,

    CONSTRAINT "Namespace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Event" (
    "id" SERIAL NOT NULL,
    "type" "public"."EventType" NOT NULL,
    "namespaceId" INTEGER,
    "metadata" JSONB,
    "durationMs" INTEGER,
    "statusCode" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "apiKeyId" INTEGER NOT NULL,

    CONSTRAINT "Event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_hash_key" ON "public"."ApiKey"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "Namespace_name_key" ON "public"."Namespace"("name");

-- AddForeignKey
ALTER TABLE "public"."Namespace" ADD CONSTRAINT "Namespace_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "public"."ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "public"."Namespace"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."Event" ADD CONSTRAINT "Event_apiKeyId_fkey" FOREIGN KEY ("apiKeyId") REFERENCES "public"."ApiKey"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
