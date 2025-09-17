import { FastifyPluginAsync } from 'fastify';
import crypto from 'crypto';
import prisma from '../lib/prisma.js';
import { requireInternalSecret } from '../plugins/auth.js';

const route: FastifyPluginAsync = async (fastify) => {
  fastify.post('/', { preHandler: requireInternalSecret() }, async (req, reply) => {
    const rawKey = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHmac('sha256', process.env.SHA256_SECRET!)
      .update(rawKey)
      .digest('hex');

    await prisma.apiKey.create({ data: { hash } });

    return reply.send({ apiKey: rawKey });
  });
};

export default route;
