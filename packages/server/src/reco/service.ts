import {
  TmdbClient,
  TraktClient,
  createLogger,
  generateCandidates,
  normalizeHistory,
  type AppConfig,
  type Candidate,
  type CandidateDeps,
  type ProviderHistory,
  type WatchedItem,
} from '@watchmuse/core';
import type { ConnectionService } from '../connections/service.js';
import type { ConnectionStore } from '../connections/store.js';

const log = createLogger('reco-service');

export class TmdbNotConfigured extends Error {
  constructor() {
    super('TMDB_API_KEY is not configured');
    this.name = 'TmdbNotConfigured';
  }
}

/**
 * Per-user recommendation pipeline: pull history from every connected provider,
 * normalize it to TMDB space, and generate scored candidates. This is the bridge
 * between the connection layer and the core reco engine; catalogs build on it.
 */
export class RecommendationService {
  constructor(
    private readonly connections: ConnectionService,
    private readonly store: ConnectionStore,
    private readonly config: AppConfig,
  ) {}

  get tmdbConfigured(): boolean {
    return Boolean(this.config.TMDB_API_KEY);
  }

  private tmdb(): TmdbClient {
    if (!this.config.TMDB_API_KEY) throw new TmdbNotConfigured();
    return TmdbClient.shared({ apiKey: this.config.TMDB_API_KEY });
  }

  /** Normalized, deduped watch history across all of a user's connected services. */
  async watchedFor(userId: string): Promise<WatchedItem[]> {
    const conns = await this.store.list(userId);
    const histories: ProviderHistory[] = [];
    for (const conn of conns) {
      const client = await this.connections.clientFor(userId, conn.provider);
      if (!client) continue;
      try {
        const events = await client.pullHistory();
        // Ratings live behind their own endpoint, and only some services have
        // one. A failure there must not cost us the history we just pulled, so
        // it degrades to no ratings rather than skipping the provider.
        let ratings;
        if ('pullRatings' in client && typeof client.pullRatings === 'function') {
          try {
            ratings = await client.pullRatings();
          } catch (err) {
            log.warn({ userId, provider: conn.provider, err }, 'Ratings pull failed; using history alone');
          }
        }
        histories.push({ source: conn.provider, events, ...(ratings && { ratings }) });
      } catch (err) {
        log.warn(
          { userId, provider: conn.provider, err },
          'History pull failed; skipping provider',
        );
      }
    }
    return normalizeHistory(histories);
  }

  /** Scored recommendation candidates for a user, from their watch history. */
  async candidatesFor(userId: string): Promise<Candidate[]> {
    return (await this.buildFor(userId)).candidates;
  }

  /**
   * Candidates plus the history they came from.
   *
   * The history-backed rows need the same watch list, and pulling it twice
   * would double every provider's traffic for one rebuild.
   */
  async buildFor(userId: string): Promise<{ watched: WatchedItem[]; candidates: Candidate[] }> {
    const tmdb = this.tmdb(); // throws early if unconfigured
    const watched = await this.watchedFor(userId);
    if (watched.length === 0) return { watched, candidates: [] };

    const trakt = await this.connections.clientFor(userId, 'trakt');
    const deps: CandidateDeps = {
      tmdb,
      traktRecommendations:
        trakt instanceof TraktClient ? () => trakt.getRecommendations() : undefined,
    };
    return { watched, candidates: await generateCandidates(watched, deps) };
  }
}
