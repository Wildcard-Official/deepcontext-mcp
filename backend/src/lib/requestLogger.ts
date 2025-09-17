import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

function maskHeaders(headers: Record<string, any>): Record<string, any> {
  const masked: Record<string, any> = { ...headers };
  const secrets = ['authorization', 'x-api-key', 'x-internal-secret'];
  for (const key of secrets) {
    if (masked[key]) masked[key] = '***';
  }
  return masked;
}

function trimBody(body: unknown, maxLen = 2000): unknown {
  try {
    const json = JSON.stringify(body);
    if (json.length > maxLen) return JSON.parse(json.slice(0, maxLen) + '...');
    return body;
  } catch {
    return undefined;
  }
}

export function registerRequestLogging(app: FastifyInstance) {
  app.addHook('onRequest', async (req: FastifyRequest) => {
    // @ts-ignore attach start time
    (req as any)._startTime = process.hrtime.bigint();
    app.log.info({
      phase: 'onRequest',
      method: req.method,
      url: req.url,
      ip: req.ip,
      headers: maskHeaders(req.headers as any),
      params: req.params,
      query: req.query
    }, 'Incoming request');
  });

  app.addHook('preHandler', async (req: FastifyRequest) => {
    const bodyPreview = trimBody((req as any).body);
    if (bodyPreview) {
      app.log.debug({ phase: 'preHandler', body: bodyPreview }, 'Request body');
    }
  });

  app.addHook('onResponse', async (req: FastifyRequest, reply: FastifyReply) => {
    const start = (req as any)._startTime as bigint | undefined;
    const durationMs = start ? Number((process.hrtime.bigint() - start) / BigInt(1_000_000)) : undefined;
    app.log.info({
      phase: 'onResponse',
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      durationMs
    }, 'Request completed');
  });

  app.addHook('onError', async (req: FastifyRequest, reply: FastifyReply, error: Error) => {
    app.log.error({
      phase: 'onError',
      method: req.method,
      url: req.url,
      statusCode: reply.statusCode,
      err: { message: error.message, stack: error.stack }
    }, 'Request error');
  });
}
