import { FastifyPluginAsync } from 'fastify';
import { EventType } from '@prisma/client';
import { checkRateLimit, recordRateLimitUsage } from '../lib/ratelimit.js';
import { forwardToJina, withEmbeddingDefaults, withRerankDefaults } from './helpers/embeddings.js';

const route: FastifyPluginAsync = async (fastify) => {
  // Embeddings
  fastify.post(
    '/jina/embeddings',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            input: { type: 'array', items: { type: 'string' } },
            model: { type: 'string' },
            dimensions: { type: 'number' }
          },
          required: ['input']
        }
      }
    },
    async (req, reply) => {
      const body = req.body as any;
      const apiKeyId = req.apiKey!.id;
      const rl = await checkRateLimit(apiKeyId, EventType.JINA_EMBEDDINGS);
      if (!rl.allowed) {
        return reply.code(429).send({ error: 'Rate limit exceeded', retryAfterSeconds: rl.retryAfterSeconds });
      }
      const jinaBody = withEmbeddingDefaults(body);
      await forwardToJina({ path: '/embeddings', method: 'POST', body: jinaBody, apiKeyId, eventType: EventType.JINA_EMBEDDINGS, reply });
      await recordRateLimitUsage(apiKeyId, EventType.JINA_EMBEDDINGS);
    }
  );

  // Rerank
  fastify.post(
    '/jina/rerank',
    {
      schema: {
        body: {
          type: 'object',
          properties: {
            model: { type: 'string' },
            query: { type: 'string' },
            documents: { type: 'array', items: { type: 'string' } },
            top_n: { type: 'number' },
            return_documents: { type: 'boolean' }
          },
          required: ['query', 'documents']
        }
      }
    },
    async (req, reply) => {
      const body = req.body as any;
      const apiKeyId = req.apiKey!.id;
      const rl = await checkRateLimit(apiKeyId, EventType.JINA_RERANK);
      if (!rl.allowed) {
        return reply.code(429).send({ error: 'Rate limit exceeded', retryAfterSeconds: rl.retryAfterSeconds });
      }
      const jinaBody = withRerankDefaults(body);
      await forwardToJina({ path: '/rerank', method: 'POST', body: jinaBody, apiKeyId, eventType: EventType.JINA_RERANK, reply });
      await recordRateLimitUsage(apiKeyId, EventType.JINA_RERANK);
    }
  );
};

export default route;
