import prisma from './prisma.js';
import { EventType } from '@prisma/client';

export const DEFAULT_RATE_LIMITS: Record<EventType, { limit: number; windowSeconds: number }> = {
  [EventType.JINA_EMBEDDINGS]: { limit: 5000, windowSeconds: 86400 },
  [EventType.JINA_RERANK]: { limit: 5000, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_NAMESPACE_QUERY]: { limit: 200, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_NAMESPACE_UPSERT]: { limit: 5, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_NAMESPACE_CLEAR]: { limit: 20, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_NAMESPACE_EXISTS]: { limit: 10000, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_HYBRID]: { limit: 200, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_CHUNKS_IDS]: { limit: 200, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_CHUNKS_DELETE]: { limit: 5, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_QUERY]: { limit: 200, windowSeconds: 86400 },
  [EventType.TURBOPUFFER_UPSERT]: { limit: 5, windowSeconds: 86400 }
};

export type RateLimitCheck = {
  allowed: boolean;
  limit?: number;
  used?: number;
  remaining?: number;
  retryAfterSeconds?: number;
};

export async function checkRateLimit(apiKeyId: number, eventType: EventType): Promise<RateLimitCheck> {
  const rl = await prisma.rateLimit.findUnique({
    where: { apiKeyId_eventType: { apiKeyId, eventType } }
  });

  if (!rl) return { allowed: true };

  const now = Date.now();
  const isExpired = rl.windowResetAt.getTime() <= now;
  const effectiveUsed = isExpired ? 0 : rl.used;
  const effectiveResetAtMs = isExpired ? now + rl.windowSeconds * 1000 : rl.windowResetAt.getTime();

  const allowed = effectiveUsed < rl.limit;
  const remaining = Math.max(0, rl.limit - effectiveUsed);
  const retryAfterSeconds = allowed ? 0 : Math.max(1, Math.ceil((effectiveResetAtMs - now) / 1000));

  return {
    allowed,
    limit: rl.limit,
    used: effectiveUsed,
    remaining,
    retryAfterSeconds
  };
}

export async function recordRateLimitUsage(apiKeyId: number, eventType: EventType): Promise<void> {
  const now = Date.now();
  const nowDate = new Date(now);
  await prisma.$transaction(async (tx) => {
    const rl = await tx.rateLimit.findUnique({
      where: { apiKeyId_eventType: { apiKeyId, eventType } }
    });
    if (!rl) return; // No rate limit configured for this event

    const expired = rl.windowResetAt.getTime() <= now;
    if (expired) {
      await tx.rateLimit.update({
        where: { apiKeyId_eventType: { apiKeyId, eventType } },
        data: {
          used: 1,
          windowResetAt: new Date(now + rl.windowSeconds * 1000),
          updatedAt: nowDate
        }
      });
    } else {
      await tx.rateLimit.update({
        where: { apiKeyId_eventType: { apiKeyId, eventType } },
        data: {
          used: { increment: 1 },
          updatedAt: nowDate
        }
      });
    }
  });
}


