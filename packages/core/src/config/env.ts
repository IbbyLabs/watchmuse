import { z } from 'zod';
import { expandTrustedProxies } from '../net/cloudflare.js';
import { parseEncryptionKey } from '../crypto/secretBox.js';

/** Coerce common truthy/falsey env strings to boolean. */
const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(v.trim())));

const csv = (def: string[] = []) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined
        ? def
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  /** Public origin used to build OAuth redirect URLs and email links. */
  APP_URL: z.string().url().default('http://localhost:8080'),

  // Persistence. `postgres(ql)://…` uses a real Postgres server; anything else
  // (default) uses embedded PGlite stored under the given path, so local runs
  // need no external database.
  DATABASE_URL: z.string().default('pglite://./data/pg'),
  REDIS_URL: z.string().optional(),

  // Secrets
  APP_ENCRYPTION_KEY: z.string().refine((v) => {
    try {
      parseEncryptionKey(v);
      return true;
    } catch {
      return false;
    }
  }, 'APP_ENCRYPTION_KEY must decode to 32 bytes (openssl rand -base64 32)'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 chars'),

  // Proxy / real-IP
  TRUSTED_PROXIES: csv([]),
  TRUST_CLOUDFLARE_HEADER: boolish(true),

  // Registration / abuse
  REGISTRATION_ENABLED: boolish(true),
  /**
   * Require a confirmed email address before sign-in. On by default: an
   * instance strangers can register on must not hand out accounts for
   * addresses nobody proved they own. A single-user self-host with no real
   * mail relay can turn it off.
   */
  REQUIRE_EMAIL_VERIFICATION: boolish(true),
  SIGNUP_RATE_PER_HOUR: z.coerce.number().int().positive().default(10),
  MAX_CONCURRENT_SYNCS_GLOBAL: z.coerce.number().int().positive().default(4),
  MAX_CONCURRENT_SYNCS_PER_USER: z.coerce.number().int().positive().default(1),
  MIN_SCHEDULE_INTERVAL_MINUTES: z.coerce.number().int().min(5).default(15),

  // Background maintenance
  SCHEDULER_ENABLED: boolish(true),
  /** How often the sweep looks for work. Not how often a given pool rebuilds. */
  SCHEDULER_INTERVAL_MINUTES: z.coerce.number().int().min(1).default(30),
  /** How many users' pools may rebuild at once. */
  SCHEDULER_MAX_CONCURRENT_REBUILDS: z.coerce.number().int().positive().default(2),
  /** Cap per sweep, so one pass can't queue the whole user table. */
  SCHEDULER_MAX_REBUILDS_PER_SWEEP: z.coerce.number().int().positive().default(20),

  // SMTP
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_SECURE: boolish(false), // true => implicit TLS (465); false => STARTTLS (587)
  MAIL_FROM: z.string().default('Watchmuse <no-reply@localhost>'),

  // Providers (operator-registered apps)
  TRAKT_CLIENT_ID: z.string().optional(),
  TRAKT_CLIENT_SECRET: z.string().optional(),
  SIMKL_CLIENT_ID: z.string().optional(),
  SIMKL_CLIENT_SECRET: z.string().optional(),
  // TMDB v3 API key — metadata + candidate generation (similar/recommendations).
  TMDB_API_KEY: z.string().optional(),
  /**
   * Let users point the AI endpoint at loopback or a LAN address. Needed for a
   * self-hosted Ollama; turn it off on an instance strangers can sign up to.
   */
  AI_ALLOW_PRIVATE_BASE_URL: boolish(true),
  /**
   * Expose Prometheus metrics at /metrics. Off by default: the series carry
   * user counts, provider error rates and route traffic, which is not something
   * to start publishing on a public instance without being asked.
   */
  METRICS_ENABLED: boolish(false),
  /** When set, /metrics requires `Authorization: Bearer <token>`. */
  METRICS_TOKEN: z.string().optional(),

  APP_NAME: z.string().default('Watchmuse'),
  APP_VERSION: z.string().default('0.0.0-dev'),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface AppConfig extends RawEnv {
  /** TRUSTED_PROXIES with `cloudflare`/`loopback`/`private` keywords expanded. */
  trustedProxyCidrs: string[];
  isProduction: boolean;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new ConfigStartupError(`Invalid configuration:\n${issues}`);
  }
  const env = parsed.data;
  return {
    ...env,
    trustedProxyCidrs: expandTrustedProxies(env.TRUSTED_PROXIES),
    isProduction: env.NODE_ENV === 'production',
  };
}

/** Thrown for configuration problems that should abort startup without a stack trace. */
export class ConfigStartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigStartupError';
  }
}
