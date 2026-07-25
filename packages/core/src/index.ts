export { createLogger, type Logger } from './logger.js';
export { SecretBox, parseEncryptionKey, safeEqual } from './crypto/secretBox.js';
export {
  resolveClientIp,
  type ClientIpOptions,
  type ClientIpResult,
  type ResolveClientIpInput,
} from './net/clientIp.js';
export {
  expandTrustedProxies,
  CLOUDFLARE_IPV4,
  CLOUDFLARE_IPV6,
  LOOPBACK,
  PRIVATE_RANGES,
} from './net/cloudflare.js';
export { loadConfig, ConfigStartupError, type AppConfig, type RawEnv } from './config/env.js';
export { assertSafeUrl, UnsafeUrlError, type UrlGuardOptions } from './net/ssrf.js';

// Providers
export * from './providers/types.js';
export { HttpClient, HttpError } from './providers/http.js';
export {
  TraktClient,
  traktRenewAt,
  type TraktTokens,
  type TraktConfig,
  type DeviceCode,
} from './providers/trakt.js';
export { SimklClient, type SimklConfig, type SimklPin } from './providers/simkl.js';
export { PmdbClient } from './providers/pmdb.js';
export { MdblistClient } from './providers/mdblist.js';
export {
  TmdbClient,
  type TmdbTitle,
  type TmdbConfig,
  type WatchProvider,
  type WatchRegionOption,
} from './providers/tmdb.js';

// ID-based identity matching (reused for cross-provider / TMDB resolution)
export { idStrings, itemKey, hasIdentity, MatchIndex } from './matching/identity.js';

// Recommendation engine
export {
  itemKey as recItemKey,
  type MediaType,
  type WatchedItem,
  type Candidate,
  type RawCandidate,
  type CandidateSource,
} from './recommendations/types.js';
export { normalizeHistory, selectSeeds, type ProviderHistory } from './recommendations/history.js';
export { scoreCandidates } from './recommendations/candidates.js';
export { credibleRating } from './recommendations/rating.js';
export { buildEraProfile, eraAffinity, type EraProfile } from './recommendations/era.js';
export { diversify } from './recommendations/diversity.js';
export { generateCandidates, type CandidateDeps, type FlatRec } from './recommendations/engine.js';

// Catalogs (filter + Stremio serving)
export {
  type CatalogDef,
  type CatalogMediaType,
  type CatalogSort,
  type CatalogType,
  HISTORY_CATALOG_TYPES,
  type FilterConfig,
} from './catalogs/types.js';
export { applyCatalogFilter } from './catalogs/filter.js';
export {
  diagnoseCatalog,
  type CatalogDiagnosis,
  type ConstraintReport,
} from './catalogs/diagnose.js';
export { toStremioMetas, type StremioMeta } from './catalogs/stremio.js';
export { recommendationReason, describeWithReason } from './catalogs/reason.js';
export { dailySeed, elitistShuffle } from './catalogs/shuffle.js';
export {
  selectRewatch,
  selectNewSeason,
  REWATCH_AFTER_DAYS,
  type SeasonInfo,
  type NewSeasonHit,
} from './catalogs/history-rows.js';
export {
  encodeShare,
  decodeShare,
  InvalidShareCode,
  type SharedCatalog,
  type SharedConfig,
} from './catalogs/share.js';
export { setProviderObserver, providerObserver, type ProviderObserver } from './providers/observer.js';
export { LetterboxdClient, InvalidLetterboxdUsername } from './providers/letterboxd.js';
export {
  StremioClient,
  StremioLinkPending,
  StremioSessionInvalid,
  type ImdbResolver,
} from './providers/stremio.js';
export {
  buildTasteProfile,
  rankSearchResults,
  type SearchResult,
  type TasteProfile,
} from './search/taste.js';
export {
  renderPosterUrl,
  validateArtworkTemplate,
  type ArtworkConfig,
  type ArtworkTemplateError,
  type ArtworkTemplateErrorCode,
  type PosterKey,
} from './catalogs/artwork.js';

// AI layer (BYO-key, OpenAI-compatible)
export { LlmClient, type LlmConfig } from './ai/client.js';
export { rerank, selectForPrompt, candidateList, parseIdList, applyOrder } from './ai/rank.js';
