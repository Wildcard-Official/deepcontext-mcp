import { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { DEFAULT_RATE_LIMITS } from '../lib/ratelimit.js';
import { requireInternalSecret } from '../plugins/auth.js';

const route: FastifyPluginAsync = async (fastify) => {
  fastify.post(
    '/',
    {
      preHandler: requireInternalSecret(),
      schema: {
        body: {
          type: 'object',
          properties: {
            email: { type: 'string', format: 'email' }
          },
          additionalProperties: false
        },
        response: {
          200: {
            type: 'object',
            properties: {
              apiKey: { type: 'string' }
            }
          }
        }
      }
    },
    async (req, reply) => {
      const { email } = (req.body as { email?: string }) || {};

      const rawKey = crypto.randomBytes(32).toString('hex');
      const hash = crypto.createHmac('sha256', process.env.SHA256_SECRET!)
        .update(rawKey)
        .digest('hex');

      const createdKey = await prisma.apiKey.create({ data: { hash } });

      // Initialize default rate limits for this API key
      const now = Date.now();
      const defaults = Object.entries(DEFAULT_RATE_LIMITS).map(([eventType, cfg]) => ({
        apiKeyId: createdKey.id,
        eventType: eventType as any,
        limit: cfg.limit,
        windowSeconds: cfg.windowSeconds,
        used: 0,
        windowResetAt: new Date(now + cfg.windowSeconds * 1000)
      }));
      if (defaults.length > 0) {
        await prisma.rateLimit.createMany({ data: defaults, skipDuplicates: true });
      }

      if (email) {
        try {
          await prisma.apiKeyEmail.create({
            data: {
              email,
              apiKeyId: createdKey.id
            }
          });
        } catch (err) {
          // Ignore unique violations to keep idempotency if retried
          fastify.log.warn({ err, email }, 'Failed to create ApiKeyEmail mapping');
        }
      }

      return reply.send({ apiKey: rawKey });
    }
  );
};

export default route;
