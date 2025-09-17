import { FastifyPluginAsync } from 'fastify';
import { EventType } from '@prisma/client';
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
      const jinaBody = withEmbeddingDefaults(body);
      await forwardToJina({ path: '/embeddings', method: 'POST', body: jinaBody, apiKeyId, eventType: EventType.JINA_EMBEDDINGS, reply });
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
      const jinaBody = withRerankDefaults(body);
      await forwardToJina({ path: '/rerank', method: 'POST', body: jinaBody, apiKeyId, eventType: EventType.JINA_RERANK, reply });
    }
  );
};

export default route;
