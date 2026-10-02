import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, type ZodTypeProvider } from 'fastify-type-provider-zod';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config, isProd } from '@/config';
import { logger } from './logger';
import { AppError } from './errors';
import { authPlugin } from './auth-plugin';
import { registerModules } from '@/modules';
import { pool } from '@/db/client';

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
    requestIdHeader: 'x-request-id',
    genReqId: () => crypto.randomUUID(),
    disableRequestLogging: isProd,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(sensible);
  await app.register(helmet, {
    contentSecurityPolicy: isProd
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            fontSrc: ["'self'", 'data:'],
            imgSrc: ["'self'", 'data:', 'blob:'],
            connectSrc: ["'self'"],
            frameAncestors: ["'none'"],
            // Only force HTTPS upgrades when the platform is actually served over TLS;
            // on-premise deployments often run plain HTTP on an internal network.
            upgradeInsecureRequests: config.APP_URL.startsWith('https://') ? [] : null,
          },
        }
      : false,
    crossOriginEmbedderPolicy: false,
  });
  await app.register(cors, { origin: isProd ? false : true, credentials: true });
  await app.register(cookie, { secret: config.JWT_SECRET });
  await app.register(multipart, { limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 10 } });
  await app.register(swagger, {
    openapi: {
      info: { title: 'Progression Service Management API', version: '1.0.0', description: 'ITSM, Helpdesk, Asset Management & CMDB platform for Managed Services Providers.' },
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' }, apiKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' } } },
      security: [{ bearerAuth: [] }, { apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });
  await app.register(authPlugin);
  // Rate limit API traffic per authenticated principal (falls back to IP for anonymous
  // requests) so that many users behind one corporate NAT do not share a single bucket.
  await app.register(rateLimit, {
    max: config.RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    allowList: (req) => !req.url.startsWith('/api/'),
    keyGenerator: (req) => (req.principal ? `u:${req.principal.id}` : `ip:${req.ip}`),
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({ statusCode: err.statusCode, error: err.code, message: err.message, details: err.details });
    }
    if (err instanceof ZodError || (err as { validation?: unknown }).validation) {
      const issues = err instanceof ZodError ? err.issues : (err as { validation: unknown }).validation;
      return reply.status(400).send({ statusCode: 400, error: 'validation_error', message: 'Request validation failed', details: issues });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) req.log.error({ err, reqId: req.id }, 'unhandled error');
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') return reply.status(409).send({ statusCode: 409, error: 'conflict', message: 'A record with the same unique value already exists' });
    if (pgCode === '23503') return reply.status(409).send({ statusCode: 409, error: 'conflict', message: 'The record is referenced by other data or references a missing record' });
    return reply.status(status).send({
      statusCode: status,
      error: status >= 500 ? 'internal_error' : (err as { code?: string }).code ?? 'error',
      message: status >= 500 && isProd ? 'Internal server error' : (err as Error).message,
    });
  });

  app.get('/api/health', async () => {
    const started = Date.now();
    let db = 'ok';
    try {
      await pool.query('SELECT 1');
    } catch {
      db = 'error';
    }
    return { status: db === 'ok' ? 'ok' : 'degraded', db, latencyMs: Date.now() - started, version: '1.0.0', time: new Date().toISOString() };
  });

  await app.register(registerModules, { prefix: '/api' });

  // Serve the compiled web application (single-page app) in production.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = config.WEB_DIST_PATH ?? [path.resolve(here, '../../web/dist'), path.resolve(here, '../web/dist'), path.resolve(process.cwd(), '../web/dist')].find((p) => existsSync(p));
  if (webDist && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', wildcard: false, maxAge: '1h', immutable: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ statusCode: 404, error: 'not_found', message: 'Route not found' });
      return reply.sendFile('index.html', webDist, { maxAge: 0 });
    });
    logger.info({ webDist }, 'serving web application');
  } else {
    app.setNotFoundHandler((req, reply) => reply.status(404).send({ statusCode: 404, error: 'not_found', message: req.url.startsWith('/api/') ? 'Route not found' : 'Web application not built' }));
  }

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
