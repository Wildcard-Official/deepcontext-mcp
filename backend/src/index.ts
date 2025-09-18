import Fastify from 'fastify';
import cors from '@fastify/cors';
import env from '@fastify/env';
import { authPlugin } from './plugins/auth.js';
import apiKeyRoutes from './routes/apiKeys.routes.js';
import vectordbRoutes from './routes/vectordb.routes.js';
import embeddingRoutes from './routes/embeddings.routes.js';
import { registerRequestLogging } from './lib/requestLogger.js';

const server = Fastify({ logger: true, bodyLimit: 50 * 1024 * 1024 });

await server.register(env, {
  dotenv: true,
  schema: {
    type: 'object',
    required: ['DATABASE_URL', 'SHA256_SECRET', 'JINA_API_KEY', 'TURBOPUFFER_API_KEY'],
    properties: {
      DATABASE_URL: { type: 'string' },
      JINA_API_KEY: { type: 'string' },
      TURBOPUFFER_API_KEY: { type: 'string' },
      WILDCARD_API_KEY: { type: 'string' },
      SHA256_SECRET: { type: 'string' }
    }
  }
});

// Global request logging hooks
registerRequestLogging(server);

await server.register(cors);
await server.register(authPlugin);
await server.register(apiKeyRoutes, { prefix: '/apikeys' });
await server.register(vectordbRoutes, { prefix: '/vectordb' });
await server.register(embeddingRoutes, { prefix: '/embeddings' });

const start = async () => {
  try {
    await server.listen({ port: 4000, host: '0.0.0.0' });
    console.log('Server listening on 4000');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
