import { createLogger } from '../logger.js';
import type { TmdbClient } from '../providers/tmdb.js';
import { scoreCandidates } from './candidates.js';
import { selectSeeds } from './history.js';
import type { Candidate, MediaType, RawCandidate, WatchedItem } from './types.js';

const log = createLogger('reco');

/** A recommendation with no per-seed provenance (account-level engines). */
export interface FlatRec {
  tmdbId: number;
  type: MediaType;
  title?: string;
  year?: number;
}

export interface CandidateDeps {
  /** TMDB is the per-seed workhorse (similar + recommendations). */
  tmdb: Pick<TmdbClient, 'similar' | 'recommendations'>;
  /** Optional account-level recommenders (Trakt/Simkl); each is a lazy fetch. */
  traktRecommendations?: () => Promise<FlatRec[]>;
  simklRecommendations?: () => Promise<FlatRec[]>;
  /** How many pages of each TMDB endpoint to pull per seed. */
  perSeedPages?: number;
  /** Cap on seeds fanned out (protects the API and keeps latency bounded). */
  seedLimit?: number;
}

async function tmdbForSeed(
  tmdb: CandidateDeps['tmdb'],
  seed: WatchedItem,
  pages: number,
): Promise<RawCandidate[]> {
  const out: RawCandidate[] = [];
  for (let page = 1; page <= pages; page++) {
    try {
      const [sim, rec] = await Promise.all([
        tmdb.similar(seed.type, seed.tmdbId, page),
        tmdb.recommendations(seed.type, seed.tmdbId, page),
      ]);
      for (const t of sim)
        out.push({ ...t, source: 'tmdb-similar', fromSeed: seed.tmdbId });
      for (const t of rec)
        out.push({ ...t, source: 'tmdb-rec', fromSeed: seed.tmdbId });
    } catch (err) {
      // One bad seed (deleted title, 404) must not sink the whole batch.
      log.warn({ seed: seed.tmdbId, type: seed.type, page, err }, 'TMDB fetch failed for seed');
      break;
    }
  }
  return out;
}

/**
 * Generate scored recommendation candidates from a user's watch history.
 * TMDB drives per-seed candidates; Trakt/Simkl add account-level signal. All raw
 * hits are merged, deduped against watched, and scored. Deterministic given the
 * same inputs, so the output caches cleanly.
 */
export async function generateCandidates(
  watched: WatchedItem[],
  deps: CandidateDeps,
): Promise<Candidate[]> {
  const pages = deps.perSeedPages ?? 1;
  const seeds = selectSeeds(watched, deps.seedLimit ?? 40);

  const perSeed = await Promise.all(seeds.map((s) => tmdbForSeed(deps.tmdb, s, pages)));
  const raw: RawCandidate[] = perSeed.flat();

  const account: Array<{ fetch: NonNullable<CandidateDeps['traktRecommendations']>; source: RawCandidate['source'] }> = [];
  if (deps.traktRecommendations) account.push({ fetch: deps.traktRecommendations, source: 'trakt-rec' });
  if (deps.simklRecommendations) account.push({ fetch: deps.simklRecommendations, source: 'simkl-rec' });

  for (const a of account) {
    try {
      const recs = await a.fetch();
      for (const r of recs) raw.push({ ...r, source: a.source });
    } catch (err) {
      log.warn({ source: a.source, err }, 'Account recommendations failed');
    }
  }

  const scored = scoreCandidates(raw, watched);
  log.info({ seeds: seeds.length, raw: raw.length, candidates: scored.length }, 'Candidates generated');
  return scored;
}
