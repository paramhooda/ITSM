import { z } from 'zod';

const bool = z.preprocess((v) => (typeof v === 'string' ? ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) : v), z.boolean());

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  APP_URL: z.string().default('http://localhost:8080'),
  /** Chromium binary for PDF output; the container's Playwright build is found without it. */
  PDF_CHROMIUM_PATH: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  DATABASE_URL: z.string(),
  DATABASE_ADMIN_URL: z.string().optional(),
  APP_DB_USER: z.string().default('itsm_app'),
  APP_DB_PASSWORD: z.string().optional(),
  DB_POOL_MAX: z.coerce.number().default(20),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  JWT_SECRET: z.string().min(16),
  ENCRYPTION_KEY: z.string().min(16),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(14),
  COOKIE_SECURE: bool.default(false),
  ADMIN_EMAIL: z.string().default('admin@msp.local'),
  ADMIN_PASSWORD: z.string().default('Admin@12345'),
  ADMIN_NAME: z.string().default('Platform Administrator'),
  SEED_DEMO_DATA: bool.default(false),
  STORAGE_DRIVER: z.enum(['local']).default('local'),
  STORAGE_LOCAL_PATH: z.string().default('./storage'),
  MAX_UPLOAD_MB: z.coerce.number().default(50),
  /** Overrides Meta's Graph API host (tests, proxies). */
  WHATSAPP_API_BASE: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(25),
  SMTP_SECURE: bool.default(false),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  SMTP_FROM: z.string().default('MSP Service Desk <servicedesk@msp.local>'),
  AI_PROVIDER: z.enum(['anthropic', 'openai_compatible', 'none']).default('none'),
  ANTHROPIC_API_KEY: z.string().optional(),
  AI_MODEL: z.string().default('claude-opus-5-5'),
  OPENAI_COMPATIBLE_BASE_URL: z.string().optional(),
  OPENAI_COMPATIBLE_API_KEY: z.string().optional(),
  /** Common aliases so a plain OpenAI setup works with the usual variable names. */
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().optional(),
  WEB_DIST_PATH: z.string().optional(),
  RATE_LIMIT_MAX: z.coerce.number().default(1500),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === 'production') {
    if (cfg.JWT_SECRET.startsWith('dev-only') || cfg.ENCRYPTION_KEY.startsWith('dev-only')) {
      console.warn('[config] WARNING: JWT_SECRET / ENCRYPTION_KEY use insecure development defaults. Set strong random values in production.');
    }
  }
  return cfg;
}

export const config = load();
export const isProd = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
