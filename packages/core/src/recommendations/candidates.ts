import type { ProviderId } from '../providers/types.js';
import { buildEraProfile, eraAffinity } from './era.js';
import { credibleRating } from './rating.js';
import {
  itemKey,
  type Candidate,
  type CandidateSource,
  type MediaType,
  type RawCandidate,
  type WatchedItem,
} from './types.js';

/**
 * Scoring weights. Frequency (how many of the user's seeds surfaced a title) is
 * the dominant signal — it's collaborative evidence. Source diversity rewards a
 * title that several independent engines agree on. TMDB vote/popularity are
 * gentle tiebreakers so obscure-but-frequent still beats popular-but-incidental.
 */
const W_SEED = 10; // per seed that recommended it, scaled by how recent the seed is
const W_SOURCE = 4; // per distinct source family that surfaced it
const W_VOTE = 0.5; // × credibility-weighted TMDB rating (0–10)
const W_POP = 1; // × log10(popularity)
const W_ERA = 3; // × how much of the user's watching sits around this year (0–1)

/**
 * `/similar` and `/recommendations` are two endpoints on one engine, so a title
 * returned by both is one opinion, not two. Scoring diversity over families
 * keeps the per-endpoint tags for provenance while only paying out when
 * genuinely independent services agree.
 */
const SOURCE_FAMILY: Record<CandidateSource, string> = {
  'tmdb-similar': 'tmdb',
  'tmdb-rec': 'tmdb',
  'trakt-rec': 'trakt',
  'simkl-rec': 'simkl',
};

/**
 * Account-level recommenders come from one connected service directly, with no
 * seed in between. Per-seed sources are attributed through their seed instead.
 */
const SOURCE_PROVIDER: Partial<Record<CandidateSource, ProviderId>> = {
  'trakt-rec': 'trakt',
  'simkl-rec': 'simkl',
};

/**
 * Taste ages. A film watched six years ago is weaker evidence of what someone
 * wants tonight than one watched last month, and weighting both equally is how a
 * long history drags its recommendations toward whatever the user used to like.
 *
 * Age is measured against the newest watch in the history rather than the wall
 * clock, which keeps scoring a pure function of its input (and so cacheable),
 * and means a user who stops watching for a year doesn't have their whole
 * profile decay out from under them.
 */
const SEED_HALF_LIFE_DAYS = 730;
const SEED_MIN_WEIGHT = 0.25;
const MS_PER_DAY = 86_400_000;

/** How many seeds a "why recommended" line names before it stops reading well. */
const REASON_SEED_LIMIT = 2;
/** User rating at or above which a watch counts as "loved" rather than "watched". */
const LOVED_RATING = 8;

function popularityScore(popularity?: number): number {
  if (!popularity || popularity <= 1) return 0;
  return Math.log10(popularity);
}

function parseDate(iso?: string | null): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Recency weight per seed tmdbId. Undated watches weigh full: plenty of sources
 * (Simkl's "completed" list among them) report no date at all, and penalising
 * those would gut the profile of anyone whose history came from one. Only known
 * ages are discounted.
 */
function seedProviders(watched: Iterable<WatchedItem>): Map<number, ProviderId[]> {
  const out = new Map<number, ProviderId[]>();
  for (const w of watched) {
    const existing = out.get(w.tmdbId);
    if (!existing) {
      out.set(w.tmdbId, [...w.sources]);
      continue;
    }
    for (const s of w.sources) if (!existing.includes(s)) existing.push(s);
  }
  return out;
}

/** Title and best-known user rating per watched tmdbId, for the reason line. */
function seedDetails(
  watched: Iterable<WatchedItem>,
): Map<number, { title?: string; rating?: number }> {
  const out = new Map<number, { title?: string; rating?: number }>();
  for (const w of watched) {
    const existing = out.get(w.tmdbId);
    if (!existing) {
      out.set(w.tmdbId, { title: w.title, rating: w.rating });
      continue;
    }
    existing.title ??= w.title;
    if (w.rating !== undefined && (existing.rating === undefined || w.rating > existing.rating)) {
      existing.rating = w.rating;
    }
  }
  return out;
}

function seedWeights(watched: Iterable<WatchedItem>): Map<number, number> {
  const dates = new Map<number, number>();
  let newest: number | undefined;
  for (const w of watched) {
    const t = parseDate(w.watchedAt);
    if (t === undefined) continue;
    const prev = dates.get(w.tmdbId);
    if (prev === undefined || t > prev) dates.set(w.tmdbId, t);
    if (newest === undefined || t > newest) newest = t;
  }

  const weights = new Map<number, number>();
  if (newest === undefined) return weights;
  for (const [tmdbId, t] of dates) {
    const ageDays = Math.max(0, (newest - t) / MS_PER_DAY);
    const w = Math.pow(0.5, ageDays / SEED_HALF_LIFE_DAYS);
    weights.set(tmdbId, Math.max(w, SEED_MIN_WEIGHT));
  }
  return weights;
}

/**
 * Merge raw candidates into scored, deduped recommendations, excluding anything
 * the user has already watched. Pure and deterministic: same input → same order,
 * so results cache cleanly. Ties break by tmdbId for stability.
 */
export function scoreCandidates(raw: RawCandidate[], watched: Iterable<WatchedItem>): Candidate[] {
  const history = [...watched];
  const seen = new Set<string>();
  for (const w of history) seen.add(itemKey(w.type, w.tmdbId));
  const weights = seedWeights(history);
  const providers = seedProviders(history);
  const details = seedDetails(history);
  const era = buildEraProfile(history);

  const merged = new Map<
    string,
    {
      tmdbId: number;
      type: MediaType;
      title?: string;
      year?: number;
      overview?: string;
      seeds: Set<number>;
      sources: Set<CandidateSource>;
      popularity?: number;
      voteAverage?: number;
      voteCount?: number;
      posterPath?: string | null;
      genreIds?: number[];
    }
  >();

  for (const c of raw) {
    const key = itemKey(c.type, c.tmdbId);
    if (seen.has(key)) continue; // already watched — never recommend

    let entry = merged.get(key);
    if (!entry) {
      entry = { tmdbId: c.tmdbId, type: c.type, seeds: new Set(), sources: new Set() };
      merged.set(key, entry);
    }
    entry.title ??= c.title;
    entry.year ??= c.year;
    if (!entry.overview && c.overview) entry.overview = c.overview;
    if (c.fromSeed !== undefined) entry.seeds.add(c.fromSeed);
    entry.sources.add(c.source);
    if (c.popularity !== undefined)
      entry.popularity = Math.max(entry.popularity ?? 0, c.popularity);
    if (c.voteAverage !== undefined)
      entry.voteAverage = Math.max(entry.voteAverage ?? 0, c.voteAverage);
    if (c.voteCount !== undefined) entry.voteCount = Math.max(entry.voteCount ?? 0, c.voteCount);
    if (!entry.posterPath && c.posterPath) entry.posterPath = c.posterPath;
    if ((!entry.genreIds || entry.genreIds.length === 0) && c.genreIds?.length)
      entry.genreIds = c.genreIds;
  }

  const out: Candidate[] = [];
  for (const e of merged.values()) {
    let seedScore = 0;
    for (const seed of e.seeds) seedScore += weights.get(seed) ?? 1;
    const families = new Set<string>();
    const from = new Set<ProviderId>();
    for (const s of e.sources) {
      families.add(SOURCE_FAMILY[s]);
      const direct = SOURCE_PROVIDER[s];
      if (direct) from.add(direct);
    }
    for (const seed of e.seeds) for (const p of providers.get(seed) ?? []) from.add(p);

    const score =
      seedScore * W_SEED +
      families.size * W_SOURCE +
      credibleRating(e.voteAverage, e.voteCount) * W_VOTE +
      popularityScore(e.popularity) * W_POP +
      eraAffinity(era, e.year) * W_ERA;

    // Name the seeds that actually carried the recommendation, heaviest first,
    // so the reason cites the most relevant watch rather than the lowest id.
    const named = [...e.seeds]
      .sort((a, b) => (weights.get(b) ?? 1) - (weights.get(a) ?? 1) || a - b)
      .map((id) => ({ id, ...details.get(id) }))
      .filter((s): s is { id: number; title: string; rating?: number } => Boolean(s.title))
      .slice(0, REASON_SEED_LIMIT);

    out.push({
      tmdbId: e.tmdbId,
      type: e.type,
      title: e.title,
      year: e.year,
      overview: e.overview,
      score: Math.round(score * 1000) / 1000,
      fromSeeds: [...e.seeds].sort((a, b) => a - b),
      ...(named.length > 0 && {
        seedTitles: named.map((s) => s.title),
        fromLovedSeed: (named[0]!.rating ?? 0) >= LOVED_RATING,
      }),
      sources: [...e.sources].sort(),
      fromProviders: [...from].sort(),
      popularity: e.popularity,
      voteAverage: e.voteAverage,
      voteCount: e.voteCount,
      posterPath: e.posterPath,
      genreIds: e.genreIds,
    });
  }

  out.sort((a, b) => b.score - a.score || a.tmdbId - b.tmdbId);
  return out;
}
