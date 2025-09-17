import { FastifyReply } from 'fastify';
import prisma from '../../lib/prisma.js';
import { EventType, Namespace } from '@prisma/client';
import { proxyRequest } from '../../services/providerProxy.js';

const TURBO_BASE = 'https://gcp-us-central1.turbopuffer.com/v2';

export async function ensureNamespaceForUpsert(name: string, apiKeyId: number): Promise<Namespace> {
  let nsRecord = await prisma.namespace.findFirst({ where: { name, apiKeyId } });
  if (!nsRecord) {
    nsRecord = await prisma.namespace.create({ data: { name, apiKeyId } });
  }
  return nsRecord;
}

export async function findNamespaceOr404(name: string, apiKeyId: number, reply: FastifyReply): Promise<Namespace | null> {
  const nsRecord = await prisma.namespace.findFirst({ where: { name, apiKeyId } });
  if (!nsRecord) {
    await reply.status(404).send({ error: 'Namespace not found for API key' });
    return null;
  }
  return nsRecord;
}

export function turboHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (process.env.TURBOPUFFER_API_KEY) {
    headers['Authorization'] = `Bearer ${process.env.TURBOPUFFER_API_KEY}`;
  }
  return headers;
}

export async function forwardToTurbopuffer(options: {
  name: string;
  pathSuffix?: string; // e.g. '/query'
  method: 'GET' | 'POST' | 'DELETE';
  body?: any;
  apiKeyId: number;
  namespaceId: number;
  eventType: EventType;
  reply: FastifyReply;
}): Promise<void> {
  const { name, pathSuffix = '', method, body, apiKeyId, namespaceId, eventType, reply } = options;
  const url = `${TURBO_BASE}/namespaces/${name}${pathSuffix}`;
  await proxyRequest({
    url,
    method,
    body,
    apiKeyId,
    namespaceId,
    headers: turboHeaders(),
    eventType
  }, reply);
}
