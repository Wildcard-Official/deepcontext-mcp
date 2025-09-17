import { FastifyReply } from 'fastify';
import { proxyRequest } from '../../services/providerProxy.js';
import { EventType } from '@prisma/client';

const JINA_BASE = 'https://api.jina.ai/v1';

export function jinaHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.JINA_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.JINA_API_KEY}`;
  }
  return headers;
}

export function withEmbeddingDefaults(body: any) {
  return {
    model: body.model ?? 'jina-embeddings-v3',
    input: body.input,
    dimensions: body.dimensions ?? 1024
  };
}

export function withRerankDefaults(body: any) {
  return {
    model: body.model ?? 'jina-reranker-v2-base-multilingual',
    query: body.query,
    documents: body.documents,
    top_n: body.top_n ?? (Array.isArray(body.documents) ? body.documents.length : undefined),
    return_documents: body.return_documents ?? false
  };
}

export async function forwardToJina(options: {
  path: '/embeddings' | '/rerank';
  method: 'POST';
  body: any;
  apiKeyId: number;
  eventType: EventType;
  reply: FastifyReply;
}): Promise<void> {
  const { path, method, body, apiKeyId, eventType, reply } = options;
  const url = `${JINA_BASE}${path}`;
  await proxyRequest({
    url,
    method,
    body,
    apiKeyId,
    headers: jinaHeaders(),
    eventType
  }, reply);
}
