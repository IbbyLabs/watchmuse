import type { Candidate } from './types.js';

/**
 * Re-order a row so no single thread of the user's taste takes it over.
 *
 * Scoring rewards a title that several seeds surfaced, which is right, but it
 * means one much-loved film can put its entire cluster of lookalikes at the top
 * and the row reads as a single recommendation repeated. This is a greedy
 * re-rank: still strongest-first, but a candidate is discounted for each item
 * already placed that came from the same seed or leads with the same genre.
 *
 * Penalties saturate rather than growing without bound, so a thin pool degrades
 * back to plain score order instead of a row that empties out. Nothing is ever
 * dropped; only the order changes.
 */

/** Only the head of a row is ever seen, so only the head is worth re-ranking. */
const WINDOW = 120;

const SEED_PENALTY = 2;
const SEED_PENALTY_CAP = 3;
const GENRE_PENALTY = 0.5;
const GENRE_PENALTY_CAP = 4;

function penalty(
  candidate: Candidate,
  seedUse: Map<number, number>,
  genreUse: Map<number, number>,
) {
  let seedRepeats = 0;
  for (const seed of candidate.fromSeeds)
    seedRepeats = Math.max(seedRepeats, seedUse.get(seed) ?? 0);

  const primaryGenre = candidate.genreIds?.[0];
  const genreRepeats = primaryGenre === undefined ? 0 : (genreUse.get(primaryGenre) ?? 0);

  return (
    SEED_PENALTY * Math.min(seedRepeats, SEED_PENALTY_CAP) +
    GENRE_PENALTY * Math.min(genreRepeats, GENRE_PENALTY_CAP)
  );
}

/**
 * Spread a score-ordered row across seeds and genres. Input must already be in
 * the order you want as the starting point; the tail beyond the re-rank window
 * is left exactly as given.
 */
export function diversify(candidates: Candidate[]): Candidate[] {
  if (candidates.length < 3) return candidates;

  const pool = candidates.slice(0, WINDOW);
  const tail = candidates.slice(WINDOW);
  const seedUse = new Map<number, number>();
  const genreUse = new Map<number, number>();
  const picked: Candidate[] = [];

  while (pool.length > 0) {
    let bestAt = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      const adjusted = c.score - penalty(c, seedUse, genreUse);
      // Ties fall to the earlier entry, which is already the higher raw score.
      if (adjusted > bestScore) {
        bestScore = adjusted;
        bestAt = i;
      }
    }

    const chosen = pool.splice(bestAt, 1)[0]!;
    picked.push(chosen);
    for (const seed of chosen.fromSeeds) seedUse.set(seed, (seedUse.get(seed) ?? 0) + 1);
    const primaryGenre = chosen.genreIds?.[0];
    if (primaryGenre !== undefined) {
      genreUse.set(primaryGenre, (genreUse.get(primaryGenre) ?? 0) + 1);
    }
  }

  return [...picked, ...tail];
}
