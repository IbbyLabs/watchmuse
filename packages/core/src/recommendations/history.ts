import type { ProviderId, RatingEvent, WatchEvent } from '../providers/types.js';
import { itemKey, type MediaType, type WatchedItem } from './types.js';

/** History pulled from one connected provider. */
export interface ProviderHistory {
  source: ProviderId;
  events: WatchEvent[];
  /**
   * Scores from the same provider, when it has a ratings API. Kept apart from
   * `events` because a service rates things it has no watch record for, and
   * because most history endpoints do not return the score alongside the watch.
   */
  ratings?: RatingEvent[];
}

function laterDate(a?: string | null, b?: string | null): string | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return a >= b ? a : b;
}

/**
 * Merge per-provider watch history into a deduped `WatchedItem[]` in TMDB space.
 * Movies keep their tmdb id; episodes roll up to their parent series' tmdb id
 * (the sync layer already stores the show's ids on an episode ref). Items with
 * no tmdb id are dropped — Watchmuse can't place them in a catalog without one.
 */
export function normalizeHistory(histories: ProviderHistory[]): WatchedItem[] {
  const byKey = new Map<string, WatchedItem>();

  for (const { source, events } of histories) {
    for (const ev of events) {
      const tmdbId = ev.ref.ids.tmdb;
      if (!tmdbId) continue;
      const type: MediaType = ev.ref.kind === 'movie' ? 'movie' : 'series';
      const key = itemKey(type, tmdbId);

      const season = ev.ref.kind === 'episode' ? ev.ref.season : undefined;
      const existing = byKey.get(key);
      if (existing) {
        if (!existing.sources.includes(source)) existing.sources.push(source);
        if (season !== undefined) {
          existing.seasonsWatched ??= [];
          if (!existing.seasonsWatched.includes(season)) existing.seasonsWatched.push(season);
        }
        existing.watchedAt = laterDate(existing.watchedAt, ev.watchedAt);
        existing.title ??= ev.ref.title;
        existing.year ??= ev.ref.year;
        // Keep the highest score when two services disagree. Scales differ in
        // practice, and the alternative is letting whichever provider happened
        // to sync last decide how much someone liked a film.
        if (ev.rating !== undefined && (existing.rating === undefined || ev.rating > existing.rating)) {
          existing.rating = ev.rating;
        }
      } else {
        byKey.set(key, {
          tmdbId,
          type,
          title: ev.ref.title,
          year: ev.ref.year,
          watchedAt: ev.watchedAt ?? null,
          sources: [source],
          ...(ev.rating !== undefined && { rating: ev.rating }),
          ...(season !== undefined && { seasonsWatched: [season] }),
        });
      }
    }
  }

  // Ratings arrive from a separate endpoint, so they are folded in after the
  // watches. A rating for something with no watch record is ignored: this
  // builds a picture of what someone watched, and a score on its own is not a
  // watch. Highest wins when two services disagree, as above.
  for (const { events: _events, ratings } of histories) {
    for (const r of ratings ?? []) {
      const tmdbId = r.ref.ids.tmdb;
      if (!tmdbId) continue;
      const type: MediaType = r.ref.kind === 'movie' ? 'movie' : 'series';
      const existing = byKey.get(itemKey(type, tmdbId));
      if (!existing) continue;
      if (existing.rating === undefined || r.rating > existing.rating) existing.rating = r.rating;
    }
  }

  // Sorted so a caller can compare against TMDB's season list directly, and so
  // the output stays stable for caching regardless of the order events arrived.
  for (const item of byKey.values()) item.seasonsWatched?.sort((a, b) => a - b);

  return [...byKey.values()];
}

/**
 * Deterministic age-neutral hash of a tmdb id. Used only to break ties between
 * watches with no rating and no date. Ordering by raw tmdbId there would seed the
 * lowest ids first, and low ids skew to the oldest, most-canonical titles — so a
 * library with no dates or ratings (e.g. Simkl's undated "completed") would seed
 * only its oldest shows and recommend nothing but old content. The hash spreads
 * those ties across the library instead, while staying stable for clean caching.
 */
function idHash(n: number): number {
  let x = n | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

/** Rank watches by taste strength: highest-rated first, then most recent. */
function byTasteStrength(a: WatchedItem, b: WatchedItem): number {
  const ra = a.rating ?? 0;
  const rb = b.rating ?? 0;
  if (ra !== rb) return rb - ra;
  const da = a.watchedAt ?? '';
  const db = b.watchedAt ?? '';
  if (da !== db) return da < db ? 1 : -1;
  const ha = idHash(a.tmdbId);
  const hb = idHash(b.tmdbId);
  if (ha !== hb) return ha - hb;
  return a.tmdbId - b.tmdbId;
}

/**
 * Pick the strongest "taste seeds" to drive candidate generation: highly-rated
 * first, then most-recently watched, capped so we don't fan out over a whole
 * library. The budget is split across media types by a round-robin draw, so a
 * movie-heavy history can't crowd series out of the seed set (or vice versa) —
 * each catalog type needs its own seeds or its row comes back empty. A type with
 * few watches simply contributes what it has; the rest of the budget goes to the
 * others. Deterministic (per-type sort plus sorted type order) for stable caching.
 */
export function selectSeeds(watched: WatchedItem[], limit = 40): WatchedItem[] {
  const byType = new Map<MediaType, WatchedItem[]>();
  for (const w of watched) {
    const list = byType.get(w.type);
    if (list) list.push(w);
    else byType.set(w.type, [w]);
  }
  for (const list of byType.values()) list.sort(byTasteStrength);

  const types = [...byType.keys()].sort();
  const cursors = new Map<MediaType, number>(types.map((t) => [t, 0]));
  const picked: WatchedItem[] = [];
  while (picked.length < limit) {
    let progressed = false;
    for (const type of types) {
      if (picked.length >= limit) break;
      const list = byType.get(type)!;
      const cursor = cursors.get(type)!;
      if (cursor < list.length) {
        picked.push(list[cursor]!);
        cursors.set(type, cursor + 1);
        progressed = true;
      }
    }
    if (!progressed) break; // every type exhausted before hitting the limit
  }
  return picked;
}
