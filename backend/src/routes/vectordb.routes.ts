import { FastifyPluginAsync } from 'fastify';
import prisma from '../lib/prisma.js';
import { EventType } from '@prisma/client';
import { ensureNamespaceForUpsert, findNamespaceOr404, forwardToTurbopuffer } from './helpers/vectordb.js';

const route: FastifyPluginAsync = async (fastify) => {
  // Upsert => POST /turbopuffer/namespaces/:name
  fastify.post('/turbopuffer/namespaces/:name', {
    schema: {
      body: {
        type: 'object',
        properties: {
          upsert_rows: { type: 'array' },
          deletes: { type: 'array', items: { type: 'string' } },
          distance_metric: { type: 'string' },
          schema: { type: 'object' }
        },
        additionalProperties: true
      }
    }
  }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = req.body as any;
    const apiKeyId = req.apiKey!.id;

    // Ensure namespace belongs to this API key; create if missing on upsert
    let nsRecord = await prisma.namespace.findFirst({ where: { name, apiKeyId } });
    if (!nsRecord && body.upsert_rows) {
      nsRecord = await ensureNamespaceForUpsert(name, apiKeyId);
    }
    if (!nsRecord) return reply.status(404).send({ error: 'Namespace not found for API key' });

    await forwardToTurbopuffer({
      name,
      method: 'POST',
      body,
      apiKeyId,
      namespaceId: nsRecord.id,
      eventType: body.upsert_rows ? EventType.TURBOPUFFER_NAMESPACE_UPSERT : EventType.TURBOPUFFER_CHUNKS_DELETE,
      reply
    });
  });

  // Query => POST /turbopuffer/namespaces/:name/query
  fastify.post('/turbopuffer/namespaces/:name/query', {
    schema: { body: { type: 'object' } }
  }, async (req, reply) => {
    const { name } = req.params as { name: string };
    const body = req.body as any;
    const apiKeyId = req.apiKey!.id;
    const nsRecord = await findNamespaceOr404(name, apiKeyId, reply);
    if (!nsRecord) return;

    await forwardToTurbopuffer({
      name,
      pathSuffix: '/query',
      method: 'POST',
      body,
      apiKeyId,
      namespaceId: nsRecord.id,
      eventType: EventType.TURBOPUFFER_NAMESPACE_QUERY,
      reply
    });
  });

  // Exists => GET /turbopuffer/namespaces/:name
  fastify.get('/turbopuffer/namespaces/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const apiKeyId = req.apiKey!.id;
    const nsRecord = await findNamespaceOr404(name, apiKeyId, reply);
    if (!nsRecord) return;

    await forwardToTurbopuffer({
      name,
      method: 'GET',
      apiKeyId,
      namespaceId: nsRecord.id,
      eventType: EventType.TURBOPUFFER_NAMESPACE_EXISTS,
      reply
    });
  });

  // Clear => DELETE /turbopuffer/namespaces/:name
  fastify.delete('/turbopuffer/namespaces/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const apiKeyId = req.apiKey!.id;
    const nsRecord = await findNamespaceOr404(name, apiKeyId, reply);
    if (!nsRecord) return;

    await forwardToTurbopuffer({
      name,
      method: 'DELETE',
      apiKeyId,
      namespaceId: nsRecord.id,
      eventType: EventType.TURBOPUFFER_NAMESPACE_CLEAR,
      reply
    });

    // After forwarding the delete to the provider, remove the local Namespace record
    try {
      await prisma.namespace.delete({ where: { id: nsRecord.id } });
      fastify.log.info({ namespace: name, apiKeyId }, 'Deleted local namespace record');
    } catch (err) {
      fastify.log.warn({ err, namespace: name, apiKeyId }, 'Failed to delete local namespace record');
    }
  });

  // Hybrid
  fastify.post('/turbopuffer/hybrid', {
    schema: {
      body: {
        type: 'object',
        properties: {
          namespace: { type: 'string' },
          embedding: { type: 'array', items: { type: 'number' } },
          query: { type: 'string' },
          limit: { type: 'number' }
        },
        required: ['namespace', 'embedding', 'query']
      }
    }
  }, async (req, reply) => {
    const body = req.body as any;
    const apiKeyId = req.apiKey!.id;

    const nsRecord = await findNamespaceOr404(body.namespace, apiKeyId, reply);
    if (!nsRecord) return;

    const turboBody = {
      queries: [
        { rank_by: ['vector', 'ANN', body.embedding], top_k: Math.min((body.limit || 10) * 2, 50), include_attributes: true },
        { rank_by: ['content', 'BM25', body.query],   top_k: Math.min((body.limit || 10) * 2, 50), include_attributes: true }
      ]
    };

    await forwardToTurbopuffer({
      name: nsRecord.name,
      pathSuffix: '/query',
      method: 'POST',
      body: turboBody,
      apiKeyId,
      namespaceId: nsRecord.id,
      eventType: EventType.TURBOPUFFER_HYBRID,
      reply
    });
  });

  // Get chunk IDs for file
  fastify.post('/turbopuffer/chunks/ids', {
    schema: { body: { type: 'object', properties: { namespace: { type: 'string' }, filePath: { type: 'string' } }, required: ['namespace', 'filePath'] } }
  }, async (req, reply) => {
    const body = req.body as any;
    const apiKeyId = req.apiKey!.id;
    const nsRecord = await findNamespaceOr404(body.namespace, apiKeyId, reply);
    if (!nsRecord) return;

    const turboBody = { filters: [['filePath', 'Eq', body.filePath]], top_k: 1000, include_attributes: false };
    await forwardToTurbopuffer({
      name: nsRecord.name,
      pathSuffix: '/query',
      method: 'POST',
      body: turboBody,
      apiKeyId,
      namespaceId: nsRecord.id,
      eventType: EventType.TURBOPUFFER_CHUNKS_IDS,
      reply
    });
  });

  // Delete chunks by IDs
  fastify.post('/turbopuffer/chunks/delete', {
    schema: { body: { type: 'object', properties: { namespace: { type: 'string' }, chunkIds: { type: 'array', items: { type: 'string' } } }, required: ['namespace', 'chunkIds'] } }
  }, async (req, reply) => {
    const body = req.body as any;
    const apiKeyId = req.apiKey!.id;
    const nsRecord = await findNamespaceOr404(body.namespace, apiKeyId, reply);
    if (!nsRecord) return;

    const turboBody = { deletes: body.chunkIds };
    await forwardToTurbopuffer({
      name: nsRecord.name,
      method: 'POST',
      body: turboBody,
      apiKeyId,
      namespaceId: nsRecord.id,
      eventType: EventType.TURBOPUFFER_CHUNKS_DELETE,
      reply
    });
  });
};

export default route;
