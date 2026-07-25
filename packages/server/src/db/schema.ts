import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Phase-1 auth schema. IDs are application-generated UUID strings so the schema
 * stays identical across PGlite (dev) and Postgres (prod). Secrets that live in
 * these tables (verification tokens, session tokens) are stored hashed — the raw
 * value only ever exists in the user's email link or cookie.
 */

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    username: text('username'),
    passwordHash: text('password_hash').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    isAdmin: boolean('is_admin').notNull().default(false),
    disabled: boolean('disabled').notNull().default(false),
    /**
     * Whether dismissing a title should also hide it from Trakt's own
     * recommendations. Off by default: writing to an account the user owns
     * elsewhere should never happen by surprise.
     */
    traktHideWriteThrough: boolean('trakt_hide_write_through').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('users_email_uniq').on(t.email),
    uniqueIndex('users_username_uniq').on(t.username),
  ],
);

export const emailVerificationTokens = pgTable(
  'email_verification_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('evt_token_hash_uniq').on(t.tokenHash), index('evt_user_idx').on(t.userId)],
);

export const passwordResetTokens = pgTable(
  'password_reset_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('prt_token_hash_uniq').on(t.tokenHash), index('prt_user_idx').on(t.userId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(), // sha256(cookie token)
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    ip: text('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('sessions_user_idx').on(t.userId)],
);

export const connections = pgTable(
  'connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'trakt' | 'simkl' | 'pmdb' | 'mdblist'
    /** Display name for the linked account. */
    label: text('label'),
    /** AES-256-GCM encrypted JSON credential blob (tokens or api key). */
    credentials: text('credentials').notNull(),
    status: text('status').notNull().default('active'), // active | reauth | error
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('connections_user_provider_uniq').on(t.userId, t.provider),
    index('connections_user_idx').on(t.userId),
  ],
);

/**
 * In-flight OAuth `state` values (CSRF defence for the redirect flow). Kept in
 * the database rather than in process memory so a restart or a second replica
 * mid-round-trip doesn't reject the user's callback. Stored hashed, like
 * sessions: the raw value exists only in the redirect URL.
 */
export const oauthStates = pgTable(
  'oauth_states',
  {
    id: text('id').primaryKey(), // sha256(state)
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(), // 'trakt' | 'simkl'
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('oauth_states_expires_idx').on(t.expiresAt)],
);

/**
 * Which country's streaming availability to answer with. `region` is a choice
 * the user made and always wins; `detectedRegion` is what the last request
 * looked like it came from, kept separately so a deliberate choice is never
 * silently overwritten by travelling or a VPN.
 */
export const watchRegions = pgTable('watch_regions', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  region: text('region'),
  detectedRegion: text('detected_region'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const catalogs = pgTable(
  'catalogs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    type: text('type').notNull().default('filter'), // filter | nl
    mediaType: text('media_type').notNull().default('both'), // movie | series | both
    /** JSON: FilterConfig for `filter`, or { prompt } for `nl`. */
    config: text('config').notNull().default('{}'),
    /** JSON array of provider ids feeding this catalog. */
    sources: text('sources').notNull().default('[]'),
    enabled: boolean('enabled').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('catalogs_user_idx').on(t.userId)],
);

/** Cached per-user candidate pool — the expensive part, shared by all catalogs. */
export const candidatePools = pgTable('candidate_pools', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** JSON Candidate[]. */
  payload: text('payload').notNull(),
  /** Hash of the source-set history the pool was built from. */
  historyHash: text('history_hash').notNull(),
  builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Opaque Stremio install ids — the manifest URL carries this, never tokens. */
export const installs = pgTable(
  'installs',
  {
    id: text('id').primaryKey(), // opaque token in the manifest URL
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [index('installs_user_idx').on(t.userId)],
);

/** Per-user BYO-key LLM config (AES-256-GCM encrypted baseUrl/model/apiKey). */
export const llmConfigs = pgTable('llm_configs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Encrypted JSON { baseUrl, model, apiKey }. */
  config: text('config').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Per-user custom artwork source (AES-256-GCM encrypted URL template). */
export const artworkConfigs = pgTable('artwork_configs', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Encrypted JSON { template } — the template may embed a provider key. */
  config: text('config').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Rows derived from watch history rather than from recommendation candidates.
 *
 * Kept apart from the candidate pool because they are the one place a watched
 * title is the point rather than something to exclude, and because building
 * them costs extra TMDB reads that only run when a user actually has such a
 * catalog. Rebuilt with the pool, since that is when the history is in hand.
 */
export const historyRows = pgTable('history_rows', {
  userId: text('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** JSON { rewatch: Candidate[]; newSeason: Candidate[] }. */
  payload: text('payload').notNull(),
  builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Cached results for natural-language catalogs (the LLM call is never inline). */
export const nlCatalogCache = pgTable('nl_catalog_cache', {
  catalogId: text('catalog_id')
    .primaryKey()
    .references(() => catalogs.id, { onDelete: 'cascade' }),
  /** JSON Candidate[] (the model's selection/order). */
  payload: text('payload').notNull(),
  /** Pool hash this was built against, for staleness detection. */
  poolHash: text('pool_hash').notNull(),
  builtAt: timestamp('built_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
});

/** Per-catalog "not interested" items — hidden from a catalog, backfilled by the next candidate. */
export const catalogExclusions = pgTable(
  'catalog_exclusions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    catalogId: text('catalog_id')
      .notNull()
      .references(() => catalogs.id, { onDelete: 'cascade' }),
    tmdbId: integer('tmdb_id').notNull(),
    /** 'movie' | 'series'. */
    mediaType: text('media_type').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('catalog_exclusions_catalog_idx').on(t.catalogId),
    uniqueIndex('catalog_exclusions_unique').on(t.catalogId, t.mediaType, t.tmdbId),
  ],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type Connection = typeof connections.$inferSelect;
export type Catalog = typeof catalogs.$inferSelect;
export type CandidatePool = typeof candidatePools.$inferSelect;
export type Install = typeof installs.$inferSelect;
export type LlmConfigRow = typeof llmConfigs.$inferSelect;
export type ArtworkConfigRow = typeof artworkConfigs.$inferSelect;
export type CatalogExclusion = typeof catalogExclusions.$inferSelect;
