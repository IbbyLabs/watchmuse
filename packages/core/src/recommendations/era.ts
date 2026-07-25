import type { WatchedItem } from './types.js';

/**
 * How well a candidate's release year matches the eras someone actually watches.
 *
 * Frequency scoring alone has no sense of period: TMDB's related-title endpoints
 * happily answer a modern seed with its 1970s influences, and those pile up
 * across seeds until a row reads like someone else's taste. Calibrating against
 * the user's own year distribution fixes that without hard-coding a preference
 * for new releases, so somebody who genuinely watches old films keeps getting
 * them.
 */

const BUCKET_YEARS = 5;
/** Neighbouring buckets count for less, so there is no cliff at a boundary. */
const NEIGHBOUR_WEIGHT = 0.5;
/** Used when a candidate has no year, so it is neither rewarded nor punished. */
const UNKNOWN_AFFINITY = 0.5;

export interface EraProfile {
  /** Bucket index to share of history, normalised so the busiest era is 1. */
  readonly density: ReadonlyMap<number, number>;
}

const bucketOf = (year: number): number => Math.floor(year / BUCKET_YEARS);

/** Build the era profile of a watch history. Empty when no years are known. */
export function buildEraProfile(watched: Iterable<WatchedItem>): EraProfile {
  const counts = new Map<number, number>();
  for (const w of watched) {
    if (w.year === undefined) continue;
    const b = bucketOf(w.year);
    counts.set(b, (counts.get(b) ?? 0) + 1);
  }
  if (counts.size === 0) return { density: new Map() };

  const smoothed = new Map<number, number>();
  for (const [bucket, count] of counts) {
    smoothed.set(bucket, (smoothed.get(bucket) ?? 0) + count);
    for (const side of [bucket - 1, bucket + 1]) {
      smoothed.set(side, (smoothed.get(side) ?? 0) + count * NEIGHBOUR_WEIGHT);
    }
  }

  let peak = 0;
  for (const v of smoothed.values()) peak = Math.max(peak, v);
  const density = new Map<number, number>();
  for (const [bucket, v] of smoothed) density.set(bucket, v / peak);
  return { density };
}

/**
 * 0 to 1: how much of the user's watching sits around this year. Returns 1 for
 * every candidate when the profile is empty, so a history with no years behaves
 * exactly as it did before.
 */
export function eraAffinity(profile: EraProfile, year?: number): number {
  if (profile.density.size === 0) return 1;
  if (year === undefined) return UNKNOWN_AFFINITY;
  return profile.density.get(bucketOf(year)) ?? 0;
}
