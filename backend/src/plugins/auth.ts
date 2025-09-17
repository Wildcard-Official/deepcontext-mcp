import fp from 'fastify-plugin';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: { id: number };
    isInternal?: boolean;
  }
}

function hashApiKey(apiKey: string): string {
  return crypto.createHmac('sha256', process.env.SHA256_SECRET as string)
    .update(apiKey)
    .digest('hex');
}

// Export for tests
export { hashApiKey };

export function requireInternalSecret() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const headerSecret = request.headers['x-internal-secret'] as string | undefined;
    if (!headerSecret || headerSecret !== process.env.INTERNAL_SHARED_SECRET) {
      return reply.status(403).send({ error: 'Forbidden' });
    }
    // Mark as internal for downstream logic if needed
    request.isInternal = true;
  };
}

export const authPlugin = fp(async (fastify) => {
  fastify.addHook('preHandler', async (request, reply) => {
    // Internal secret bypass for system/admin routes
    const internalSecret = request.headers['x-internal-secret'] as string | undefined;
    if (internalSecret && internalSecret === process.env.INTERNAL_SHARED_SECRET) {
      request.isInternal = true;
      return;
    }

    const apiKeyHeader = request.headers['x-api-key'] as string | undefined;
    if (!apiKeyHeader) {
      return reply.status(401).send({ error: 'API key required' });
    }

    // Always HMAC the provided key; do not attempt to auto-detect hashed input
    const keyHash = hashApiKey(apiKeyHeader);

    const apiKey = await prisma.apiKey.findUnique({
      where: { hash: keyHash },
    });

    if (!apiKey) {
      return reply.status(401).send({ error: 'Invalid API key' });
    }

    request.apiKey = { id: apiKey.id };
  });
});
