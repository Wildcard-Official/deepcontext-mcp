import prisma from '../lib/prisma.js';
import { FastifyReply } from 'fastify';
import { EventType } from '@prisma/client';

interface ProxyOptions {
  url: string;
  method: 'POST' | 'GET' | 'DELETE';
  body?: any;
  apiKeyId: number;
  namespaceId?: number;
  headers?: Record<string, string>;
  eventType: EventType;
}

export async function proxyRequest(opts: ProxyOptions, reply: FastifyReply) {
  const start = Date.now();

  const response = await fetch(opts.url, {
    method: opts.method,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    },
    body: opts.method === 'POST' ? JSON.stringify(opts.body) : undefined
  });
  const duration = Date.now() - start;

  let data: any = null;
  try {
    data = await response.json();
  } catch {
    // Non-JSON response
    data = await response.text();
  }

  await prisma.event.create({
    data: {
      type: opts.eventType,
      statusCode: response.status,
      durationMs: duration,
      namespaceId: opts.namespaceId ?? null,
      metadata: {
        requestBodyBytes: opts.body ? JSON.stringify(opts.body).length : 0,
        responseBytes: typeof data === 'string' ? data.length : JSON.stringify(data).length,
        success: response.ok,
        ...(response.ok ? {} : { errorResponse: data }),
      },
      apiKeyId: opts.apiKeyId,
    },
  });

  return reply.status(response.status).send(data);
}
