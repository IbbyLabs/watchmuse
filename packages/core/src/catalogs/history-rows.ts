import type { WatchedItem } from '../recommendations/types.js';

/**
 * Two catalogs built from what someone already watched, rather than from
 * recommendation candidates.
 *
 * Every other row excludes watched titles by design. These two are the
 * exception: their whole point is to bring something back. Both are requested
 * constantly across recommendation tools and built nowhere.
 */

const MS_PER_DAY = 86_400_000;

/** How long since the last watch before a title is worth offering again. */
export const REWATCH_AFTER_DAYS = 730;

/** Score at or above which a watch counts as loved rather than merely seen. */
const LOVED = 8;

/** Specials live in season 0 and are not a season anyone is waiting for. */
const FIRST_REAL_SEASON = 1;

function ageDays(watchedAt: string | null | undefined, now: Date): number | null {
  if (!watchedAt) return null;
  const t = Date.parse(watchedAt);
  if (!Number.isFinite(t)) return null;
  return (now.getTime() - t) / MS_PER_DAY;
}

/**
 * Titles worth watching again: watched long enough ago to feel fresh.
 *
 * Ordered by how much the user liked it, so a loved film leads and a merely
 * watched one fills in behind. Unrated watches are kept rather than dropped —
 * they are still the user's own history, not padding — but they never outrank
 * something known to be loved.
 *
 * A watch with no date cannot qualify: without one there is no way to tell a
 * film seen last week from one seen a decade ago, and offering back something
 * watched days ago is the failure mode this row has to avoid.
 */
export function selectRewatch(
  watched: readonly WatchedItem[],
  now: Date = new Date(),
  afterDays: number = REWATCH_AFTER_DAYS,
): WatchedItem[] {
  return watched
    .map((w) => ({ w, age: ageDays(w.watchedAt, now) }))
    .filter((e): e is { w: WatchedItem; age: number } => e.age !== null && e.age >= afterDays)
    .sort(
      (a, b) =>
        (b.w.rating ?? 0) - (a.w.rating ?? 0) ||
        // Same regard: offer the one they have gone longest without.
        b.age - a.age ||
        a.w.tmdbId - b.w.tmdbId,
    )
    .map((e) => e.w);
}

/** What TMDB knows about a series' seasons, for the new-season check. */
export interface SeasonInfo {
  /** TMDB `status`, e.g. "Returning Series" or "Ended". */
  status?: string;
  seasons: Array<{ seasonNumber: number; airDate?: string | null }>;
}

export interface NewSeasonHit {
  item: WatchedItem;
  /** The season to point at, when we can name one. */
  seasonNumber?: number;
  /**
   * True when this is a real unwatched season, false when it is the weaker
   * "still running and you have watched it" fallback for a provider that
   * reports no episode detail.
   */
  certain: boolean;
}

const hasAired = (airDate: string | null | undefined, now: Date): boolean => {
  if (!airDate) return false;
  const t = Date.parse(airDate);
  return Number.isFinite(t) && t <= now.getTime();
};

/**
 * Series with something new to watch.
 *
 * With per-season history the answer is exact: a season that has aired and is
 * not in `seasonsWatched` is unwatched. Simkl and MDBList report no episode
 * detail at all, so for those the best available answer is a series that is
 * still running — flagged `certain: false` so a caller can order the sure
 * things first rather than presenting a guess as fact.
 *
 * Specials are ignored. They sit in season 0 and are not what anyone means by
 * a new season.
 */
export function selectNewSeason(
  watched: readonly WatchedItem[],
  info: ReadonlyMap<number, SeasonInfo>,
  now: Date = new Date(),
): NewSeasonHit[] {
  const out: NewSeasonHit[] = [];

  for (const item of watched) {
    if (item.type !== 'series') continue;
    const meta = info.get(item.tmdbId);
    if (!meta) continue;

    const aired = meta.seasons
      .filter((s) => s.seasonNumber >= FIRST_REAL_SEASON && hasAired(s.airDate, now))
      .map((s) => s.seasonNumber)
      .sort((a, b) => a - b);
    if (aired.length === 0) continue;

    if (item.seasonsWatched?.length) {
      const seen = new Set(item.seasonsWatched);
      const missing = aired.filter((n) => !seen.has(n));
      // The newest unwatched season is the one worth pointing at; earlier gaps
      // are usually a partial rewatch rather than something they are waiting on.
      if (missing.length > 0) {
        out.push({ item, seasonNumber: missing.at(-1)!, certain: true });
      }
      continue;
    }

    // No episode detail from this provider. A returning series they have
    // watched is the most that can honestly be said.
    if (meta.status === 'Returning Series') out.push({ item, certain: false });
  }

  return out.sort(
    (a, b) =>
      Number(b.certain) - Number(a.certain) ||
      (b.item.rating ?? 0) - (a.item.rating ?? 0) ||
      a.item.tmdbId - b.item.tmdbId,
  );
}
